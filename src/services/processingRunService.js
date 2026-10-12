import ProcessingRun from '../models/ProcessingRun.js';
import VdpCycle from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import PerformanceImport from '../models/PerformanceImport.js';
import DatasetImport from '../models/DatasetImport.js';
import MatchResolution from '../models/MatchResolution.js';
import { cycleSummary } from './summaryService.js';
import { processingDivisionsFor } from './divisionGroups.js';
import { processCycle } from './vdpService.js';
import { actor, badRequest, notFound } from './errors.js';
import { recordAudit } from './auditService.js';

function readinessFrom(summary) {
  const div3 = summary.division3Data;
  const generic = summary.divisionSources;
  const requiredDataReady = div3
    ? div3.requiredReady
    : generic?.configured
      ? generic.requiredReady
      : (!summary.inputRequirements.uberRequired || summary.uberPerformance.ready);
  const additionalDataReady = generic?.configured ? generic.additionalReady : true;
  const unresolvedMatches = Number(summary.performance?.unresolvedCount || 0)
    + Number(summary.uberPerformance?.unresolvedCount || 0)
    + Number(div3?.unresolvedCount || 0);
  const validationReady = requiredDataReady && additionalDataReady;
  const currentSection = !requiredDataReady
    ? 'REQUIRED_DATA'
    : !additionalDataReady
      ? 'ADDITIONAL_DATA'
      : !validationReady
        ? 'VALIDATION'
        : summary.vdps.total > 0
          ? 'RESULTS'
          : 'VALIDATION';
  return {
    requiredDataReady,
    additionalDataReady,
    validationReady,
    unresolvedMatches,
    providersExpected: summary.providersExpected,
    providersWithoutVdp: summary.providersWithoutVdp,
    vdpCounts: summary.vdps,
    currentSection,
  };
}

async function syncRunLedgers(run) {
  const imports = await PerformanceImport.find({ cycleId: run.cycleId }).lean();
  const ledgers = new Map();
  for (const source of imports) {
    const ledger = await DatasetImport.findOneAndUpdate(
      { sourceImportId: source._id },
      {
        $set: {
          processingRunId: run._id,
          cycleId: source.cycleId,
          divisionId: source.divisionId,
          datasetType: source.datasetType || source.kind,
          filename: source.originalFileName,
          checksum: source.fileHash,
          fileSize: source.fileSize,
          schemaVersion: source.stats?.schemaVersion || '1',
          parserVersion: source.stats?.parserVersion || source.stats?.sourceAdapter || '1',
          dateCoverage: source.dataRange || source.reportRange || null,
          status: source.status === 'REPLACED' ? 'SUPERSEDED' : source.status,
          uploadedBy: source.uploadedBy,
          activatedAt: source.status === 'ACTIVE' ? source.uploadedAt : null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    ledgers.set(String(source._id), ledger);
  }
  for (const source of imports) {
    const ledger = ledgers.get(String(source._id));
    const supersedes = ledgers.get(String(source.supersedesImportId || ''));
    const supersededBy = ledgers.get(String(source.supersededByImportId || ''));
    if (!ledger || (!supersedes && !supersededBy)) continue;
    ledger.supersedesId = supersedes?._id || null;
    ledger.supersededById = supersededBy?._id || null;
    await ledger.save();
  }

  const resolutions = [];
  for (const source of imports) {
    for (const match of source.uberDriverMatches || []) resolutions.push({
      cycleId: source.cycleId, divisionId: source.divisionId, sourceService: 'UBER',
      sourceIdentity: match.driverUuid, providerId: match.providerId, operatorId: match.operatorId,
      status: 'MATCHED', method: match.method === 'MANUAL' ? 'MANUAL' : 'EXACT_NAME',
      confidence: match.confidence, resolvedBy: match.matchedBy, resolvedAt: match.matchedAt,
    });
    for (const match of source.division3DriverMatches || []) resolutions.push({
      cycleId: source.cycleId, divisionId: source.divisionId, sourceService: `DIV3_${match.service || 'UNKNOWN'}`,
      sourceIdentity: match.sourceName, sourceName: match.sourceName, providerId: match.providerId, operatorId: match.operatorId,
      status: 'MATCHED', method: match.method === 'MANUAL' ? 'MANUAL' : match.method === 'AUTO_EXACT_NAME' ? 'EXACT_NAME' : 'SMART_NAME',
      confidence: match.confidence, resolvedBy: match.matchedBy, resolvedAt: match.matchedAt,
    });
    for (const excluded of source.division3DriverExclusions || []) resolutions.push({
      cycleId: source.cycleId, divisionId: source.divisionId, sourceService: `DIV3_${excluded.service}`,
      sourceIdentity: excluded.sourceName, sourceName: excluded.sourceName, status: 'SET_ASIDE', method: 'SET_ASIDE',
      reason: excluded.reason, resolvedBy: excluded.excludedBy, resolvedAt: excluded.excludedAt,
    });
  }
  for (const resolution of resolutions) {
    await MatchResolution.findOneAndUpdate(
      { cycleId: resolution.cycleId, sourceService: resolution.sourceService, sourceIdentity: resolution.sourceIdentity },
      { $set: resolution },
      { upsert: true, setDefaultsOnInsert: true },
    );
  }
}

async function hydrate(run, { touch = false, user = null } = {}) {
  await syncRunLedgers(run);
  const summary = await cycleSummary(run.cycleId);
  const readiness = readinessFrom(summary);
  run.readiness = readiness;
  run.currentSection = readiness.currentSection;
  if (touch) {
    run.lastOpenedBy = actor(user);
    run.lastOpenedAt = new Date();
  }
  if (run.status !== 'ARCHIVED') {
    if (summary.vdps.PAID === summary.providersExpected && summary.providersExpected > 0) run.status = 'COMPLETE';
    else if (summary.vdps.total > 0) run.status = summary.vdps.NEEDS_REVIEW || readiness.unresolvedMatches ? 'EXCEPTIONS' : 'REVIEW';
    else run.status = readiness.validationReady ? 'READY' : 'INTAKE';
  }
  await run.save();
  return { ...run.toJSON(), summary };
}

export async function openRun({ cycleId, user }) {
  if (!cycleId) throw badRequest('Choose a VDP cycle. The first primary upload may also create the cycle before opening its run.');
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const division = await Division.findById(cycle.divisionId);
  if (!division) throw notFound('Division');
  const divisions = await processingDivisionsFor(division);
  let run = await ProcessingRun.findOne({ cycleId: cycle._id });
  if (!run) {
    run = await ProcessingRun.create({
      cycleId: cycle._id,
      divisionId: division._id,
      processingDivisionIds: divisions.map((item) => item._id),
      createdBy: actor(user),
      lastOpenedBy: actor(user),
    });
    await recordAudit({ action: 'PROCESSING_RUN_CREATED', entityType: 'ProcessingRun', entityId: run._id, entityLabel: `${division.divisionNumber} ${cycle.cycleStart.toISOString().slice(0, 10)}`, user });
  }
  return hydrate(run, { touch: true, user });
}

export async function listRuns({ status, limit = 25 } = {}) {
  const filter = status ? { status } : { status: { $ne: 'ARCHIVED' } };
  const runs = await ProcessingRun.find(filter)
    .populate('divisionId', 'divisionNumber name')
    .populate('cycleId', 'cycleStart cycleEnd paymentDate status')
    .sort({ lastOpenedAt: -1 })
    .limit(Math.min(Number(limit) || 25, 100));
  return runs;
}

export async function getRun(id, user) {
  const run = await ProcessingRun.findById(id);
  if (!run) throw notFound('Processing run');
  return hydrate(run, { touch: true, user });
}

export async function processReady(id, user) {
  const run = await ProcessingRun.findById(id);
  if (!run) throw notFound('Processing run');
  run.status = 'PROCESSING';
  run.lastError = null;
  await run.save();
  try {
    const result = await processCycle(run.cycleId, user, { partial: true });
    run.lastResult = result;
    run.processedBy = actor(user);
    run.processedAt = new Date();
    await recordAudit({ action: 'PROCESS_READY_PROVIDERS', entityType: 'ProcessingRun', entityId: run._id, user, metadata: result });
    return hydrate(run);
  } catch (error) {
    run.status = 'FAILED';
    run.lastError = { message: error.message, details: error.details || null, at: new Date() };
    await run.save();
    throw error;
  }
}

export async function archiveRun(id, reason, user) {
  if (!String(reason || '').trim()) throw badRequest('Give a reason for archiving this processing run.');
  const run = await ProcessingRun.findById(id);
  if (!run) throw notFound('Processing run');
  run.status = 'ARCHIVED';
  run.archivedAt = new Date();
  await run.save();
  await recordAudit({ action: 'ARCHIVE', entityType: 'ProcessingRun', entityId: run._id, reason, user });
  return run;
}
