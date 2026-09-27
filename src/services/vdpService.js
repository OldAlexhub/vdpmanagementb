// VDP lifecycle: process → review → approve (snapshot) → paid, with reopen.
import Vdp, { ISSUE_AREAS } from '../models/Vdp.js';
import Provider from '../models/Provider.js';
import VdpPlan from '../models/VdpPlan.js';
import VdpCycle from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import { calculateVdp, serializeResult, CalculationError, ADJUSTMENT_TYPES } from './calculationEngine.js';
import { resolveVersion, resolveSettings, engineSettings, validateVersion } from './planService.js';
import { activeImportFor, matchRoutes, unresolvedRoutes } from './performanceService.js';
import { hoursForMetric, HOUR_METRICS } from './performanceParser.js';
import { weekOf, isoDate, endOfDayIn } from './cycleService.js';
import { activeOperators, operatorsOf } from './operators.js';
import { D, sum, isBlank, str, fmtMoney, fmtRate, fmtNum } from './money.js';
import { badRequest, conflict, notFound, actor } from './errors.js';

const EDITABLE = ['DRAFT', 'NEEDS_REVIEW', 'READY'];
const ACKNOWLEDGEABLE = new Set(['NO_PERFORMANCE_DATA', 'PLAN_CHANGES_MID_CYCLE']);

const exception = (code, message) => ({ code, message, acknowledgeable: ACKNOWLEDGEABLE.has(code) });

function cycleInfo(cycle) {
  return {
    id: cycle._id,
    cycleStart: isoDate(cycle.cycleStart),
    cycleEnd: isoDate(cycle.cycleEnd),
    week1: { start: isoDate(cycle.week1Start), end: isoDate(cycle.week1End) },
    week2: { start: isoDate(cycle.week2Start), end: isoDate(cycle.week2End) },
    submissionDate: cycle.submissionDate ? isoDate(cycle.submissionDate) : null,
    paymentDate: cycle.paymentDate ? isoDate(cycle.paymentDate) : null,
  };
}

const weekTotals = (days, cycle) => [1, 2].map((n) => {
  const rows = days.filter((d) => d.week === n);
  return {
    weekNumber: n,
    start: n === 1 ? isoDate(cycle.week1Start) : isoDate(cycle.week2Start),
    end: n === 1 ? isoDate(cycle.week1End) : isoDate(cycle.week2End),
    days: rows.length,
    trips: sum(rows.map((d) => d.trips)).toString(),
    actualHours: sum(rows.map((d) => d.hours ?? 0)).toString(),
  };
});

// Gather this provider's report rows and total them by week — overall and per operator.
// A route matched to the provider but on none of its operators is reported, not guessed
// (unless the provider has a single operator, who then runs every route).
function providerPerformance({ provider, cycle, importDoc, matches, metric, otherColumn }) {
  const routes = matches
    .filter((m) => ['MATCHED', 'ASSIGNED'].includes(m.status) && String(m.providerId) === String(provider._id))
    .map((m) => m.route);
  const ops = activeOperators(provider);
  const operatorOfRoute = new Map(ops.flatMap((o) => o.routes.map((r) => [r, o.id])));
  const operatorFor = (route) => operatorOfRoute.get(route) ?? (ops.length === 1 ? ops[0].id : null);
  const days = importDoc.rows
    .filter((r) => routes.includes(r.route))
    .map((r) => ({
      date: r.date,
      route: r.route,
      operatorId: operatorFor(r.route),
      week: weekOf(r.date, cycle),
      trips: str(r.trips) ?? '0',
      hours: str(hoursForMetric(r, metric, otherColumn)),
    }))
    .filter((d) => d.week);
  const operators = ops.map((o) => {
    const own = days.filter((d) => d.operatorId === o.id);
    return {
      id: o.id,
      name: o.name,
      routes: [...new Set(own.map((d) => d.route))],
      contractedHours: o.contractedHours,
      liftLease: o.liftLease,
      weeks: weekTotals(own, cycle),
    };
  });
  const unassignedRoutes = [...new Set(days.filter((d) => !d.operatorId).map((d) => d.route))];
  return { routes, days, weeks: weekTotals(days, cycle), operators, unassignedRoutes, metric, metricLabel: HOUR_METRICS[metric]?.label || otherColumn };
}

/** Recompute a VDP from current provider, plan, report and reviewer inputs. Does not save. */
export async function computeVdp(vdp, preloaded = {}) {
  const provider = preloaded.provider || (await Provider.findById(vdp.providerId));
  const cycle = preloaded.cycle || (await VdpCycle.findById(vdp.cycleId));
  const importDoc = preloaded.importDoc !== undefined ? preloaded.importDoc : await activeImportFor(vdp.cycleId);
  const exceptions = [];

  let plan = null;
  let version = null;
  let settings = null;
  if (!provider.planId) {
    exceptions.push(exception('NO_PLAN', `${provider.name} has no VDP plan assigned. Assign a plan on the provider profile.`));
  } else {
    plan = preloaded.plans?.get(String(provider.planId)) || (await VdpPlan.findById(provider.planId));
    if (!plan) {
      exceptions.push(exception('NO_PLAN', `The VDP plan assigned to ${provider.name} no longer exists.`));
    } else {
      const resolved = resolveVersion(plan, cycle);
      version = resolved.version;
      if (!version) {
        exceptions.push(exception('PLAN_NOT_EFFECTIVE',
          `Plan "${plan.name}" has no version effective on ${isoDate(cycle.cycleStart)}. Add or extend a plan version.`));
      } else {
        if (resolved.changesMidCycle) {
          exceptions.push(exception('PLAN_CHANGES_MID_CYCLE',
            `Plan "${plan.name}" changes rates inside this cycle. Version ${version.versionNumber} (effective on the cycle start) was used.`));
        }
        const versionErrors = validateVersion(version);
        if (versionErrors.length) {
          const tierError = versionErrors.some((e) => /tier/i.test(e));
          exceptions.push(exception(tierError ? 'INVALID_INCENTIVE_TIERS' : 'INVALID_PLAN',
            `Plan "${plan.name}" v${version.versionNumber} is not valid: ${versionErrors.join(' ')}`));
        }
        settings = resolveSettings(provider, plan, version);
        const s = engineSettings(settings);
        if (s.tuiEligible && s.incentiveTiers.length === 0) {
          exceptions.push(exception('TUI_WITHOUT_TIERS',
            `TUI is switched on for ${provider.name}, but plan "${plan.name}" has no incentive tiers.`));
        }
        const noContract = activeOperators(provider).filter((o) => isBlank(o.contractedHours))
          .filter(() => isBlank(s.contractedHours) || D(s.contractedHours).lte(0));
        if (s.paymentType === 'HOURLY' && noContract.length) {
          exceptions.push(exception('MISSING_CONTRACTED_HOURS', `Contracted hours are missing for ${provider.name}${noContract.length < activeOperators(provider).length ? ` (operator ${noContract.map((o) => o.name).join(', ')})` : ''}.`));
        }
      }
    }
  }

  for (const o of activeOperators(provider)) {
    const lease = o.liftLease;
    if (lease.frequency !== 'NONE' && isBlank(lease.amount)) {
      exceptions.push(exception('MISSING_LEASE_AMOUNT', `${o.name} (${provider.name}) has a ${lease.frequency.toLowerCase()} lift lease with no amount.`));
    }
  }
  if (!activeOperators(provider).length) {
    exceptions.push(exception('NO_OPERATORS', `${provider.name} has no active operators. Add one on the provider profile.`));
  }

  let performance = null;
  if (!importDoc) {
    exceptions.push(exception('NO_PERFORMANCE_IMPORT', 'No Performance Report has been uploaded for this cycle.'));
  } else if (settings) {
    const metric = settings.performanceHourMetric.value;
    const otherColumn = settings.performanceHourColumn.value;
    const available = metric === 'OTHER'
      ? (importDoc.detectedColumns?.otherHourColumns || []).includes(otherColumn)
      : importDoc.detectedColumns?.[metric];
    if (!available) {
      exceptions.push(exception('METRIC_NOT_IN_REPORT',
        `The plan pays on "${HOUR_METRICS[metric]?.label || otherColumn}", which is not in the uploaded report.`));
    }
    const matches = preloaded.matches || matchRoutes(importDoc, await Provider.find({ divisionId: provider.divisionId }));
    performance = providerPerformance({ provider, cycle, importDoc, matches, metric, otherColumn });
    if (performance.unassignedRoutes.length) {
      exceptions.push(exception('ROUTE_WITHOUT_OPERATOR',
        `Route ${performance.unassignedRoutes.join(', ')} is matched to ${provider.name} but not to any of its operators. Add it to an operator on the provider profile.`));
    }
    if (performance.days.length === 0) {
      const routeText = provider.routes.length ? `route ${provider.routes.join(', ')}` : 'no routes on the profile';
      exceptions.push(exception('NO_PERFORMANCE_DATA',
        `No Performance Report rows for ${provider.name} (${routeText}) in this cycle.`));
    }
  }

  let calculation = null;
  const blocking = exceptions.filter((e) => !['NO_PERFORMANCE_DATA', 'PLAN_CHANGES_MID_CYCLE'].includes(e.code));
  if (settings && performance && blocking.length === 0) {
    try {
      calculation = serializeResult(calculateVdp({
        settings: engineSettings(settings),
        operators: performance.operators.map((o) => ({
          name: o.name,
          routes: o.routes,
          contractedHours: o.contractedHours,
          weeks: o.weeks,
          lease: { ...o.liftLease, weeksCharged: str(vdp.leaseWeeksCharged) },
        })),
        adjustments: vdp.adjustments.map((a) => ({ type: a.type, amount: str(a.amount) })),
      }));
    } catch (err) {
      if (!(err instanceof CalculationError)) throw err;
      exceptions.push(exception('CALCULATION_ERROR', err.message));
    }
  }

  const acknowledged = new Set(vdp.acknowledgements.map((a) => a.code));
  const open = exceptions.filter((e) => !(e.acknowledgeable && acknowledged.has(e.code)));
  const status = open.length || !calculation ? 'NEEDS_REVIEW' : 'READY';

  return { provider, plan, version, cycle, settings, performance, calculation, exceptions, status, importDoc };
}

function applyComputation(vdp, c) {
  vdp.planId = c.plan?._id ?? null;
  vdp.planVersionId = c.version?._id ?? null;
  vdp.performanceImportId = c.importDoc?._id ?? null;
  vdp.settings = c.settings;
  vdp.performance = c.performance;
  vdp.calculation = c.calculation;
  vdp.gross = c.calculation?.gross ?? null;
  vdp.net = c.calculation?.net ?? null;
  vdp.exceptions = c.exceptions;
  vdp.status = c.status;
  vdp.calculatedAt = new Date();
  vdp.stale = false;
}

export async function processCycle(cycleId, user) {
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const importDoc = await activeImportFor(cycle._id);
  if (!importDoc) throw badRequest('Upload the Performance Report for this cycle before processing VDPs.');

  const providers = await Provider.find({ divisionId: cycle.divisionId });
  const matches = matchRoutes(importDoc, providers);
  const unresolved = unresolvedRoutes(matches);
  if (unresolved.length) {
    throw conflict(
      `${unresolved.length} route(s) in the Performance Report need review before VDPs can be processed.`,
      { code: 'UNRESOLVED_ROUTES', routes: unresolved },
    );
  }

  const plans = new Map((await VdpPlan.find({ divisionId: cycle.divisionId })).map((p) => [String(p._id), p]));
  const expected = providers.filter((p) => p.status === 'ACTIVE');
  const counts = { processed: 0, ready: 0, needsReview: 0, skippedLocked: 0 };

  for (const provider of expected) {
    let vdp = await Vdp.findOne({ providerId: provider._id, cycleId: cycle._id });
    if (vdp && !EDITABLE.includes(vdp.status)) {
      counts.skippedLocked += 1;
      continue;
    }
    const isNew = !vdp;
    vdp ||= new Vdp({ providerId: provider._id, divisionId: cycle.divisionId, cycleId: cycle._id });
    const c = await computeVdp(vdp, { provider, cycle, importDoc, matches, plans });
    applyComputation(vdp, c);
    vdp.history.push({ action: isNew ? 'PROCESSED' : 'RECALCULATED', by: actor(user) });
    await vdp.save();
    counts.processed += 1;
    if (vdp.status === 'READY') counts.ready += 1; else counts.needsReview += 1;
  }
  await syncCycleStatus(cycle._id);
  return counts;
}

async function loadEditable(id) {
  const vdp = await Vdp.findById(id);
  if (!vdp) throw notFound('VDP');
  if (!EDITABLE.includes(vdp.status)) {
    throw conflict(`This VDP is ${vdp.status.toLowerCase()}. Reopen it before making changes.`);
  }
  return vdp;
}

async function recalcAndSave(vdp, user, action, reason) {
  applyComputation(vdp, await computeVdp(vdp));
  vdp.history.push({ action, reason, by: actor(user) });
  await vdp.save();
  await syncCycleStatus(vdp.cycleId);
  return vdp;
}

export async function recalculate(id, user) {
  return recalcAndSave(await loadEditable(id), user, 'RECALCULATED');
}

export async function addAdjustment(id, input, user) {
  const vdp = await loadEditable(id);
  if (!ADJUSTMENT_TYPES[input.type]) throw badRequest('Choose an adjustment type.');
  if (isBlank(input.amount) || !/^\d+(\.\d+)?$/.test(String(input.amount).trim()) || D(input.amount).lte(0)) {
    throw badRequest('Enter a positive amount. The type decides whether it is deducted or added.');
  }
  if (D(input.amount).decimalPlaces() > 2) throw badRequest('Amounts are in dollars and cents (max 2 decimals).');
  vdp.adjustments.push({
    type: input.type,
    amount: String(input.amount).trim(),
    description: input.description,
    date: input.date || new Date(),
    createdBy: actor(user),
  });
  return recalcAndSave(vdp, user, 'ADJUSTMENT_ADDED',
    `${ADJUSTMENT_TYPES[input.type].label} $${D(input.amount).toFixed(2)}${input.description ? ` — ${input.description}` : ''}`);
}

export async function removeAdjustment(id, adjustmentId, user) {
  const vdp = await loadEditable(id);
  const adj = vdp.adjustments.id(adjustmentId);
  if (!adj) throw notFound('Adjustment');
  const text = `${ADJUSTMENT_TYPES[adj.type].label} $${D(adj.amount).toFixed(2)}`;
  adj.deleteOne();
  return recalcAndSave(vdp, user, 'ADJUSTMENT_REMOVED', text);
}

export async function setLeaseWeeks(id, { weeksCharged, note }, user) {
  const vdp = await loadEditable(id);
  if (isBlank(weeksCharged)) {
    vdp.leaseWeeksCharged = null;
  } else {
    if (!/^\d+(\.\d+)?$/.test(String(weeksCharged)) || D(weeksCharged).gt(2)) {
      throw badRequest('Weeks charged must be between 0 and 2.');
    }
    if (!String(note || '').trim()) throw badRequest('Give a reason for changing the lease weeks charged.');
    vdp.leaseWeeksCharged = String(weeksCharged);
  }
  vdp.leaseNote = note;
  return recalcAndSave(vdp, user, 'LEASE_CHANGED',
    isBlank(weeksCharged) ? 'Lease reset to all weeks in the cycle' : `Lease weeks charged: ${weeksCharged}. ${note}`);
}

export async function acknowledge(id, { code, note }, user) {
  const vdp = await loadEditable(id);
  if (!ACKNOWLEDGEABLE.has(code)) throw badRequest('This issue must be fixed at its source, not acknowledged.');
  if (!String(note || '').trim()) throw badRequest('Explain why this is acceptable.');
  vdp.acknowledgements = vdp.acknowledgements.filter((a) => a.code !== code);
  vdp.acknowledgements.push({ code, note, by: actor(user) });
  return recalcAndSave(vdp, user, 'EXCEPTION_ACKNOWLEDGED', `${code}: ${note}`);
}

// Lift lease as shown on the VDP: one entry per active operator. amount/frequency are kept
// for single-operator providers (and older screens).
function leaseView(provider, vdp) {
  const operators = activeOperators(provider).map((o) => ({ name: o.name, amount: o.liftLease.amount, frequency: o.liftLease.frequency }));
  const only = operators.length === 1 ? operators[0] : null;
  return {
    amount: only ? only.amount : null,
    frequency: only ? only.frequency : operators.some((o) => o.frequency !== 'NONE') ? 'PER_OPERATOR' : 'NONE',
    operators,
    weeksCharged: str(vdp.leaseWeeksCharged),
    note: vdp.leaseNote,
  };
}

const providerView = (p, routes) => ({
  id: p._id,
  name: p.name,
  providerNumber: p.providerNumber,
  operatorName: p.operatorName,
  routes: routes?.length ? routes : p.routes,
  serviceType: p.serviceType,
  operators: operatorsOf(p).map((o) => ({ name: o.name, routes: o.routes, status: o.status })),
});

async function buildSnapshot(vdp, c, user) {
  const division = await Division.findById(vdp.divisionId);
  return {
    capturedAt: new Date(),
    provider: providerView(c.provider, c.performance?.routes),
    division: { id: division._id, divisionNumber: division.divisionNumber, name: division.name, location: division.location, timezone: division.timezone },
    cycle: cycleInfo(c.cycle),
    plan: { id: c.plan._id, name: c.plan.name, versionId: c.version._id, versionNumber: c.version.versionNumber },
    settings: c.settings,
    lease: leaseView(c.provider, vdp),
    performance: c.performance,
    performanceImport: c.importDoc
      ? { id: c.importDoc._id, fileName: c.importDoc.originalFileName, fileHash: c.importDoc.fileHash, uploadedAt: c.importDoc.uploadedAt }
      : null,
    adjustments: vdp.adjustments.map((a) => ({
      type: a.type, amount: str(a.amount), description: a.description, date: a.date, createdBy: a.createdBy, createdAt: a.createdAt,
    })),
    acknowledgements: vdp.acknowledgements,
    calculation: c.calculation,
    gross: c.calculation.gross,
    net: c.calculation.net,
    calculatedAt: new Date(),
    approvedAt: new Date(),
    approvedBy: actor(user),
  };
}

// Big Star approval: freezes the snapshot and sends the VDP to the provider for approval.
export async function approve(id, user) {
  const vdp = await loadEditable(id);
  const c = await computeVdp(vdp); // never approve stale numbers
  applyComputation(vdp, c);
  if (vdp.status !== 'READY') {
    await vdp.save();
    throw conflict('This VDP still needs review and cannot be approved.', { exceptions: vdp.exceptions });
  }
  const division = await Division.findById(vdp.divisionId);
  vdp.snapshot = await buildSnapshot(vdp, c, user);
  vdp.status = 'APPROVED';
  vdp.approvedAt = vdp.snapshot.approvedAt;
  vdp.approvedBy = actor(user);
  const corrected = vdp.issues.filter((i) => i.status === 'IN_CORRECTION');
  corrected.forEach((i) => {
    i.status = 'RESOLVED';
    i.response.at = new Date();
    i.response.newNet = c.calculation.net;
  });
  vdp.providerDeadline = providerDeadlineFor(c.cycle, division, corrected.length > 0);
  vdp.providerApproval = { method: null };
  vdp.history.push({
    action: 'APPROVED',
    by: actor(user),
    reason: corrected.length ? 'Corrected and sent back to the provider for approval' : 'Sent to provider for approval',
  });
  await vdp.save();
  await autoApproveDue(); // approved after the deadline → processed straight away
  await syncCycleStatus(vdp.cycleId);
  return Vdp.findById(vdp._id);
}

// After Big Star answers a provider issue the provider always gets at least this long to review again.
export const ISSUE_RESPONSE_WINDOW_HOURS = 48;

function providerDeadlineFor(cycle, division, afterIssue) {
  const base = cycle.submissionDate ? endOfDayIn(cycle.submissionDate, division?.timezone) : null;
  if (!afterIssue) return base;
  const grace = new Date(Date.now() + ISSUE_RESPONSE_WINDOW_HOURS * 3600 * 1000);
  return !base || grace > base ? grace : base;
}

// The value the statement shows for an issue line (computed from the frozen snapshot).
function shownValue(snapshot, item) {
  const calc = snapshot?.calculation;
  const w = item.week ? calc?.weeks?.[item.week - 1] : null;
  const both = (fn) => calc?.weeks?.map((x) => `W${x.weekNumber}: ${fn(x)}`).join(' · ');
  const pick = (fn) => (w ? fn(w) : both(fn));
  switch (item.area) {
    case 'TRIPS': return pick((x) => `${fmtNum(x.trips)} trips`);
    case 'HOURS': return pick((x) => `${fmtNum(x.actualHours)} h`);
    case 'CONTRACTED_HOURS': return pick((x) => `${fmtNum(x.contractedHours)} h`);
    case 'RATE': return pick((x) => `${fmtRate(x.incentiveRate)} (${x.tierLabel})`);
    case 'BONUS': return pick((x) => `${fmtNum(x.bonusHours)} h = ${fmtMoney(x.bonusEarnings)}`);
    case 'LIFT_LEASE': return fmtMoney(calc?.lease);
    case 'FARES': return fmtMoney(calc?.fares);
    case 'ADJUSTMENT': {
      const a = snapshot?.adjustments?.[item.adjustmentIndex];
      return a ? `${a.type.replace(/_/g, ' ').toLowerCase()} ${fmtMoney(a.amount)}${a.description ? ` — ${a.description}` : ''}` : null;
    }
    default: return null;
  }
}

// Provider reports what is wrong and why. Pauses auto-approval until Big Star responds.
export async function raiseIssue(id, { items, comment }, user) {
  await autoApproveDue();
  const vdp = await Vdp.findOne({ _id: id, providerId: user.providerId });
  if (!vdp) throw notFound('VDP');
  if (vdp.status === 'DISPUTED') throw conflict('You already reported an issue on this statement. Big Star will respond.');
  if (vdp.status !== 'APPROVED') {
    throw conflict(vdp.status === 'PROCESSED' || vdp.status === 'PAID'
      ? 'This statement is already approved. Please contact Big Star directly.'
      : 'This statement is not open for review.');
  }
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Tell us at least one thing that is wrong.');
  if (items.length > 20) throw badRequest('Please report at most 20 lines at once.');
  const clean = items.map((it, i) => {
    const n = items.length > 1 ? ` (line ${i + 1})` : '';
    if (!ISSUE_AREAS[it.area]) throw badRequest(`Choose what is wrong${n}.`);
    const week = it.week === 1 || it.week === 2 || it.week === '1' || it.week === '2' ? Number(it.week) : null;
    const adjustmentIndex = it.area === 'ADJUSTMENT' ? Number(it.adjustmentIndex) : null;
    if (it.area === 'ADJUSTMENT' && !vdp.snapshot?.adjustments?.[adjustmentIndex]) throw badRequest(`Choose which deduction or addition is wrong${n}.`);
    const reason = String(it.reason || '').trim();
    if (reason.length < 5) throw badRequest(`Explain why it is wrong${n}.`);
    const item = { area: it.area, week, adjustmentIndex, expectedValue: String(it.expectedValue || '').trim().slice(0, 200), reason: reason.slice(0, 2000) };
    return { ...item, shownValue: shownValue(vdp.snapshot, item) };
  });
  vdp.issues.push({
    items: clean,
    comment: String(comment || '').trim().slice(0, 2000),
    raisedBy: actor(user),
    netAtRaise: vdp.snapshot?.net,
  });
  vdp.status = 'DISPUTED';
  vdp.history.push({
    action: 'ISSUE_RAISED',
    by: actor(user),
    reason: clean.map((i) => `${ISSUE_AREAS[i.area]}${i.week ? ` (week ${i.week})` : ''}: ${i.reason}`).join(' | '),
  });
  await vdp.save();
  await syncCycleStatus(vdp.cycleId);
  return vdp;
}

// Big Star answers without changing the statement; it goes back to the provider.
export async function respondToIssue(id, { message }, user) {
  const vdp = await Vdp.findById(id);
  if (!vdp) throw notFound('VDP');
  if (vdp.status !== 'DISPUTED') throw conflict('There is no open provider issue on this VDP.');
  if (String(message || '').trim().length < 5) throw badRequest('Explain to the provider why the statement is correct.');
  const issue = vdp.issues.find((i) => i.status === 'OPEN');
  issue.status = 'RESOLVED';
  issue.response = { action: 'NO_CHANGE', message: message.trim(), by: actor(user), at: new Date(), newNet: vdp.snapshot?.net };
  const [cycle, division] = await Promise.all([VdpCycle.findById(vdp.cycleId), Division.findById(vdp.divisionId)]);
  vdp.status = 'APPROVED';
  vdp.providerDeadline = providerDeadlineFor(cycle, division, true);
  vdp.history.push({ action: 'ISSUE_ANSWERED', by: actor(user), reason: message.trim() });
  await vdp.save();
  await syncCycleStatus(vdp.cycleId);
  return vdp;
}

function markProcessed(vdp, method, by, at = new Date()) {
  vdp.status = 'PROCESSED';
  vdp.providerApproval = { method, at, by };
  vdp.history.push(method === 'AUTO'
    ? { action: 'AUTO_APPROVED', by, at, reason: 'No provider response by the Closed for Submission date' }
    : { action: 'PROVIDER_APPROVED', by, at });
}

// Provider approval from the portal: only their own VDP, only while the window is open.
export async function providerApprove(id, user) {
  await autoApproveDue();
  const vdp = await Vdp.findOne({ _id: id, providerId: user.providerId });
  if (!vdp) throw notFound('VDP');
  if (vdp.status === 'PROCESSED' || vdp.status === 'PAID') {
    throw conflict(vdp.providerApproval?.method === 'AUTO'
      ? 'The submission deadline has passed, so this VDP was approved automatically.'
      : 'This VDP is already approved.');
  }
  if (vdp.status !== 'APPROVED') throw conflict('This VDP is not ready for your approval.');
  markProcessed(vdp, 'PROVIDER', actor(user));
  await vdp.save();
  await syncCycleStatus(vdp.cycleId);
  return vdp;
}

// Auto-approve every VDP whose provider deadline has passed. Idempotent; safe to run any time.
export async function autoApproveDue(now = new Date()) {
  const due = await Vdp.find({ status: 'APPROVED', providerDeadline: { $ne: null, $lte: now } });
  const cycles = new Set();
  for (const vdp of due) {
    markProcessed(vdp, 'AUTO', { name: 'System' }, now);
    await vdp.save();
    cycles.add(String(vdp.cycleId));
  }
  for (const cycleId of cycles) await syncCycleStatus(cycleId);
  return due.length;
}

export async function reopen(id, { reason }, user) {
  const vdp = await Vdp.findById(id);
  if (!vdp) throw notFound('VDP');
  if (!['APPROVED', 'DISPUTED', 'PROCESSED'].includes(vdp.status)) throw conflict('Only approved, unpaid VDPs can be reopened.');
  if (!String(reason || '').trim()) throw badRequest('A reason is required to reopen an approved VDP.');
  const openIssue = vdp.issues.find((i) => i.status === 'OPEN');
  if (openIssue) {
    // The reason is what the provider will read as Big Star's answer once the corrected VDP is re-approved.
    openIssue.status = 'IN_CORRECTION';
    openIssue.response = { action: 'CORRECTED', message: reason.trim(), by: actor(user) };
  }
  vdp.history.push({
    action: 'REOPENED',
    reason,
    by: actor(user),
    previousSnapshot: { ...vdp.snapshot, providerApproval: vdp.providerApproval?.method ? vdp.providerApproval : null },
  });
  vdp.snapshot = null;
  vdp.approvedAt = null;
  vdp.approvedBy = null;
  vdp.providerDeadline = null;
  vdp.providerApproval = { method: null };
  applyComputation(vdp, await computeVdp(vdp));
  await vdp.save();
  await syncCycleStatus(vdp.cycleId);
  return vdp;
}

export async function markPaid(id, user) {
  const vdp = await Vdp.findById(id);
  if (!vdp) throw notFound('VDP');
  if (vdp.status === 'APPROVED') {
    throw conflict('Waiting for the provider to approve (it auto-approves after the submission deadline).');
  }
  if (vdp.status === 'DISPUTED') throw conflict('The provider reported an issue. Respond to it or correct the VDP first.');
  if (vdp.status !== 'PROCESSED') throw conflict('Only approved & processed VDPs can be marked as paid.');
  vdp.status = 'PAID';
  vdp.paidAt = new Date();
  vdp.paidBy = actor(user);
  vdp.history.push({ action: 'PAID', by: actor(user) });
  await vdp.save();
  await syncCycleStatus(vdp.cycleId);
  return vdp;
}

const CYCLE_ORDER = ['UPCOMING', 'OPEN', 'PROCESSING', 'READY_FOR_REVIEW', 'APPROVED', 'PAID', 'CLOSED'];

// Move the cycle forward automatically as its VDPs progress (never backwards past a manual CLOSED).
export async function syncCycleStatus(cycleId) {
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle || cycle.status === 'CLOSED') return;
  const vdps = await Vdp.find({ cycleId }, 'status');
  if (!vdps.length) return;
  const all = (s) => vdps.every((v) => s.includes(v.status));
  let next = 'PROCESSING';
  if (all(['PAID'])) next = 'PAID';
  else if (all(['APPROVED', 'DISPUTED', 'PROCESSED', 'PAID'])) next = 'APPROVED';
  else if (all(['READY', 'APPROVED', 'DISPUTED', 'PROCESSED', 'PAID'])) next = 'READY_FOR_REVIEW';
  if (next !== cycle.status && CYCLE_ORDER.indexOf(cycle.status) >= CYCLE_ORDER.indexOf('OPEN')) {
    cycle.status = next;
    await cycle.save();
  }
}

// One consistent shape for the UI: frozen snapshot when approved, live data otherwise.
export async function vdpView(vdp) {
  const json = vdp.toJSON();
  if (vdp.snapshot) return { ...json, view: { ...vdp.snapshot, source: 'SNAPSHOT' } };
  const [provider, division, cycle, plan] = await Promise.all([
    Provider.findById(vdp.providerId),
    Division.findById(vdp.divisionId),
    VdpCycle.findById(vdp.cycleId),
    vdp.planId ? VdpPlan.findById(vdp.planId) : null,
  ]);
  return {
    ...json,
    view: {
      source: 'LIVE',
      provider: provider && providerView(provider),
      division: division && { id: division._id, divisionNumber: division.divisionNumber, name: division.name, location: division.location, timezone: division.timezone },
      cycle: cycle && cycleInfo(cycle),
      plan: plan && { id: plan._id, name: plan.name, versionId: vdp.planVersionId, versionNumber: vdp.settings?.versionNumber },
      settings: vdp.settings,
      lease: provider ? leaseView(provider, vdp) : null,
      performance: vdp.performance,
      adjustments: json.adjustments,
      calculation: vdp.calculation,
      gross: vdp.calculation?.gross ?? null,
      net: vdp.calculation?.net ?? null,
      calculatedAt: vdp.calculatedAt,
    },
  };
}

// Mark open VDPs as needing recalculation after their inputs change.
export async function markStale(filter) {
  await Vdp.updateMany({ ...filter, status: { $in: EDITABLE } }, { $set: { stale: true } });
}

export async function vdpUsesVersion(versionId) {
  return Boolean(await Vdp.exists({ planVersionId: versionId, status: { $in: ['APPROVED', 'DISPUTED', 'PROCESSED', 'PAID'] } }));
}
