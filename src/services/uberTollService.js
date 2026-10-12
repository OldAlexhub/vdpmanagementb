import crypto from 'node:crypto';
import Division from '../models/Division.js';
import PerformanceImport from '../models/PerformanceImport.js';
import VdpCycle from '../models/VdpCycle.js';
import Vdp from '../models/Vdp.js';
import { parseUberTollFile, UberTollFileValidationError } from './uberTollParser.js';
import { activeUberImportsFor } from './uberPerformanceService.js';
import { inferCycleFromDates } from './cycleInference.js';
import { isoDate } from './cycleService.js';
import { actor, badRequest, conflict, notFound } from './errors.js';

export const activeUberTollImportsFor = (cycleId) => PerformanceImport.find({
  cycleId,
  kind: 'UBER_TOLLS',
  status: 'ACTIVE',
  validationStatus: 'VALID',
}).sort({ uploadedAt: 1 });

const importSummary = (doc) => ({
  _id: doc._id,
  divisionId: doc.divisionId,
  cycleId: doc.cycleId,
  fileName: doc.originalFileName,
  fileSize: doc.fileSize,
  uploadedAt: doc.uploadedAt,
  uploadedBy: doc.uploadedBy,
  rowCount: doc.rowCount || 0,
  tollRowCount: doc.stats?.tollRowCount || 0,
  tollTotal: doc.stats?.tollTotal || '0.00',
  weeksDetected: doc.weeksDetected || [],
  driversDetected: doc.driversDetected || 0,
  validationStatus: doc.validationStatus,
  status: doc.status,
  processingErrors: doc.processingErrors || [],
  detectedColumns: doc.detectedColumns || [],
});

async function markCycleStale(cycleId) {
  await Vdp.updateMany({ cycleId, status: { $in: ['DRAFT', 'NEEDS_REVIEW', 'READY'] } }, {
    $set: { stale: true }, $addToSet: { staleReasons: 'Uber toll reimbursement data changed.' },
  });
}

function invalidDetails(error) {
  if (error instanceof UberTollFileValidationError) return error.details || {};
  return { code: 'UNREADABLE_FILE' };
}

export async function uploadUberTollFiles({ cycleId, divisionId, files, user }) {
  if (!files?.length) throw badRequest('Choose at least one Uber toll reimbursement .csv, .xlsx, or .xls file.');
  let cycle = cycleId ? await VdpCycle.findById(cycleId) : null;
  if (cycleId && !cycle) throw notFound('VDP cycle');
  const preparsed = new Map();
  if (!cycle) {
    for (const file of files) {
      try {
        preparsed.set(file, await parseUberTollFile(file.buffer, file.originalname));
      } catch (error) {
        throw badRequest(`The pay period could not be identified from ${file.originalname}: ${error.message}`);
      }
    }
    cycle = await inferCycleFromDates({
      divisionId,
      dates: [...preparsed.values()].flatMap((parsed) => parsed.weeksDetected),
      label: 'Uber toll dataset',
    });
  }
  const division = await Division.findById(cycle.divisionId).select('divisionNumber');
  if (String(division?.divisionNumber || '').trim() === '10') {
    throw badRequest('Division 10 does not use Uber toll reimbursements.');
  }
  const [existing, uberImports] = await Promise.all([
    activeUberTollImportsFor(cycle._id),
    activeUberImportsFor(cycle._id),
  ]);
  const existingHashes = new Set(existing.map((doc) => doc.fileHash));
  const existingKeys = new Map(existing.flatMap((doc) => doc.uberTollRows.map((row) => [
    `${row.driverUuid.toLowerCase()}|${row.week}`,
    doc.originalFileName,
  ])));
  const uberKeys = new Set(uberImports.flatMap((doc) => doc.uberRows.map((row) => `${row.driverUuid.toLowerCase()}|${row.week}`)));
  const results = [];

  for (const file of files) {
    const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    let parsed = null;
    let errors = [];
    let details = {};
    if (existingHashes.has(fileHash)) {
      errors = ['This exact toll file is already active for the selected VDP cycle.'];
      details = { code: 'DUPLICATE_UPLOAD' };
    } else {
      try {
        parsed = preparsed.get(file) || await parseUberTollFile(file.buffer, file.originalname);
        const expectedWeeks = new Set([isoDate(cycle.week1Start), isoDate(cycle.week2Start)]);
        const outside = parsed.weeksDetected.filter((week) => !expectedWeeks.has(week));
        if (outside.length) errors.push(`Toll week outside this VDP cycle: ${outside.join(', ')}.`);
        const overlaps = parsed.rows.filter((row) => existingKeys.has(`${row.driverUuid.toLowerCase()}|${row.week}`));
        if (overlaps.length) {
          const samples = overlaps.slice(0, 5).map((row) => `${row.driverUuid} / ${row.week} (${existingKeys.get(`${row.driverUuid.toLowerCase()}|${row.week}`)})`);
          errors.push(`Driver-week toll data is already active: ${samples.join(', ')}${overlaps.length > samples.length ? ` and ${overlaps.length - samples.length} more` : ''}. Remove the older upload before loading a correction.`);
        }
        const unmatchedTolls = parsed.rows.filter((row) => Number(row.amount) > 0 && !uberKeys.has(`${row.driverUuid.toLowerCase()}|${row.week}`));
        if (unmatchedTolls.length) {
          const samples = unmatchedTolls.slice(0, 5).map((row) => `${row.driverUuid} / ${row.week}`);
          errors.push(`${unmatchedTolls.length} non-zero toll row(s) have no matching driver UUID/week in the active Uber Report: ${samples.join(', ')}${unmatchedTolls.length > samples.length ? ` and ${unmatchedTolls.length - samples.length} more` : ''}.`);
        }
        if (!uberImports.length) errors.push('Upload the required Uber Report files before their toll reimbursement files.');
      } catch (error) {
        details = invalidDetails(error);
        errors = details.errors?.length ? details.errors : [error.message];
      }
    }

    const valid = Boolean(parsed) && errors.length === 0;
    const doc = new PerformanceImport({
      divisionId: cycle.divisionId,
      cycleId: cycle._id,
      kind: 'UBER_TOLLS',
      originalFileName: file.originalname,
      fileHash,
      fileSize: file.size ?? file.buffer.length,
      uploadedBy: actor(user),
      rowCount: valid ? parsed.rowCount : 0,
      status: valid ? 'ACTIVE' : 'INVALID',
      validationStatus: valid ? 'VALID' : 'INVALID',
      processingErrors: errors,
      detectedColumns: parsed?.detectedColumns || details.detectedColumns || [],
      stats: {
        validationCode: details.code || null,
        tollRowCount: parsed?.tollRowCount || 0,
        tollTotal: parsed?.tollTotal || '0.00',
      },
      uberTollRows: valid ? parsed.rows : [],
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

export async function listUberTollImports({ cycleId, divisionId, includeInvalid = true } = {}) {
  const filter = { kind: 'UBER_TOLLS' };
  if (cycleId) filter.cycleId = cycleId;
  if (divisionId) filter.divisionId = divisionId;
  if (!includeInvalid) Object.assign(filter, { status: 'ACTIVE', validationStatus: 'VALID' });
  return (await PerformanceImport.find(filter).sort({ uploadedAt: -1 })).map(importSummary);
}

export async function removeUberTollImport(id, user) {
  const doc = await PerformanceImport.findOne({ _id: id, kind: 'UBER_TOLLS' });
  if (!doc) throw notFound('Uber toll upload');
  if (doc.validationStatus === 'INVALID' || doc.status === 'INVALID') {
    const removed = importSummary(doc);
    await doc.deleteOne();
    return { ...removed, status: 'DELETED', deleted: true };
  }
  if (doc.status !== 'ACTIVE') throw conflict('This Uber toll upload is not active.');
  doc.status = 'REPLACED';
  doc.replacedAt = new Date();
  doc.replacedBy = actor(user);
  doc.replaceReason = 'Removed from the active Uber toll reimbursement data set';
  await doc.save();
  await markCycleStale(doc.cycleId);
  return importSummary(doc);
}

export async function clearInvalidUberTollImports({ cycleId }) {
  if (!cycleId) throw badRequest('Choose a VDP cycle.');
  const result = await PerformanceImport.deleteMany({ cycleId, kind: 'UBER_TOLLS', validationStatus: 'INVALID' });
  return { deletedCount: result.deletedCount || 0 };
}

export function uberTollReadiness({ cycle, tollImports, uberImports }) {
  const expectedWeeks = [isoDate(cycle.week1Start), isoDate(cycle.week2Start)];
  const loadedWeeks = [...new Set(tollImports.flatMap((doc) => doc.weeksDetected || []))].sort();
  const uberKeys = new Set(uberImports.flatMap((doc) => doc.uberRows.map((row) => `${row.driverUuid.toLowerCase()}|${row.week}`)));
  const unmatchedRows = tollImports.flatMap((doc) => doc.uberTollRows
    .filter((row) => Number(row.amount) > 0 && !uberKeys.has(`${row.driverUuid.toLowerCase()}|${row.week}`))
    .map((row) => ({ driverUuid: row.driverUuid, week: row.week, amount: String(row.amount), fileName: doc.originalFileName })));
  const missingWeeks = expectedWeeks.filter((week) => !loadedWeeks.includes(week));
  return { expectedWeeks, loadedWeeks, missingWeeks, unmatchedRows, ready: missingWeeks.length === 0 && unmatchedRows.length === 0 };
}

export function tollWeeklyAdjustments(tollImports) {
  const byKey = new Map();
  for (const doc of tollImports) {
    for (const row of doc.uberTollRows) {
      if (Number(row.amount) <= 0) continue;
      const key = `${row.driverUuid.toLowerCase()}|${row.week}`;
      const entry = byKey.get(key) || { driverUuid: row.driverUuid.toLowerCase(), week: row.week, passThroughs: [] };
      entry.passThroughs.push({
        type: 'TOLL',
        amount: String(row.amount),
        description: `Uber toll reimbursement from ${doc.originalFileName}`,
      });
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

