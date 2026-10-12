import crypto from 'node:crypto';
import PerformanceImport from '../models/PerformanceImport.js';
import VdpCycle from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import Vdp from '../models/Vdp.js';
import { actor, badRequest, conflict, notFound } from './errors.js';
import { addDays, isoDate, weekOf } from './cycleService.js';
import { inferCycleFromDates } from './cycleInference.js';
import {
  contractForDivisionNumber,
  definitionForDataset,
  publicContractForDivision,
  publicSourceDefinition,
} from './divisionSourceDefinitions.js';
import { DivisionSourceValidationError, parseDivisionSourceFile } from './divisionSourceParser.js';
import { DIV10_ADAPTER_VERSION, refreshDivision10DerivedImport } from './division10Adapter.js';

const activeFor = (cycleId, datasetType = null) => PerformanceImport.find({
  cycleId,
  kind: 'DIVISION_SOURCE',
  ...(datasetType ? { datasetType } : {}),
  status: 'ACTIVE',
  validationStatus: 'VALID',
}).sort({ uploadedAt: 1 });

const summary = (doc) => ({
  _id: doc._id,
  divisionId: doc.divisionId,
  cycleId: doc.cycleId,
  datasetType: doc.datasetType,
  fileName: doc.originalFileName,
  fileSize: doc.fileSize,
  uploadedAt: doc.uploadedAt,
  uploadedBy: doc.uploadedBy,
  rowCount: doc.rowCount || 0,
  dataRange: doc.dataRange,
  datesDetected: doc.datesDetected || [],
  weeksDetected: doc.weeksDetected || [],
  validationStatus: doc.validationStatus,
  status: doc.status,
  processingErrors: doc.processingErrors || [],
  warnings: doc.warnings || [],
  sheetName: doc.stats?.sheetName || null,
  adapterVersion: doc.stats?.adapterVersion || null,
});

async function divisionForUpload(cycle, divisionId) {
  const division = await Division.findById(cycle?.divisionId || divisionId);
  if (!division) throw notFound('Division');
  return division;
}

async function markCycleStale(cycleId) {
  await Vdp.updateMany({ cycleId, status: { $in: ['DRAFT', 'NEEDS_REVIEW', 'READY'] } }, { $set: { stale: true } });
}

function parseError(error) {
  if (error instanceof DivisionSourceValidationError) {
    return { errors: [error.message], details: error.details || {} };
  }
  return { errors: [`The file could not be read: ${error.message}`], details: { code: 'UNREADABLE_FILE' } };
}

export async function contractForDivisionId(divisionId) {
  const division = await Division.findById(divisionId);
  if (!division) throw notFound('Division');
  return publicContractForDivision(division);
}

export async function uploadDivisionSourceFiles({ cycleId, divisionId, datasetType, files, user }) {
  if (!files?.length) throw badRequest('Choose at least one source file.');
  let cycle = cycleId ? await VdpCycle.findById(cycleId) : null;
  if (cycleId && !cycle) throw notFound('VDP cycle');
  const division = await divisionForUpload(cycle, divisionId);
  const definition = definitionForDataset(division.divisionNumber, datasetType);
  if (!definition) throw badRequest('That dataset is not part of this division\'s upload contract.');

  const preparsed = new Map();
  if (!cycle) {
    if (!definition.cycleLocator) {
      const locator = contractForDivisionNumber(division.divisionNumber).find((item) => item.cycleLocator);
      throw badRequest(`Upload ${locator?.title || 'the primary required dataset'} first so its dates can identify the VDP period.`);
    }
    for (const file of files) {
      try {
        preparsed.set(file, await parseDivisionSourceFile(file.buffer, file.originalname, division.divisionNumber, datasetType));
      } catch (error) {
        throw badRequest(`The pay period could not be identified from ${file.originalname}: ${parseError(error).errors[0]}`, parseError(error).details);
      }
    }
    cycle = await inferCycleFromDates({
      divisionId: division._id,
      dates: [...preparsed.values()].flatMap((item) => item.datesDetected),
      label: definition.title,
    });
  }

  const existing = await activeFor(cycle._id, datasetType);
  const existingByHash = new Map(existing.map((doc) => [doc.fileHash, doc]));
  const results = [];
  const from = isoDate(cycle.cycleStart);
  const to = isoDate(cycle.cycleEnd);

  for (const file of files) {
    const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const duplicate = existingByHash.get(fileHash);
    if (duplicate && (String(division.divisionNumber).trim() !== '10'
      || duplicate.stats?.adapterVersion === DIV10_ADAPTER_VERSION)) {
      results.push({ ...summary(duplicate), reused: true });
      continue;
    }
    let parsed = null;
    let errors = [];
    let details = {};
    try {
      parsed = preparsed.get(file) || await parseDivisionSourceFile(file.buffer, file.originalname, division.divisionNumber, datasetType, { cycle });
      const inPeriod = parsed.datesDetected.filter((date) => date >= from && date <= to);
      const outside = parsed.datesDetected.filter((date) => date < from || date > to);
      if (!inPeriod.length) errors.push(`The file has no source dates inside this VDP period (${from} to ${to}).`);
      if (outside.length && !definition.allowDatesOutsideCycle) {
        errors.push(`Source date${outside.length === 1 ? '' : 's'} outside this VDP period: ${outside.slice(0, 10).join(', ')}${outside.length > 10 ? ', ...' : ''}.`);
      }
    } catch (error) {
      ({ errors, details } = parseError(error));
    }

    const valid = Boolean(parsed) && errors.length === 0;
    const datesInPeriod = parsed?.datesDetected?.filter((date) => date >= from && date <= to) || [];
    const weeksDetected = [...new Set(datesInPeriod.map((date) => weekOf(date, cycle)).filter(Boolean).map((week) => (
      week === 1 ? isoDate(cycle.week1Start) : isoDate(cycle.week2Start)
    )))].sort();
    const values = {
      divisionId: cycle.divisionId,
      cycleId: cycle._id,
      kind: 'DIVISION_SOURCE',
      datasetType,
      originalFileName: file.originalname,
      fileHash,
      fileSize: file.size ?? file.buffer.length,
      uploadedBy: actor(user),
      rowCount: valid ? parsed.rowCount : 0,
      status: valid ? 'ACTIVE' : 'INVALID',
      validationStatus: valid ? 'VALID' : 'INVALID',
      processingErrors: errors,
      dataRange: parsed?.dataRange,
      datesDetected: parsed?.datesDetected || [],
      weeksDetected,
      detectedColumns: parsed?.performanceColumns || parsed?.detectedColumns || details.detectedColumns || [],
      stats: {
        validationCode: details.code || null,
        sheetName: parsed?.sheetName || null,
        adapterVersion: valid ? parsed?.adapterVersion || null : null,
      },
      warnings: parsed?.warnings || [],
      rows: valid ? parsed?.rows || [] : [],
      division10ManifestRows: valid ? parsed?.division10ManifestRows || [] : [],
      division10FareRows: valid ? parsed?.division10FareRows || [] : [],
      division10FuelRows: valid ? parsed?.division10FuelRows || [] : [],
    };
    const doc = duplicate && valid ? duplicate : new PerformanceImport();
    doc.set(values);
    await doc.save();
    results.push(summary(doc));
    if (valid) {
      existingByHash.set(fileHash, doc);
    }
  }

  if (results.some((item) => item.validationStatus === 'VALID')) {
    if (String(division.divisionNumber).trim() === '10') {
      await refreshDivision10DerivedImport({ cycle, user });
    }
    await markCycleStale(cycle._id);
    if (['UPCOMING', 'OPEN'].includes(cycle.status)) {
      cycle.status = 'PROCESSING';
      await cycle.save();
    }
  }
  return { files: results, cycleId: cycle._id };
}

export async function listDivisionSourceImports({ cycleId, divisionId, datasetType } = {}) {
  const filter = { kind: 'DIVISION_SOURCE' };
  if (cycleId) filter.cycleId = cycleId;
  if (divisionId) filter.divisionId = divisionId;
  if (datasetType) filter.datasetType = datasetType;
  return (await PerformanceImport.find(filter).sort({ uploadedAt: -1 })).map(summary);
}

export async function removeDivisionSourceImport(id, user) {
  const doc = await PerformanceImport.findOne({ _id: id, kind: 'DIVISION_SOURCE' });
  if (!doc) throw notFound('Division source upload');
  if (doc.validationStatus === 'INVALID' || doc.status === 'INVALID') {
    const removed = summary(doc);
    await doc.deleteOne();
    return { ...removed, status: 'DELETED', deleted: true };
  }
  if (doc.status !== 'ACTIVE') throw conflict('This source upload is not active.');
  doc.status = 'REPLACED';
  doc.replacedAt = new Date();
  doc.replacedBy = actor(user);
  doc.replaceReason = 'Removed from the active division source dataset';
  await doc.save();
  const [cycle, division] = await Promise.all([VdpCycle.findById(doc.cycleId), Division.findById(doc.divisionId)]);
  if (cycle && String(division?.divisionNumber || '').trim() === '10') {
    await refreshDivision10DerivedImport({ cycle, user });
  }
  await markCycleStale(doc.cycleId);
  return summary(doc);
}

const datesFrom = (from, to) => {
  const dates = [];
  for (let current = new Date(from); current <= new Date(to); current = addDays(current, 1)) dates.push(isoDate(current));
  return dates;
};

function datasetReadiness(definition, files, cycle) {
  const active = files.filter((file) => file.status === 'ACTIVE' && file.validationStatus === 'VALID');
  const dates = [...new Set(active.flatMap((file) => file.datesDetected || []).filter((date) => date >= isoDate(cycle.cycleStart) && date <= isoDate(cycle.cycleEnd)))].sort();
  const weeks = [...new Set(active.flatMap((file) => file.weeksDetected || []))].sort();
  const expectedWeeks = [isoDate(cycle.week1Start), isoDate(cycle.week2Start)];
  const expectedDates = definition.coverage === 'EVERY_DAY' ? datesFrom(cycle.cycleStart, cycle.cycleEnd) : [];
  const missingWeeks = ['BOTH_WEEKS', 'CYCLE_OVERLAP'].includes(definition.coverage) ? expectedWeeks.filter((week) => !weeks.includes(week)) : [];
  const missingDates = expectedDates.filter((date) => !dates.includes(date));
  const coverageReady = definition.coverage === 'EVERY_DAY'
    ? missingDates.length === 0
    : ['BOTH_WEEKS', 'CYCLE_OVERLAP'].includes(definition.coverage)
      ? missingWeeks.length === 0
      : active.length > 0;
  return {
    ...publicSourceDefinition(definition),
    files,
    loaded: active.length > 0,
    activeFileCount: active.length,
    rowCount: active.reduce((total, file) => total + Number(file.rowCount || 0), 0),
    datesDetected: dates,
    weeksDetected: weeks,
    expectedWeeks,
    missingWeeks,
    expectedDates,
    missingDates,
    ready: definition.required ? coverageReady : true,
  };
}

export async function divisionSourceReadiness({ cycle, division }) {
  const definitions = contractForDivisionNumber(division?.divisionNumber);
  const contract = publicContractForDivision(division);
  const docs = await listDivisionSourceImports({ cycleId: cycle._id });
  const datasets = Object.fromEntries(definitions.map((definition) => [
    definition.id,
    datasetReadiness(definition, docs.filter((doc) => doc.datasetType === definition.id), cycle),
  ]));
  const required = Object.values(datasets).filter((dataset) => dataset.required && dataset.stage === 'REQUIRED');
  const additional = Object.values(datasets).filter((dataset) => dataset.required && dataset.stage === 'ADDITIONAL');
  const division10 = String(division?.divisionNumber || '').trim() === '10';
  const requiredFiles = required.flatMap((dataset) => dataset.files.filter((file) => file.status === 'ACTIVE' && file.validationStatus === 'VALID'));
  const adapterReady = division10 && required.length > 0 && required.every((dataset) => dataset.ready)
    && requiredFiles.every((file) => file.adapterVersion === DIV10_ADAPTER_VERSION);
  return {
    configured: definitions.length > 0,
    targetWorkbook: contract.targetWorkbook,
    targetWorkbooks: contract.targetWorkbooks,
    datasets,
    requiredReady: required.length > 0 && required.every((dataset) => dataset.ready),
    additionalReady: additional.every((dataset) => dataset.ready),
    ready: required.length > 0 && required.every((dataset) => dataset.ready) && additional.every((dataset) => dataset.ready),
    processingSupported: adapterReady,
    processingBlockReason: division10 && required.every((dataset) => dataset.ready) && !adapterReady
      ? 'These files were staged before the DIV 10 calculation adapter was enabled. Re-upload each listed file once; exact duplicates will be upgraded in place without creating another upload.'
      : null,
  };
}

