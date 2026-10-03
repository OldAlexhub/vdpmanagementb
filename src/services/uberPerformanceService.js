import crypto from 'node:crypto';
import PerformanceImport from '../models/PerformanceImport.js';
import VdpCycle from '../models/VdpCycle.js';
import Provider from '../models/Provider.js';
import Vdp from '../models/Vdp.js';
import { parseUberPerformanceFile, UberFileValidationError } from './uberPerformanceParser.js';
import { activeOperators } from './operators.js';
import { isoDate } from './cycleService.js';
import { actor, badRequest, conflict, notFound } from './errors.js';
import { suggestOperator } from './uberDriverMatching.js';

export const activeUberImportsFor = (cycleId) => PerformanceImport.find({
  cycleId,
  kind: 'UBER',
  status: 'ACTIVE',
  validationStatus: 'VALID',
}).sort({ uploadedAt: 1 });

const importSummary = (doc) => ({
  _id: doc._id,
  fileName: doc.originalFileName,
  fileSize: doc.fileSize,
  uploadedAt: doc.uploadedAt,
  uploadedBy: doc.uploadedBy,
  rowCount: doc.rowCount || 0,
  weeksDetected: doc.weeksDetected || [],
  driversDetected: doc.driversDetected || 0,
  validationStatus: doc.validationStatus,
  status: doc.status,
  processingErrors: doc.processingErrors || [],
  warnings: doc.warnings || [],
  detectedColumns: doc.detectedColumns || [],
});

async function markCycleStale(cycleId) {
  await Vdp.updateMany({ cycleId, status: { $in: ['DRAFT', 'NEEDS_REVIEW', 'READY'] } }, { $set: { stale: true } });
}

function invalidDetails(error) {
  if (error instanceof UberFileValidationError) return error.details || {};
  return { code: 'UNREADABLE_FILE' };
}

const operatorKey = (providerId, operatorId) => `${String(providerId)}|${String(operatorId)}`;

function operatorCandidates(providers, cycle) {
  return providers.filter((provider) => provider.status === 'ACTIVE').flatMap((provider) => activeOperators(provider, cycle).map((operator) => ({
    providerId: provider._id,
    providerName: provider.name,
    operatorId: operator.id,
    operatorName: operator.name,
  })));
}

function sourceDrivers(rows) {
  const drivers = new Map();
  for (const row of rows) {
    const key = row.driverUuid.toLowerCase();
    if (!drivers.has(key)) drivers.set(key, {
      driverUuid: row.driverUuid,
      sourceName: [row.sourceFirstName, row.sourceLastName].filter(Boolean).join(' '),
    });
  }
  return [...drivers.values()];
}

function automaticNameMatches(rows, candidates, reservedOperators = new Map()) {
  const matches = [];
  for (const driver of sourceDrivers(rows)) {
    const normalizedUuid = driver.driverUuid.toLowerCase();
    const available = candidates.filter((candidate) => {
      const owner = reservedOperators.get(operatorKey(candidate.providerId, candidate.operatorId));
      return !owner || owner === normalizedUuid;
    });
    const { suggestion } = suggestOperator(driver.sourceName, available);
    // Only a unique exact/token-exact name is accepted automatically. Fuzzy
    // suggestions remain pending for a human to confirm in VDP Processing.
    if (!suggestion || suggestion.confidence < 0.99) continue;
    reservedOperators.set(operatorKey(suggestion.providerId, suggestion.operatorId), normalizedUuid);
    matches.push({
      driverUuid: normalizedUuid,
      providerId: suggestion.providerId,
      operatorId: suggestion.operatorId,
      method: 'AUTO_EXACT_NAME',
      confidence: String(suggestion.confidence),
      matchedAt: new Date(),
    });
  }
  return matches;
}

export async function uploadUberFiles({ cycleId, files, user }) {
  if (!files?.length) throw badRequest('Choose at least one Uber .xlsx, .xls, or .csv file.');
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const [existing, providers] = await Promise.all([
    activeUberImportsFor(cycle._id),
    Provider.find({ divisionId: cycle.divisionId }),
  ]);
  const existingHashes = new Set(existing.map((doc) => doc.fileHash));
  const candidates = operatorCandidates(providers, cycle);
  const reservedOperators = new Map(existing.flatMap((doc) => (doc.uberDriverMatches || [])
    .map((match) => [operatorKey(match.providerId, match.operatorId), match.driverUuid.toLowerCase()])));
  const existingKeys = new Map();
  for (const doc of existing) {
    for (const row of doc.uberRows) existingKeys.set(`${row.driverUuid.toLowerCase()}|${row.week}`, doc.originalFileName);
  }

  const results = [];
  for (const file of files) {
    const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    let parsed = null;
    let errors = [];
    let details = {};
    if (existingHashes.has(fileHash)) {
      errors = ['This exact file is already active for the selected VDP cycle.'];
      details = { code: 'DUPLICATE_UPLOAD' };
    } else {
      try {
        parsed = await parseUberPerformanceFile(file.buffer, file.originalname);
        const outside = parsed.weeksDetected.filter((week) => week < isoDate(cycle.cycleStart) || week > isoDate(cycle.cycleEnd));
        if (outside.length) errors.push(`Week${outside.length === 1 ? '' : 's'} outside this VDP cycle: ${outside.join(', ')}.`);
        const overlaps = parsed.rows
          .map((row) => ({ key: `${row.driverUuid.toLowerCase()}|${row.week}`, row }))
          .filter(({ key }) => existingKeys.has(key));
        if (overlaps.length) {
          const samples = overlaps.slice(0, 5).map(({ row, key }) => `${row.driverUuid} / ${row.week} (${existingKeys.get(key)})`);
          errors.push(`Driver-week data is already active: ${samples.join(', ')}${overlaps.length > samples.length ? ` and ${overlaps.length - samples.length} more` : ''}. Remove the older upload before loading a correction.`);
        }
      } catch (error) {
        details = invalidDetails(error);
        errors = details.errors?.length ? details.errors : [error.message];
      }
    }

    const valid = Boolean(parsed) && errors.length === 0;
    const doc = new PerformanceImport({
      divisionId: cycle.divisionId,
      cycleId: cycle._id,
      kind: 'UBER',
      originalFileName: file.originalname,
      fileHash,
      fileSize: file.size ?? file.buffer.length,
      uploadedBy: actor(user),
      rowCount: valid ? parsed.rowCount : 0,
      status: valid ? 'ACTIVE' : 'INVALID',
      validationStatus: valid ? 'VALID' : 'INVALID',
      processingErrors: errors,
      warnings: parsed?.warnings || [],
      detectedColumns: parsed?.detectedColumns || details.detectedColumns || [],
      stats: { sheetName: parsed?.sheetName || details.sheetName || null, validationCode: details.code || null },
      uberRows: valid ? parsed.rows : [],
      uberDriverMatches: valid ? automaticNameMatches(parsed.rows, candidates, reservedOperators) : [],
      weeksDetected: parsed?.weeksDetected || [],
      driversDetected: parsed?.driversDetected || 0,
    });
    await doc.save();
    results.push(importSummary(doc));
    if (valid) {
      existingHashes.add(fileHash);
      for (const row of parsed.rows) existingKeys.set(`${row.driverUuid.toLowerCase()}|${row.week}`, file.originalname);
    }
  }

  if (results.some((result) => result.validationStatus === 'VALID')) {
    await markCycleStale(cycle._id);
    if (['UPCOMING', 'OPEN'].includes(cycle.status)) {
      cycle.status = 'PROCESSING';
      await cycle.save();
    }
  }
  return results;
}

export async function listUberImports({ cycleId, divisionId, includeInvalid = true } = {}) {
  const filter = { kind: 'UBER' };
  if (cycleId) filter.cycleId = cycleId;
  if (divisionId) filter.divisionId = divisionId;
  if (!includeInvalid) Object.assign(filter, { status: 'ACTIVE', validationStatus: 'VALID' });
  return (await PerformanceImport.find(filter).sort({ uploadedAt: -1 })).map(importSummary);
}

export async function removeUberImport(id, user) {
  const doc = await PerformanceImport.findOne({ _id: id, kind: 'UBER' });
  if (!doc) throw notFound('Uber data upload');
  // Failed attempts never contributed rows or matches, so removing one should
  // actually clear the clutter and allow the corrected file to be uploaded.
  if (doc.validationStatus === 'INVALID' || doc.status === 'INVALID') {
    const removed = importSummary(doc);
    await doc.deleteOne();
    return { ...removed, status: 'DELETED', deleted: true };
  }
  if (doc.status !== 'ACTIVE') throw conflict('This Uber upload is not active.');
  doc.status = 'REPLACED';
  doc.replacedAt = new Date();
  doc.replacedBy = actor(user);
  doc.replaceReason = 'Removed from the active Uber data set';
  await doc.save();
  await markCycleStale(doc.cycleId);
  return importSummary(doc);
}

export async function clearInvalidUberImports({ cycleId }) {
  if (!cycleId) throw badRequest('Choose a VDP cycle.');
  const result = await PerformanceImport.deleteMany({
    cycleId,
    kind: 'UBER',
    validationStatus: 'INVALID',
  });
  return { deletedCount: result.deletedCount || 0 };
}

export async function uberRowsForCycle(cycleId) {
  const imports = await activeUberImportsFor(cycleId);
  return imports.flatMap((doc) => {
    const matches = new Map((doc.uberDriverMatches || []).map((match) => [match.driverUuid.toLowerCase(), match]));
    return doc.uberRows.map((row) => {
      const match = matches.get(row.driverUuid.toLowerCase());
      return {
        ...row.toObject({ getters: true }),
        providerId: match?.providerId ? String(match.providerId) : null,
        operatorId: match?.operatorId || null,
        matchMethod: match?.method || null,
        sourceImportId: String(doc._id),
        sourceFileName: doc.originalFileName,
      };
    });
  });
}

export function matchUberDrivers(imports, providers, cycle = null) {
  const source = new Map();
  for (const doc of imports) {
    for (const row of doc.uberRows) {
      const key = row.driverUuid.toLowerCase();
      if (!source.has(key)) source.set(key, {
        driverUuid: row.driverUuid,
        sourceFirstName: row.sourceFirstName || '',
        sourceLastName: row.sourceLastName || '',
        weeks: new Set(),
        files: new Set(),
        imports: new Set(),
        resolutions: [],
      });
      source.get(key).weeks.add(row.week);
      source.get(key).files.add(doc.originalFileName);
      source.get(key).imports.add(String(doc._id));
    }
    for (const match of doc.uberDriverMatches || []) {
      const driver = source.get(match.driverUuid.toLowerCase());
      if (driver) driver.resolutions.push({
        importId: String(doc._id),
        providerId: match.providerId,
        operatorId: match.operatorId,
        method: match.method,
      });
    }
  }
  const candidates = operatorCandidates(providers, cycle);
  const candidatesByKey = new Map(candidates.map((candidate) => [operatorKey(candidate.providerId, candidate.operatorId), candidate]));
  const reserved = new Map();
  for (const driver of source.values()) {
    for (const resolution of driver.resolutions) {
      const key = operatorKey(resolution.providerId, resolution.operatorId);
      if (candidatesByKey.has(key) && !reserved.has(key)) reserved.set(key, driver.driverUuid.toLowerCase());
    }
  }
  return [...source.values()].map((driver) => {
    const validResolutions = driver.resolutions.filter((resolution) => candidatesByKey.has(operatorKey(resolution.providerId, resolution.operatorId)));
    const resolved = [...new Map(validResolutions.map((resolution) => {
      const key = operatorKey(resolution.providerId, resolution.operatorId);
      return [key, { ...candidatesByKey.get(key), matchMethod: resolution.method }];
    })).values()];
    const resolutionCoverage = new Set(validResolutions.map((resolution) => resolution.importId)).size === driver.imports.size;
    const sourceName = [driver.sourceFirstName, driver.sourceLastName].filter(Boolean).join(' ');
    const available = candidates.filter((candidate) => {
      const owner = reserved.get(operatorKey(candidate.providerId, candidate.operatorId));
      return !owner || owner === driver.driverUuid.toLowerCase();
    });
    const smart = resolved.length === 1 && resolutionCoverage
      ? { suggestion: null, candidates: [] }
      : suggestOperator(sourceName, available);
    const matched = resolved.length === 1 && resolutionCoverage;
    return {
      driverUuid: driver.driverUuid,
      sourceFirstName: driver.sourceFirstName,
      sourceLastName: driver.sourceLastName,
      sourceName,
      weeks: [...driver.weeks].sort(),
      files: [...driver.files],
      status: matched ? 'MATCHED' : resolved.length > 1 ? 'AMBIGUOUS' : smart.suggestion ? 'SUGGESTED' : 'UNMATCHED',
      ...(matched ? resolved[0] : {}),
      ...(resolved.length > 1 ? { candidates: resolved } : {}),
      ...(smart.suggestion ? {
        suggestedProviderId: smart.suggestion.providerId,
        suggestedProviderName: smart.suggestion.providerName,
        suggestedOperatorId: smart.suggestion.operatorId,
        suggestedOperatorName: smart.suggestion.operatorName,
        suggestionConfidence: smart.suggestion.confidence,
        suggestionReason: smart.suggestion.reason,
      } : {}),
      ...(!resolved.length && !smart.suggestion && smart.candidates.length ? { candidates: smart.candidates } : {}),
    };
  }).sort((a, b) => a.driverUuid.localeCompare(b.driverUuid));
}

export async function assignUberDriver({ cycleId, driverUuid, providerId, operatorId }, user) {
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const imports = await activeUberImportsFor(cycle._id);
  const normalized = String(driverUuid || '').trim().toLowerCase();
  if (!imports.some((doc) => doc.uberRows.some((row) => row.driverUuid.toLowerCase() === normalized))) {
    throw badRequest('This driver UUID is not in the active Uber uploads.');
  }
  const provider = await Provider.findOne({ _id: providerId, divisionId: cycle.divisionId });
  if (!provider) throw badRequest('Choose a provider in this division.');
  const operator = activeOperators(provider, cycle).find((item) => item.id === String(operatorId));
  if (!operator) throw badRequest('Choose a valid active operator.');
  const targetKey = operatorKey(provider._id, operator.id);
  const alreadyUsed = imports.flatMap((doc) => doc.uberDriverMatches || []).find((match) => (
    operatorKey(match.providerId, match.operatorId) === targetKey && match.driverUuid.toLowerCase() !== normalized
  ));
  if (alreadyUsed) {
    throw badRequest(`${operator.name} is already matched to another uploaded Uber driver for this cycle.`);
  }
  for (const doc of imports.filter((item) => item.uberRows.some((row) => row.driverUuid.toLowerCase() === normalized))) {
    doc.uberDriverMatches = (doc.uberDriverMatches || []).filter((match) => match.driverUuid.toLowerCase() !== normalized);
    doc.uberDriverMatches.push({
      driverUuid: normalized,
      providerId: provider._id,
      operatorId: operator.id,
      method: 'MANUAL',
      confidence: null,
      matchedBy: actor(user),
      matchedAt: new Date(),
    });
    await doc.save();
  }
  await markCycleStale(cycle._id);
  return provider;
}
