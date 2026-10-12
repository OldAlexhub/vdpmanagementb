import crypto from 'node:crypto';
import fs from 'node:fs';
import PerformanceImport from '../models/PerformanceImport.js';
import VdpCycle from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import Vdp from '../models/Vdp.js';
import { activeOperators } from './operators.js';
import { isoDate, weekOf } from './cycleService.js';
import { actor, badRequest, conflict, notFound } from './errors.js';
import { inferCycleFromDates } from './cycleInference.js';
import { suggestOperator } from './uberDriverMatching.js';
import {
  DIV3_IMPORT_KINDS,
  Division3FileValidationError,
  parseDivision3DutyFile,
  parseDivision3FareFile,
  parseDivision3ReturnedFareFile,
  reconcileDivision3Fares,
  division3DriverKey,
} from './division3Parser.js';
import { divisionNumberKey, isDivision3Division, processingDivisionsFor } from './divisionGroups.js';

const LABELS = {
  DIV3_ADA: 'ADA raw data',
  DIV3_GOLINK: 'GoLink raw data',
  DIV3_ADA_FARE: 'ADA fare data',
  DIV3_RETURNED_FARE: 'returned fare reconciliation',
};

const isDivision3Kind = (kind) => DIV3_IMPORT_KINDS.includes(kind);

export const activeDivision3ImportsFor = (cycleId, kind = null) => PerformanceImport.find({
  cycleId,
  kind: kind || { $in: DIV3_IMPORT_KINDS },
  status: 'ACTIVE',
  validationStatus: 'VALID',
}).sort({ uploadedAt: 1 });

const importSummary = (doc) => ({
  _id: doc._id,
  divisionId: doc.divisionId,
  cycleId: doc.cycleId,
  kind: doc.kind,
  label: LABELS[doc.kind],
  fileName: doc.originalFileName,
  fileSize: doc.fileSize,
  uploadedAt: doc.uploadedAt,
  uploadedBy: doc.uploadedBy,
  rowCount: doc.rowCount || 0,
  sourceRowCount: Number(doc.stats?.sourceRowCount || 0),
  excludedRowCount: Number(doc.stats?.excludedRowCount || 0),
  datesDetected: doc.datesDetected || [],
  weeksDetected: doc.weeksDetected || [],
  driversDetected: doc.driversDetected || 0,
  schemaComplete: doc.stats?.schemaComplete ?? null,
  fareRate: doc.stats?.fareRate || null,
  validationStatus: doc.validationStatus,
  status: doc.status,
  processingErrors: doc.processingErrors || [],
  warnings: doc.warnings || [],
  detectedColumns: doc.detectedColumns || [],
});

async function parse(kind, buffer, fileName) {
  if (kind === 'DIV3_ADA') return parseDivision3DutyFile(buffer, fileName, 'ADA');
  if (kind === 'DIV3_GOLINK') return parseDivision3DutyFile(buffer, fileName, 'GOLINK');
  if (kind === 'DIV3_ADA_FARE') return parseDivision3FareFile(buffer, fileName);
  if (kind === 'DIV3_RETURNED_FARE') return parseDivision3ReturnedFareFile(buffer, fileName);
  throw badRequest('Choose a valid Division 3 dataset type.');
}

const uploadSource = (file) => file.path || file.buffer;

async function uploadHash(file) {
  if (file.buffer) return crypto.createHash('sha256').update(file.buffer).digest('hex');
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file.path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function requireDivision3(divisionId) {
  const division = await Division.findById(divisionId);
  if (!division) throw notFound('Division');
  if (!isDivision3Division(division)) throw badRequest('Division 3 datasets can only be loaded for DIV 3 ADA or DIV 3GL GoLink.');
  return division;
}

async function markCycleStale(cycleId) {
  await Vdp.updateMany({ cycleId, status: { $in: ['DRAFT', 'NEEDS_REVIEW', 'READY'] } }, {
    $set: { stale: true }, $addToSet: { staleReasons: 'A Division 3 source or match resolution changed.' },
  });
}

const operatorKey = (providerId, operatorId) => `${String(providerId)}|${String(operatorId)}`;

function candidatesFor(providers, cycle, processingDivisions = []) {
  const divisionNumbers = new Map(processingDivisions.map((division) => [String(division._id), divisionNumberKey(division.divisionNumber)]));
  return providers.filter((provider) => provider.status === 'ACTIVE').flatMap((provider) => activeOperators(provider, cycle).map((operator) => ({
    providerId: provider._id,
    providerName: provider.name,
    divisionId: provider.divisionId,
    divisionNumber: divisionNumbers.get(String(provider.divisionId)) || divisionNumberKey(provider.divisionNumber),
    operatorId: operator.id,
    operatorName: operator.name,
  })));
}

const serviceForKind = (kind) => (kind === 'DIV3_GOLINK' ? 'GOLINK' : 'ADA');
const sourceMatchKey = (sourceName, service) => `${division3DriverKey(sourceName)}|${service}`;
const serviceForStoredMatch = (doc, match) => match.service || serviceForKind(doc.kind);

function candidatesForServices(candidates, services = []) {
  const targetDivisions = new Set([...services].map((service) => (service === 'GOLINK' ? '3GL' : '3')));
  if (!targetDivisions.size) return candidates;
  const scoped = candidates.filter((candidate) => targetDivisions.has(candidate.divisionNumber));
  // Keep legacy/non-grouped test data working when no division metadata was
  // supplied, but never mix ADA and GoLink rosters when the group is known.
  return candidates.some((candidate) => candidate.divisionNumber) ? scoped : candidates;
}

const namesIn = (parsed, kind) => {
  if (kind === 'DIV3_RETURNED_FARE') return parsed.rows.map((row) => row.driverName);
  return parsed.rows.map((row) => row.driverName);
};

function automaticMatches(parsed, kind, candidates, reserved) {
  const matches = [];
  const service = serviceForKind(kind);
  for (const sourceName of [...new Set(namesIn(parsed, kind).filter(Boolean))]) {
    const normalized = division3DriverKey(sourceName);
    const matchKey = sourceMatchKey(sourceName, service);
    const serviceCandidates = candidatesForServices(candidates, [service]);
    const available = serviceCandidates.filter((candidate) => {
      const owner = reserved.get(operatorKey(candidate.providerId, candidate.operatorId));
      return !owner || owner === matchKey;
    });
    const { suggestion } = suggestOperator(normalized, available);
    if (!suggestion) continue;
    reserved.set(operatorKey(suggestion.providerId, suggestion.operatorId), matchKey);
    matches.push({
      sourceName,
      service,
      providerId: suggestion.providerId,
      operatorId: suggestion.operatorId,
      method: suggestion.confidence >= 0.99 ? 'AUTO_EXACT_NAME' : 'AUTO_SMART_NAME',
      confidence: String(suggestion.confidence),
      matchedAt: new Date(),
    });
  }
  return matches;
}

function rowKeys(docOrParsed, kind) {
  if (kind === 'DIV3_ADA' || kind === 'DIV3_GOLINK') {
    const rows = docOrParsed.division3DutyRows || docOrParsed.rows || [];
    return rows.map((row) => `${division3DriverKey(row.driverName)}|${row.date}`);
  }
  if (kind === 'DIV3_ADA_FARE') {
    const rows = docOrParsed.division3FareRows || docOrParsed.rows || [];
    return rows.map((row) => `${division3DriverKey(row.driverName)}|${row.date}`);
  }
  return [];
}

export async function uploadDivision3Files({ cycleId, divisionId, kind, files, user }) {
  if (!isDivision3Kind(kind)) throw badRequest('Choose ADA, GoLink, ADA fare, or returned-fare data.');
  if (!files?.length) throw badRequest(`Choose at least one ${LABELS[kind]} file.`);
  let cycle = cycleId ? await VdpCycle.findById(cycleId) : null;
  if (cycleId && !cycle) throw notFound('VDP cycle');
  const preparsed = new Map();
  if (!cycle) {
    await requireDivision3(divisionId);
    for (const file of files) {
      try {
        preparsed.set(file, await parse(kind, uploadSource(file), file.originalname));
      } catch (error) {
        throw badRequest(`The pay period could not be identified from ${file.originalname}: ${error.message}`);
      }
    }
    cycle = await inferCycleFromDates({
      divisionId,
      dates: [...preparsed.values()].flatMap((result) => result.datesDetected),
      label: `DIV 3 ${LABELS[kind]}`,
    });
  }
  const division = await requireDivision3(cycle.divisionId);
  const processingDivisions = await processingDivisionsFor(division);
  const [existing, providers] = await Promise.all([
    activeDivision3ImportsFor(cycle._id, kind),
    Provider.find({ divisionId: { $in: processingDivisions.map((item) => item._id) } }),
  ]);
  const allActive = await activeDivision3ImportsFor(cycle._id);
  const hashes = new Set(existing.map((doc) => doc.fileHash));
  const keys = new Map(existing.flatMap((doc) => rowKeys(doc, kind).map((key) => [key, doc.originalFileName])));
  const candidates = candidatesFor(providers, cycle, processingDivisions);
  const reserved = new Map(allActive.flatMap((doc) => (doc.division3DriverMatches || []).map((match) => [
    operatorKey(match.providerId, match.operatorId), sourceMatchKey(match.sourceName, serviceForStoredMatch(doc, match)),
  ])));
  const results = [];

  for (const file of files) {
    const fileHash = await uploadHash(file);
    let parsed = null;
    let errors = [];
    let details = {};
    if (hashes.has(fileHash)) {
      errors = ['This exact file is already active for the selected VDP cycle.'];
      details = { code: 'DUPLICATE_UPLOAD' };
    } else {
      try {
        parsed = preparsed.get(file) || await parse(kind, uploadSource(file), file.originalname);
        const from = isoDate(cycle.cycleStart);
        const to = isoDate(cycle.cycleEnd);
        const outside = parsed.datesDetected.filter((date) => date < from || date > to);
        if (outside.length) errors.push(`Source date${outside.length === 1 ? '' : 's'} outside this VDP period: ${outside.join(', ')}.`);
        if (!['DIV3_RETURNED_FARE', 'DIV3_ADA_FARE'].includes(kind)) {
          const overlaps = rowKeys(parsed, kind).filter((key) => keys.has(key));
          if (overlaps.length) errors.push(`${overlaps.length} driver/day row(s) are already active in ${keys.get(overlaps[0])}. Remove the older upload before loading a correction.`);
        }
      } catch (error) {
        details = error instanceof Division3FileValidationError ? error.details || {} : { code: 'UNREADABLE_FILE' };
        errors = details.errors?.length ? details.errors : [error.message];
      }
    }

    const valid = Boolean(parsed) && errors.length === 0;
    // Every DIV 3 file represents one operational week. A late-night trip can
    // land just after midnight in the next calendar week, so readiness uses
    // the dominant week in the file rather than treating that spillover as a
    // separately loaded weekly source.
    const weekCounts = new Map();
    if (valid) {
      for (const row of parsed.rows) {
        const number = weekOf(row.date, cycle);
        if (!number) continue;
        const weight = Number(row.tripCount || row.dutyCount || 1);
        weekCounts.set(number, (weekCounts.get(number) || 0) + weight);
      }
    }
    const dominantWeek = [...weekCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const weeksDetected = dominantWeek ? [dominantWeek === 1 ? isoDate(cycle.week1Start) : isoDate(cycle.week2Start)] : [];
    const doc = new PerformanceImport({
      divisionId: cycle.divisionId,
      cycleId: cycle._id,
      kind,
      originalFileName: file.originalname,
      fileHash,
      fileSize: file.size ?? file.buffer?.length,
      uploadedBy: actor(user),
      rowCount: valid ? parsed.rowCount : 0,
      status: valid ? 'ACTIVE' : 'INVALID',
      validationStatus: valid ? 'VALID' : 'INVALID',
      processingErrors: errors,
      detectedColumns: parsed?.detectedColumns || details.detectedColumns || [],
      stats: {
        validationCode: details.code || null,
        sourceRowCount: parsed?.sourceRowCount || 0,
        excludedRowCount: parsed?.excludedRowCount || 0,
        schemaComplete: parsed?.schemaComplete ?? null,
        fareRate: parsed?.fareRate || null,
      },
      warnings: parsed?.warnings || [],
      division3DutyRows: valid && ['DIV3_ADA', 'DIV3_GOLINK'].includes(kind) ? parsed.rows : [],
      division3FareRows: valid && kind === 'DIV3_ADA_FARE' ? parsed.rows : [],
      division3ReturnedFareRows: valid && kind === 'DIV3_RETURNED_FARE' ? parsed.rows : [],
      division3DriverMatches: valid ? automaticMatches(parsed, kind, candidates, reserved) : [],
      datesDetected: parsed?.datesDetected || [],
      weeksDetected,
      driversDetected: parsed?.driversDetected || 0,
    });
    await doc.save();
    results.push(importSummary(doc));
    if (valid) {
      hashes.add(fileHash);
      for (const key of rowKeys(parsed, kind)) keys.set(key, file.originalname);
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

export async function listDivision3Imports({ cycleId, divisionId, kind } = {}) {
  const filter = { kind: kind && isDivision3Kind(kind) ? kind : { $in: DIV3_IMPORT_KINDS } };
  if (cycleId) filter.cycleId = cycleId;
  if (divisionId) filter.divisionId = divisionId;
  return (await PerformanceImport.find(filter).sort({ uploadedAt: -1 })).map(importSummary);
}

export async function removeDivision3Import(id, user) {
  const doc = await PerformanceImport.findOne({ _id: id, kind: { $in: DIV3_IMPORT_KINDS } });
  if (!doc) throw notFound('Division 3 upload');
  if (doc.validationStatus === 'INVALID' || doc.status === 'INVALID') {
    const removed = importSummary(doc);
    await doc.deleteOne();
    return { ...removed, status: 'DELETED', deleted: true };
  }
  if (doc.status !== 'ACTIVE') throw conflict('This Division 3 upload is not active.');
  doc.status = 'REPLACED';
  doc.replacedAt = new Date();
  doc.replacedBy = actor(user);
  doc.replaceReason = 'Removed from the active Division 3 data set';
  await doc.save();
  await markCycleStale(doc.cycleId);
  return importSummary(doc);
}

export async function clearInvalidDivision3Imports({ cycleId, kind }) {
  if (!cycleId) throw badRequest('Choose a VDP cycle.');
  const filter = { cycleId, kind: kind && isDivision3Kind(kind) ? kind : { $in: DIV3_IMPORT_KINDS }, validationStatus: 'INVALID' };
  const result = await PerformanceImport.deleteMany(filter);
  return { deletedCount: result.deletedCount || 0 };
}

function sourceNames(imports) {
  const names = new Map();
  for (const doc of imports) {
    const rows = [...(doc.division3DutyRows || []), ...(doc.division3FareRows || [])];
    for (const row of rows) {
      const service = row.service || (doc.kind === 'DIV3_ADA_FARE' ? 'ADA' : serviceForKind(doc.kind));
      const key = sourceMatchKey(row.driverName, service);
      if (!names.has(key)) names.set(key, { sourceName: row.driverName, service, dates: new Set(), files: new Set() });
      const item = names.get(key);
      item.dates.add(row.date);
      item.files.add(doc.originalFileName);
    }
  }
  return names;
}

export function matchDivision3Drivers(imports, providers, cycle = null, processingDivisions = []) {
  const candidates = candidatesFor(providers, cycle, processingDivisions);
  const names = sourceNames(imports);
  const resolved = new Map();
  const excluded = new Map();
  for (const doc of imports) {
    for (const exclusion of doc.division3DriverExclusions || []) {
      const key = sourceMatchKey(exclusion.sourceName, exclusion.service);
      excluded.set(key, {
        setAsideReason: exclusion.reason,
        setAsideBy: exclusion.excludedBy,
        setAsideAt: exclusion.excludedAt,
      });
    }
    for (const match of doc.division3DriverMatches || []) {
      const service = serviceForStoredMatch(doc, match);
      const key = sourceMatchKey(match.sourceName, service);
      const candidate = candidates.find((item) => String(item.providerId) === String(match.providerId) && item.operatorId === match.operatorId);
      if (!candidate) continue;
      const list = resolved.get(key) || [];
      if (!list.some((item) => operatorKey(item.providerId, item.operatorId) === operatorKey(candidate.providerId, candidate.operatorId))) {
        list.push({ ...candidate, matchMethod: match.method, confidence: match.confidence == null ? null : Number(match.confidence) });
      }
      resolved.set(key, list);
    }
  }
  const reserved = new Map([...resolved.entries()].flatMap(([sourceKey, matches]) => matches.map((match) => [
    operatorKey(match.providerId, match.operatorId), sourceKey,
  ])));
  return [...names.entries()].map(([key, source]) => {
    const matches = resolved.get(key) || [];
    const exclusion = excluded.get(key) || null;
    const serviceCandidates = candidatesForServices(candidates, [source.service]);
    const available = serviceCandidates.filter((candidate) => {
      const owner = reserved.get(operatorKey(candidate.providerId, candidate.operatorId));
      return !owner || owner === key;
    });
    const smart = matches.length || exclusion ? { suggestion: null, candidates: [] } : suggestOperator(division3DriverKey(source.sourceName), available);
    const automatic = matches.length || exclusion ? null : smart.suggestion;
    if (automatic) reserved.set(operatorKey(automatic.providerId, automatic.operatorId), key);
    const effectiveMatches = exclusion ? [] : automatic ? [{
      ...automatic,
      matchMethod: automatic.confidence >= 0.99 ? 'AUTO_EXACT_NAME' : 'AUTO_SMART_NAME',
    }] : matches;
    return {
      sourceKey: key,
      sourceName: source.sourceName,
      service: source.service,
      services: [source.service],
      dates: [...source.dates].sort(),
      files: [...source.files],
      status: exclusion ? 'SET_ASIDE' : effectiveMatches.length === 1 ? 'MATCHED' : effectiveMatches.length > 1 ? 'AMBIGUOUS' : 'UNMATCHED',
      ...(exclusion || {}),
      ...(effectiveMatches.length === 1 ? effectiveMatches[0] : {}),
      ...(effectiveMatches.length > 1 ? { candidates: effectiveMatches } : {}),
    };
  }).sort((a, b) => a.sourceName.localeCompare(b.sourceName));
}

function resolveSourceService(imports, sourceName, requestedService) {
  const sources = sourceNames(imports);
  const sourceKey = division3DriverKey(sourceName);
  const sourceServices = [...sources.values()].filter((item) => division3DriverKey(item.sourceName) === sourceKey).map((item) => item.service);
  const service = String(requestedService || '').trim().toUpperCase() || (sourceServices.length === 1 ? sourceServices[0] : null);
  if (!['ADA', 'GOLINK'].includes(service)) throw badRequest('Choose whether this driver is for ADA or GoLink.');
  const key = sourceMatchKey(sourceName, service);
  if (!sources.has(key)) throw badRequest(`This driver is not in the active Division 3 ${service === 'GOLINK' ? 'GoLink' : 'ADA'} uploads.`);
  return { key, service };
}

function docHasSource(doc, key) {
  return [...(doc.division3DutyRows || []), ...(doc.division3FareRows || [])].some((row) => {
    const rowService = row.service || (doc.kind === 'DIV3_ADA_FARE' ? 'ADA' : serviceForKind(doc.kind));
    return sourceMatchKey(row.driverName, rowService) === key;
  });
}

export async function assignDivision3Driver({ cycleId, sourceName, service: requestedService, providerId, operatorId }, user) {
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const imports = await activeDivision3ImportsFor(cycle._id);
  const { key, service } = resolveSourceService(imports, sourceName, requestedService);
  const divisions = await processingDivisionsFor(await requireDivision3(cycle.divisionId));
  const targetNumber = service === 'GOLINK' ? '3GL' : '3';
  const targetDivisionIds = divisions.filter((item) => divisionNumberKey(item.divisionNumber) === targetNumber).map((item) => item._id);
  const provider = await Provider.findOne({ _id: providerId, divisionId: { $in: targetDivisionIds } });
  if (!provider) throw badRequest(`Choose a provider in the ${service === 'GOLINK' ? 'DIV 3GL GoLink' : 'DIV 3 ADA'} division.`);
  const operator = activeOperators(provider, cycle).find((item) => item.id === String(operatorId));
  if (!operator) throw badRequest('Choose a valid active operator.');
  const used = imports.flatMap((doc) => (doc.division3DriverMatches || []).map((match) => ({ doc, match }))).find(({ doc, match }) => (
    operatorKey(match.providerId, match.operatorId) === operatorKey(provider._id, operator.id)
      && sourceMatchKey(match.sourceName, serviceForStoredMatch(doc, match)) !== key
  ));
  if (used) {
    const usedService = serviceForStoredMatch(used.doc, used.match);
    throw badRequest(`${operator.name} is already matched to ${used.match.sourceName} (${usedService}). Clear that match or set that source aside first.`);
  }
  for (const doc of imports) {
    const exclusions = (doc.division3DriverExclusions || []).filter((exclusion) => sourceMatchKey(exclusion.sourceName, exclusion.service) !== key);
    const exclusionRemoved = exclusions.length !== (doc.division3DriverExclusions || []).length;
    doc.division3DriverExclusions = exclusions;
    const hasName = docHasSource(doc, key);
    if (!hasName) {
      if (exclusionRemoved) await doc.save();
      continue;
    }
    doc.division3DriverMatches = (doc.division3DriverMatches || []).filter((match) => sourceMatchKey(match.sourceName, serviceForStoredMatch(doc, match)) !== key);
    doc.division3DriverMatches.push({ sourceName, service, providerId: provider._id, operatorId: operator.id, method: 'MANUAL', confidence: null, matchedBy: actor(user), matchedAt: new Date() });
    await doc.save();
  }
  await markCycleStale(cycle._id);
  return provider;
}

export async function clearDivision3DriverMatch({ cycleId, sourceName, service: requestedService }) {
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const imports = await activeDivision3ImportsFor(cycle._id);
  const { key, service } = resolveSourceService(imports, sourceName, requestedService);
  let cleared = false;
  for (const doc of imports) {
    const matches = (doc.division3DriverMatches || []).filter((match) => sourceMatchKey(match.sourceName, serviceForStoredMatch(doc, match)) !== key);
    if (matches.length === (doc.division3DriverMatches || []).length) continue;
    doc.division3DriverMatches = matches;
    await doc.save();
    cleared = true;
  }
  if (cleared) await markCycleStale(cycle._id);
  return { sourceName, service, cleared };
}

export async function setAsideDivision3Driver({ cycleId, sourceName, service: requestedService, reason }, user) {
  const setAsideReason = String(reason || '').trim();
  if (!setAsideReason) throw badRequest('A reason is required to set a source driver aside.');
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const imports = await activeDivision3ImportsFor(cycle._id);
  const { key, service } = resolveSourceService(imports, sourceName, requestedService);
  for (const doc of imports) {
    if (!docHasSource(doc, key)) continue;
    doc.division3DriverMatches = (doc.division3DriverMatches || []).filter((match) => sourceMatchKey(match.sourceName, serviceForStoredMatch(doc, match)) !== key);
    doc.division3DriverExclusions = (doc.division3DriverExclusions || []).filter((exclusion) => sourceMatchKey(exclusion.sourceName, exclusion.service) !== key);
    doc.division3DriverExclusions.push({ sourceName, service, reason: setAsideReason, excludedBy: actor(user), excludedAt: new Date() });
    await doc.save();
  }
  await markCycleStale(cycle._id);
  return { sourceName, service, reason: setAsideReason, status: 'SET_ASIDE' };
}

export async function restoreDivision3Driver({ cycleId, sourceName, service: requestedService }) {
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const imports = await activeDivision3ImportsFor(cycle._id);
  const { key, service } = resolveSourceService(imports, sourceName, requestedService);
  let restored = false;
  for (const doc of imports) {
    const exclusions = (doc.division3DriverExclusions || []).filter((exclusion) => sourceMatchKey(exclusion.sourceName, exclusion.service) !== key);
    if (exclusions.length === (doc.division3DriverExclusions || []).length) continue;
    doc.division3DriverExclusions = exclusions;
    await doc.save();
    restored = true;
  }
  if (restored) await markCycleStale(cycle._id);
  return { sourceName, service, restored };
}

export function division3Readiness({ cycle, imports, providers = [], processingDivisions = [] }) {
  const expectedWeeks = [isoDate(cycle.week1Start), isoDate(cycle.week2Start)];
  const byKind = Object.fromEntries(DIV3_IMPORT_KINDS.map((kind) => {
    const docs = imports.filter((doc) => doc.kind === kind);
    const loadedWeeks = [...new Set(docs.flatMap((doc) => doc.weeksDetected || []))].sort();
    return [kind, {
      kind,
      label: LABELS[kind],
      required: kind !== 'DIV3_RETURNED_FARE',
      loaded: docs.length > 0,
      ready: kind === 'DIV3_RETURNED_FARE' ? true : expectedWeeks.every((week) => loadedWeeks.includes(week)),
      expectedWeeks,
      loadedWeeks,
      missingWeeks: expectedWeeks.filter((week) => !loadedWeeks.includes(week)),
      files: docs.map(importSummary),
      rowCount: docs.reduce((total, doc) => total + (doc.rowCount || 0), 0),
      sourceRowCount: docs.reduce((total, doc) => total + Number(doc.stats?.sourceRowCount || 0), 0),
    }];
  }));
  const matches = matchDivision3Drivers(imports, providers, cycle, processingDivisions);
  const fareRows = imports.filter((doc) => doc.kind === 'DIV3_ADA_FARE').flatMap((doc) => doc.division3FareRows || []);
  const returnedRows = imports.filter((doc) => doc.kind === 'DIV3_RETURNED_FARE').flatMap((doc) => doc.division3ReturnedFareRows || []);
  const fareReconciliation = reconcileDivision3Fares(fareRows, returnedRows);
  return {
    expectedWeeks,
    sources: byKind,
    requiredReady: ['DIV3_ADA', 'DIV3_GOLINK', 'DIV3_ADA_FARE'].every((kind) => byKind[kind].ready),
    driverMatches: matches,
    unresolvedCount: matches.filter((match) => ['UNMATCHED', 'AMBIGUOUS'].includes(match.status)).length,
    fareReconciliation: {
      ...fareReconciliation.totals,
      rowCount: fareReconciliation.rows.length,
      pendingCount: fareReconciliation.pendingCount,
      mismatchCount: fareReconciliation.mismatchCount,
      reconciledCount: fareReconciliation.reconciledCount,
      readyForApproval: fareReconciliation.pendingCount === 0 && fareReconciliation.mismatchCount === 0,
    },
  };
}

// Normalized calculation inputs. Matching remains an explicit source-to-roster
// join so uploaded names never become provider master data.
export function division3RowsForCalculation({ imports, providers, cycle, processingDivisions = [] }) {
  const matches = matchDivision3Drivers(imports, providers, cycle, processingDivisions).filter((match) => match.status === 'MATCHED');
  const byName = new Map(matches.map((match) => [match.sourceKey, match]));
  const dutyRows = imports.filter((doc) => ['DIV3_ADA', 'DIV3_GOLINK'].includes(doc.kind)).flatMap((doc) => (
    (doc.division3DutyRows || []).map((row) => {
      const match = byName.get(sourceMatchKey(row.driverName, row.service || serviceForKind(doc.kind)));
      return match ? { ...(row.toObject?.() || row), providerId: match.providerId, operatorId: match.operatorId, sourceImportId: doc._id, sourceFileName: doc.originalFileName } : null;
    }).filter(Boolean)
  ));
  const rawFares = imports.filter((doc) => doc.kind === 'DIV3_ADA_FARE').flatMap((doc) => doc.division3FareRows || []);
  const returnedRows = imports.filter((doc) => doc.kind === 'DIV3_RETURNED_FARE').flatMap((doc) => doc.division3ReturnedFareRows || []);
  const reconciled = reconcileDivision3Fares(rawFares, returnedRows);
  const fareRows = reconciled.rows.map((row) => {
    const match = byName.get(sourceMatchKey(row.driverName, 'ADA'));
    return match ? { ...row, providerId: match.providerId, operatorId: match.operatorId } : null;
  }).filter(Boolean);
  return { dutyRows, fareRows, reconciliation: reconciled };
}
