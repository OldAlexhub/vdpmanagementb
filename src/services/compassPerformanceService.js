import crypto from 'node:crypto';
import CompassPerformanceState from '../models/CompassPerformanceState.js';
import PerformanceImport from '../models/PerformanceImport.js';
import NormalizedFact from '../models/NormalizedFact.js';
import VdpCycle from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import VdpPlan from '../models/VdpPlan.js';
import Vdp from '../models/Vdp.js';
import { compassConfigView, requestCompass } from './compassClient.js';
import { processingDivisionsFor } from './divisionGroups.js';
import { isoDate, addDays } from './cycleService.js';
import { actor, badRequest, conflict, notFound } from './errors.js';
import { sum } from './money.js';
import { resolveSettings, resolveVersion } from './planService.js';
import { activeOperators, worksOn } from './operators.js';
import { recordAudit } from './auditService.js';
import { hashPerformance, metricValue, normalizeCompassPerformance, matchCompassRows, mergeCompassRows, needsPaidHours, needsAttainmentHours, unusableHour } from './compassPerformanceData.js';

const EDITABLE = ['DRAFT', 'NEEDS_REVIEW', 'READY'];
const SOURCES = ['vision', 'ecolane', 'spare', 'rideco'];
export const performanceDates = (from, to) => {
  const dates = [];
  for (let day = new Date(`${from}T00:00:00Z`); isoDate(day) <= to; day = addDays(day, 1)) dates.push(isoDate(day));
  return dates;
};

async function context(cycleId) {
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const division = await Division.findById(cycle.divisionId);
  if (!division) throw notFound('Division');
  const divisions = await processingDivisionsFor(division);
  return { cycle, division, divisions };
}

async function pool(jobs, count = 4) {
  let index = 0;
  const results = new Array(jobs.length);
  // Await all workers even on failure so no requests outlive the cycle lock.
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(count, jobs.length) }, async () => {
    while (index < jobs.length) {
      const i = index++;
      results[i] = await jobs[i]();
    }
  }));
  const failed = outcomes.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}

export async function fetchCompassPerformance({ divisions, from, to, request = requestCompass }) {
  const rows = [];
  const summaries = [];
  for (const division of divisions.filter((d) => d.source?.system === 'COMPASS' && d.source.externalId)) {
    const externalDivisionId = division.source.externalId;
    const analysis = await request('performance', { division: externalDivisionId, from, to });
    const batches = await pool(performanceDates(from, to).flatMap((date) => SOURCES.map((source) => async () => {
      const result = await request('entries', { division: externalDivisionId, from: date, to: date, source });
      if (!Array.isArray(result.entries)) throw badRequest('Compass entries response is incomplete.');
      if (result.entries.length >= 2000) throw badRequest(`Compass reached its 2,000-entry limit on ${date} (${source}). No snapshot was activated.`, { code: 'COMPASS_TRUNCATED' });
      if (result.entries.some((entry) => entry.date !== date || entry.source !== source)) throw badRequest('Compass did not honor its date/source filters.');
      return result.entries;
    })));
    const normalized = normalizeCompassPerformance(batches.flat(), analysis, { divisionId: division._id, externalDivisionId, from, to });
    rows.push(...normalized);
    summaries.push({ divisionId: String(division._id), divisionNumber: division.divisionNumber, summary: analysis.summary, dates: analysis.daily.map((d) => d.date) });
  }
  return { rows: rows.sort((a, b) => a.rowKey.localeCompare(b.rowKey)), summaries };
}

export async function compassPerformanceView(cycleId, { providers: suppliedProviders } = {}) {
  const { cycle, divisions } = await context(cycleId);
  const state = await CompassPerformanceState.findOne({ cycleId }).lean();
  const snapshot = state?.activeImportId ? await PerformanceImport.findById(state.activeImportId).lean() : null;
  const facts = snapshot ? await NormalizedFact.find({ importId: snapshot._id, factType: 'PERFORMANCE' }).sort({ sequence: 1 }).lean() : [];
  const providers = suppliedProviders || await Provider.find({ divisionId: { $in: divisions.map((d) => d._id) } });
  const rows = matchCompassRows(facts.map((fact) => fact.payload), providers, state?.corrections || []);
  const configured = compassConfigView().configured;
  const linked = divisions.filter((d) => d.source?.system === 'COMPASS' && d.source.externalId);
  const expectedDates = performanceDates(isoDate(cycle.cycleStart), isoDate(cycle.cycleEnd));
  const coverage = linked.map((division) => {
    const own = rows.filter((row) => row.divisionId === String(division._id) && (!row.missingFromSource || row.correction?.baseline === 'MISSING'));
    const dates = [...new Set(own.map((row) => row.date))].sort();
    return { divisionId: String(division._id), divisionNumber: division.divisionNumber, dates, missingDates: expectedDates.filter((day) => !dates.includes(day)), rowCount: own.length };
  });
  return {
    configured, available: configured && linked.length > 0,
    revision: state?.revision || 0, importId: snapshot?._id || null,
    loaded: Boolean(snapshot && rows.some((row) => !row.missingFromSource || row.correction?.baseline === 'MISSING')), attempted: Boolean(state?.lastAttemptAt),
    refreshing: Boolean(state?.lock && state.lockUntil > new Date()),
    lastAttemptAt: state?.lastAttemptAt || null, lastSyncedAt: state?.lastSyncedAt || null, lastError: state?.lastError || null,
    locked: ['APPROVED', 'PAID', 'CLOSED', 'ARCHIVED'].includes(cycle.status),
    coverage, rows, correctionHistory: (state?.corrections || []).flatMap((c) => (c.history || []).map((h) => ({ rowKey: c.rowKey, date: c.sourceRow?.date, route: c.sourceRow?.route, ...h }))),
    unresolvedCount: rows.filter((row) => row.assignmentIssue).length,
    conflictCount: rows.filter((row) => row.conflict).length,
    totals: { trips: sum(rows.map((r) => r.trips)).toString(), serviceHours: sum(rows.map((r) => r.serviceHours)).toString() },
    missingMetrics: ['serviceHours', 'revenueHours'].filter((field) => rows.some((r) => unusableHour(r[field]))),
  };
}

export async function compassPerformanceForCalculation(cycleId) {
  if (!await CompassPerformanceState.exists({ cycleId })) return { rows: [], loaded: false, importId: null, revision: 0, refreshing: false };
  return compassPerformanceView(cycleId);
}

async function mutate(cycleId, expectedRevision, work) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw badRequest('A performance revision is required. Refresh and try again.');
  const ctx = await context(cycleId);
  if (['APPROVED', 'PAID', 'CLOSED', 'ARCHIVED'].includes(ctx.cycle.status)) throw conflict('Reopen this pay period before changing performance data.');
  await CompassPerformanceState.updateOne({ cycleId }, { $setOnInsert: { cycleId, revision: 0 } }, { upsert: true });
  const lock = crypto.randomUUID();
  const now = new Date();
  const state = await CompassPerformanceState.findOneAndUpdate({
    cycleId, revision: expectedRevision, $or: [{ lock: null }, { lockUntil: { $lte: now } }],
  }, { $set: { lock, lockUntil: new Date(now.getTime() + 30 * 60 * 1000) } }, { returnDocument: 'after' });
  if (!state) throw conflict('Performance changed or a refresh is running. Refresh the page and try again.', { code: 'COMPASS_REVISION_CONFLICT' });
  try {
    const { unchanged = false, ...patch } = await work(state, ctx);
    // Calculations consult the lock; invalidate editable statements before
    // publishing the new pointer/revision. Frozen statement snapshots stay intact.
    if (!unchanged) await Vdp.updateMany({ cycleId, status: { $in: EDITABLE } }, { $set: { stale: true }, $addToSet: { staleReasons: 'Compass performance or a manual correction changed.' } });
    const committed = await CompassPerformanceState.updateOne({ _id: state._id, revision: expectedRevision, lock }, {
      $set: { ...patch, lock: null, lockUntil: null }, $inc: { revision: unchanged ? 0 : 1 },
    });
    if (!committed.modifiedCount) throw conflict('Performance revision changed. Refresh and try again.');
    return await compassPerformanceView(cycleId);
  } catch (error) {
    await CompassPerformanceState.updateOne({ _id: state._id, lock }, { $set: { lock: null, lockUntil: null } });
    throw error;
  }
}

export async function syncCompassPerformance(cycleId, { expectedRevision, user, request } = {}) {
  let staged = null;
  const view = await mutate(cycleId, expectedRevision, async (state, { cycle, divisions }) => {
    const at = new Date();
    await CompassPerformanceState.updateOne({ _id: state._id, lock: state.lock }, { $set: { lastAttemptAt: at } });
    try {
      if (!compassConfigView().configured) throw badRequest('Compass connection is not configured.');
      if (!divisions.some((d) => d.source?.system === 'COMPASS' && d.source.externalId)) throw badRequest('This program has no Compass-linked divisions.');
      const from = isoDate(cycle.cycleStart), to = isoDate(cycle.cycleEnd);
      const data = await fetchCompassPerformance({ divisions, from, to, request });
      const checksum = hashPerformance(data.rows);
      const previous = state.activeImportId ? await PerformanceImport.findById(state.activeImportId) : null;
      if (previous?.fileHash === checksum) return { unchanged: true, lastSyncedAt: at, lastError: null };
      staged = await PerformanceImport.create({
        cycleId, divisionId: cycle.divisionId, kind: 'COMPASS', datasetType: 'COMPASS_PERFORMANCE', status: 'STAGED',
        originalFileName: `Compass performance ${from} to ${to}`, fileHash: checksum, uploadedBy: actor(user),
        reportRange: { from, to }, dataRange: data.rows.length ? { from: data.rows.map((r) => r.date).sort()[0], to: data.rows.map((r) => r.date).sort().at(-1) } : null,
        datesDetected: [...new Set(data.rows.map((r) => r.date))].sort(), rowCount: data.rows.length,
        stats: { sourceSystem: 'COMPASS', adapterVersion: 'COMPASS_V1', retrievedAt: at, divisions: data.summaries },
        supersedesImportId: previous?._id || null,
      });
      for (let offset = 0; offset < data.rows.length; offset += 1000) {
        await NormalizedFact.insertMany(data.rows.slice(offset, offset + 1000).map((row, index) => ({
          importId: staged._id, cycleId, divisionId: row.divisionId, datasetType: 'COMPASS_PERFORMANCE', factType: 'PERFORMANCE',
          sequence: offset + index, date: row.date, route: row.route, sourceIdentity: row.externalOperatorId, payload: row,
        })));
      }
      staged.status = 'ACTIVE';
      await staged.save();
      return { activeImportId: staged._id, lastSyncedAt: at, lastError: null };
    } catch (error) {
      if (staged) await PerformanceImport.updateOne({ _id: staged._id }, { $set: { status: 'INVALID', processingErrors: [error.message] } });
      await CompassPerformanceState.updateOne({ _id: state._id, lock: state.lock }, { $set: { lastError: error.message } });
      throw error;
    }
  });
  if (staged) {
    await PerformanceImport.updateMany({ cycleId, kind: 'COMPASS', status: 'ACTIVE', _id: { $ne: staged._id } }, { $set: { status: 'REPLACED', replacedAt: new Date(), replacedBy: actor(user), replaceReason: 'Compass refresh', supersededByImportId: staged._id } });
    await recordAudit({ action: 'COMPASS_PERFORMANCE_SYNC', entityType: 'PerformanceImport', entityId: staged._id, user, metadata: { cycleId, revision: view.revision, rowCount: staged.rowCount } });
  }
  return view;
}

export async function ensureCompassPerformance(cycleId, user) {
  const view = await compassPerformanceView(cycleId);
  if (!view.available || view.attempted || view.locked || view.refreshing) return view;
  try { return await syncCompassPerformance(cycleId, { expectedRevision: view.revision, user }); }
  catch { return compassPerformanceView(cycleId); } // persisted failure is shown; file fallback remains available
}

export async function correctCompassPerformance(cycleId, input, user) {
  const reason = String(input.reason || '').trim();
  if (!reason) throw badRequest('Give a reason for the performance correction.');
  if (!['CORRECT', 'RETAIN', 'REVERT'].includes(input.action || 'CORRECT')) throw badRequest('Unknown correction action.');
  const action = input.action || 'CORRECT';
  const result = await mutate(cycleId, input.expectedRevision, async (state) => {
    const view = await compassPerformanceView(cycleId);
    const row = view.rows.find((r) => r.rowKey === input.rowKey);
    const old = state.corrections.find((c) => c.rowKey === input.rowKey);
    if (!row && !(action === 'REVERT' && old?.active)) throw notFound('Compass performance record');
    if (row?.providerId && await Vdp.exists({ cycleId, providerId: row.providerId, status: { $nin: EDITABLE } })) throw conflict('Reopen this provider statement before correcting its performance.');
    if (action !== 'CORRECT' && !old?.active) throw badRequest('This record has no active correction.');
    const values = { ...(old?.active ? old.values : {}) };
    let assignment = old?.active ? old.assignment : null;
    if (action === 'CORRECT') {
      for (const field of ['trips', 'serviceHours']) if (Object.hasOwn(input.values || {}, field)) values[field] = metricValue(input.values[field], field);
      if (input.assignment) {
        const provider = await Provider.findOne({ _id: input.assignment.providerId, divisionId: row.divisionId });
        const operator = provider && activeOperators(provider).find((o) => o.id === input.assignment.operatorId && worksOn(o, row.date));
        if (!operator) throw badRequest('Choose an operator who belongs to this division and provider on the service date.');
        if (await Vdp.exists({ cycleId, providerId: provider._id, status: { $nin: EDITABLE } })) throw conflict('Reopen the destination provider statement before changing its assignment.');
        assignment = { providerId: String(provider._id), operatorId: operator.id };
      }
      if (!Object.keys(values).length && !assignment) throw badRequest('Enter corrected trips or service hours, or resolve the operator assignment.');
    }
    const original = row?.original || old.original;
    const sourceRow = { ...(row || old.sourceRow) };
    delete sourceRow.correction;
    const history = [...(old?.history || []), { action, reason, by: actor(user), at: new Date(), original, before: old?.active ? old.values : null, after: action === 'REVERT' ? null : values, assignment, revision: input.expectedRevision + 1 }];
    const correction = { rowKey: input.rowKey, active: action !== 'REVERT', values, assignment, original, sourceRow, baseline: row?.missingFromSource ? 'MISSING' : row?.fingerprint, reason, history };
    return { corrections: [...state.corrections.filter((c) => c.rowKey !== input.rowKey), correction] };
  });
  await recordAudit({ action: `COMPASS_PERFORMANCE_${action}`, entityType: 'VdpCycle', entityId: cycleId, reason, user, metadata: { rowKey: input.rowKey, revision: result.revision, values: input.values } });
  return result;
}

// Only performance-only source slots may be replaced. Duty/manifest/fare feeds
// retain their source-specific semantics and additional required fields.
const REPLACEABLE = { '5': 'DIV5_RPR', '6': 'DIV6_TRAPEZE', '7': 'DIV7_DAILY_PRODUCTIVITY', '10': 'DIV10_TRAPEZE_HOURS' };
export async function compassDatasetReplacement(cycle, division, suppliedView) {
  const datasetType = REPLACEABLE[String(division.divisionNumber)];
  if (!datasetType) return null;
  if (!suppliedView && !await CompassPerformanceState.exists({ cycleId: cycle._id, activeImportId: { $ne: null } })) return null;
  const view = suppliedView || await compassPerformanceView(cycle._id);
  const coverage = view.coverage.find((c) => c.divisionId === String(division._id));
  if (!view.loaded || view.refreshing || view.conflictCount || !coverage || coverage.missingDates.length) return null;
  const rows = view.rows.filter((r) => r.divisionId === String(division._id));
  if (!rows.length || rows.some((r) => r.assignmentIssue)) return null;
  const providers = await Provider.find({ divisionId: division._id, status: 'ACTIVE' });
  const plans = new Map((await VdpPlan.find({ divisionId: division._id })).map((p) => [String(p._id), p]));
  if (!providers.length) return null;
  for (const provider of providers) {
    for (const operator of activeOperators(provider, cycle)) {
      const plan = plans.get(operator.planId || String(provider.planId));
      const version = plan && resolveVersion(plan, cycle).version;
      if (!version) return null;
      const ownPlan = operator.planId && operator.planId !== String(provider.planId);
      const settings = resolveSettings(ownPlan ? { overrides: {} } : provider, plan, version);
      if (settings.calculationType?.value === 'UBER') continue;
      if (['SERVICE_MILE_ALLOWANCE', 'PRICE_THRESHOLD_SURCHARGE'].includes(settings.fuelMethod?.value)) return null;
      if ((settings.rateCards?.value || []).some((card) => card.components.some((c) => ['MILES', 'EXCESS_MILES'].includes(c.basis)))) return null;
      const metrics = needsPaidHours(settings) ? [settings.performanceHourMetric?.value] : [];
      const attainment = settings.attainmentHourMetric?.value;
      if (needsAttainmentHours(settings)) metrics.push(attainment && attainment !== 'SAME_AS_PAID' ? attainment : settings.performanceHourMetric?.value);
      for (const metric of metrics) {
        // DIV 10 total hours and OTHER window hours come from its manifest feed.
        if (String(division.divisionNumber) === '10' && ['TOTAL_HOURS', 'OTHER'].includes(metric)) continue;
        const field = { SERVICE_HOURS: 'serviceHours', REVENUE_HOURS: 'revenueHours' }[metric];
        if (!field || rows.some((r) => unusableHour(r[field]))) return null;
      }
    }
  }
  return { datasetType, view, rows: mergeCompassRows([], rows), dates: coverage.dates };
}

export async function withCompassPerformance(cycle, fallbackDoc, suppliedView) {
  if (!suppliedView && !await CompassPerformanceState.exists({ cycleId: cycle._id, activeImportId: { $ne: null } })) return fallbackDoc;
  const view = suppliedView || await compassPerformanceView(cycle._id);
  if (!view.importId) return fallbackDoc;
  if (!view.loaded && !view.rows.length && !fallbackDoc?.rows?.some((row) => row.compassDerived)) return fallbackDoc;
  const fallback = fallbackDoc?.toObject ? fallbackDoc.toObject({ getters: true }) : fallbackDoc;
  const rows = mergeCompassRows(fallback?.rows || [], view.rows);
  return {
    ...(fallback || {}), _id: fallback?._id || view.importId, cycleId: cycle._id, divisionId: cycle.divisionId,
    originalFileName: fallback?.originalFileName || 'Compass performance', uploadedAt: view.lastSyncedAt,
    uploadedBy: { name: 'Compass' }, rowCount: rows.length,
    dataRange: rows.length ? { from: rows.map((r) => r.date).sort()[0], to: rows.map((r) => r.date).sort().at(-1) } : null,
    rows, routeResolutions: fallback?.routeResolutions || [],
    detectedColumns: {
      ...fallback?.detectedColumns,
      SERVICE_HOURS: rows.some((r) => r.serviceHours != null), REVENUE_HOURS: rows.some((r) => r.revenueHours != null),
    },
    compassView: view,
    stats: { ...fallback?.stats, compassImportId: view.importId, compassRevision: view.revision },
  };
}

export async function assertCompassRevision(cycleId, revision) {
  if (revision === undefined || revision === null) return;
  const state = await CompassPerformanceState.findOne({ cycleId }).lean();
  if (state?.lock || state?.revision !== revision) throw conflict('Compass performance changed during calculation. Recalculate using the latest data.');
}

export async function withCompassApprovalLock(cycleId, revision, save) {
  if (revision === null || revision === undefined) return save();
  const lock = crypto.randomUUID();
  const state = await CompassPerformanceState.findOneAndUpdate({
    cycleId, revision, $or: [{ lock: null }, { lockUntil: { $lte: new Date() } }],
  }, { $set: { lock, lockUntil: new Date(Date.now() + 60000) } }, { returnDocument: 'after' });
  if (!state) throw conflict('Compass performance changed or is refreshing. Recalculate before approving.');
  try { return await save(); }
  finally { await CompassPerformanceState.updateOne({ _id: state._id, lock }, { $set: { lock: null, lockUntil: null } }); }
}

export const compassSummary = (view) => {
  const { rows, correctionHistory, ...rest } = view;
  return { ...rest, rowCount: rows.length, correctedCount: rows.filter((r) => r.correction).length };
};
