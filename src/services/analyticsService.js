// Reporting for leadership (division-wide) and for providers (their own statements).
// Figures come from approved snapshots where they exist, otherwise the live calculation.
// Money is summed exactly (decimal) and returned as strings; ratios as plain numbers.
import Vdp from '../models/Vdp.js';
import VdpCycle from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import { ADJUSTMENT_TYPES } from './calculationEngine.js';
import { D, sum, money } from './money.js';
import { isoDate } from './cycleService.js';
import { notFound } from './errors.js';

const calcOf = (v) => v.snapshot?.calculation || v.calculation || null;
const adjustmentsOf = (v) => v.snapshot?.adjustments || v.adjustments || [];
const planOf = (v) => v.snapshot?.plan?.name || v.settings?.planName || '—';
const isHourly = (v) => (v.snapshot?.settings || v.settings)?.paymentType?.value !== 'PER_TRIP';
const round1 = (n) => Math.round(n * 10) / 10;
const cycleLabel = (c) => `${isoDate(c.cycleStart).slice(5).replace('-', '/')}–${isoDate(c.cycleEnd).slice(5).replace('-', '/')}`;
const tierOrder = (label) => {
  const m = /^(\d+(?:\.\d+)?)/.exec(label || '');
  return m ? Number(m[1]) : -1;
};

// Week-level facts for one VDP.
function weekFacts(v) {
  const calc = calcOf(v);
  if (!calc) return [];
  // Several operators: performance % and tiers only exist per operator-week.
  const weeks = calc.operators?.length > 1 ? calc.operators.flatMap((o) => o.weeks) : calc.weeks;
  return weeks.map((w) => ({
    hourly: isHourly(v),
    hours: D(w.actualHours || 0),
    trips: D(w.trips || 0),
    pct: w.performancePercentage === null || w.performancePercentage === undefined ? null : Number(w.performancePercentage),
    bonusHours: D(w.bonusHours || 0),
    bonusPay: D(w.bonusEarnings || 0),
    tierLabel: w.tierLabel,
    rate: w.incentiveRate,
  }));
}

function totals(vdps) {
  const calcs = vdps.map(calcOf).filter(Boolean);
  const weeks = vdps.flatMap(weekFacts);
  const perf = weeks.filter((w) => w.hourly && w.pct !== null);
  return {
    vdps: vdps.length,
    calculated: calcs.length,
    gross: money(sum(calcs.map((c) => c.gross))),
    deductions: money(sum(calcs.map((c) => c.totalDeductions))),
    additions: money(sum(calcs.map((c) => c.totalAdditions))),
    net: money(sum(calcs.map((c) => c.net))),
    lease: money(sum(calcs.map((c) => c.lease))),
    fares: money(sum(calcs.map((c) => c.fares))),
    otherDeductions: money(sum(calcs.map((c) => c.otherDeductions))),
    fuelReimbursement: money(sum(calcs.map((c) => c.fuelReimbursement || 0))),
    hours: sum(weeks.map((w) => w.hours)).toDecimalPlaces(2).toString(),
    trips: sum(weeks.map((w) => w.trips)).toString(),
    bonusHours: sum(weeks.map((w) => w.bonusHours)).toDecimalPlaces(2).toString(),
    bonusPay: money(sum(weeks.map((w) => w.bonusPay))),
    hourlyWeeks: perf.length,
    weeksAt100: perf.filter((w) => w.pct >= 100).length,
    avgPerformance: perf.length ? round1(perf.reduce((a, w) => a + w.pct, 0) / perf.length) : null,
  };
}

function approvalFacts(vdps) {
  const out = { providerApproved: 0, autoApproved: 0, awaitingProvider: 0, disputed: 0 };
  vdps.forEach((v) => {
    if (v.providerApproval?.method === 'PROVIDER') out.providerApproved += 1;
    else if (v.providerApproval?.method === 'AUTO') out.autoApproved += 1;
    if (v.status === 'APPROVED') out.awaitingProvider += 1;
    if (v.status === 'DISPUTED') out.disputed += 1;
  });
  return out;
}

function issueFacts(vdps) {
  const issues = vdps.flatMap((v) => v.issues || []);
  const areas = {};
  issues.forEach((i) => i.items.forEach((it) => { areas[it.area] = (areas[it.area] || 0) + 1; }));
  const resolved = issues.filter((i) => i.status === 'RESOLVED' && i.response?.at);
  const hours = resolved.map((i) => (new Date(i.response.at) - new Date(i.raisedAt)) / 3600000);
  return {
    raised: issues.length,
    open: issues.filter((i) => i.status !== 'RESOLVED').length,
    corrected: resolved.filter((i) => i.response.action === 'CORRECTED').length,
    noChange: resolved.filter((i) => i.response.action === 'NO_CHANGE').length,
    avgHoursToResolve: hours.length ? round1(hours.reduce((a, b) => a + b, 0) / hours.length) : null,
    byArea: Object.entries(areas).map(([area, count]) => ({ area, count })).sort((a, b) => b.count - a.count),
  };
}

function tierDistribution(vdps) {
  const map = new Map();
  vdps.flatMap(weekFacts).filter((w) => w.hourly && w.tierLabel).forEach((w) => {
    const key = w.tierLabel;
    const cur = map.get(key) || { tier: key, weeks: 0 };
    cur.weeks += 1;
    map.set(key, cur);
  });
  return [...map.values()].sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier));
}

function deductionBreakdown(vdps) {
  const byType = {};
  vdps.forEach((v) => adjustmentsOf(v).forEach((a) => {
    byType[a.type] = (byType[a.type] || D(0)).plus(D(a.amount));
  }));
  const calcs = vdps.map(calcOf).filter(Boolean);
  const rows = [{ key: 'LIFT_LEASE', label: 'Lift lease', direction: 'DEDUCTION', amount: money(sum(calcs.map((c) => c.lease))) }];
  Object.entries(ADJUSTMENT_TYPES).forEach(([key, def]) => {
    if (byType[key]) rows.push({ key, label: def.label, direction: def.direction, amount: money(byType[key]) });
  });
  return rows.filter((r) => r.amount !== '0.00');
}

function staffActivity(vdps) {
  const approvals = {};
  const adjustments = {};
  vdps.forEach((v) => {
    (v.history || []).forEach((h) => {
      if (h.action === 'APPROVED' && h.by?.name) approvals[h.by.name] = (approvals[h.by.name] || 0) + 1;
    });
    (v.adjustments || []).forEach((a) => {
      const n = a.createdBy?.name || '—';
      adjustments[n] = adjustments[n] || { name: n, count: 0, amount: D(0) };
      adjustments[n].count += 1;
      adjustments[n].amount = adjustments[n].amount.plus(D(a.amount));
    });
  });
  return {
    approvals: Object.entries(approvals).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    adjustments: Object.values(adjustments).map((a) => ({ ...a, amount: money(a.amount) })).sort((a, b) => b.count - a.count),
  };
}

export async function leadershipReport({ divisionId, cycles: cycleCount = 6 }) {
  const division = divisionId ? await Division.findById(divisionId) : await Division.findOne({ status: 'ACTIVE' }).sort({ divisionNumber: 1 });
  if (!division) throw notFound('Division');
  const withVdps = await Vdp.distinct('cycleId', { divisionId: division._id });
  let cycles = await VdpCycle.find({ _id: { $in: withVdps } }).sort({ cycleStart: -1 });
  if (cycleCount !== 'all') cycles = cycles.slice(0, Number(cycleCount) || 6);
  cycles = cycles.reverse(); // oldest → newest for charts

  const vdps = await Vdp.find({ cycleId: { $in: cycles.map((c) => c._id) } });
  const byCycle = (c) => vdps.filter((v) => String(v.cycleId) === String(c._id));

  const series = cycles.map((c) => {
    const vs = byCycle(c);
    const statusCounts = vs.reduce((acc, v) => ({ ...acc, [v.status]: (acc[v.status] || 0) + 1 }), {});
    return {
      cycleId: c._id,
      label: cycleLabel(c),
      cycleStart: c.cycleStart,
      cycleEnd: c.cycleEnd,
      paymentDate: c.paymentDate,
      status: c.status,
      ...totals(vs),
      ...approvalFacts(vs),
      statusCounts,
      issues: vs.reduce((a, v) => a + (v.issues?.length || 0), 0),
    };
  });

  // Provider scorecard across the period.
  const providers = new Map((await Provider.find({ divisionId: division._id }, 'name routes operatorName status')).map((p) => [String(p._id), p]));
  const groups = new Map();
  vdps.forEach((v) => {
    const k = String(v.providerId);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  });
  const scorecard = [...groups.entries()].map(([id, vs]) => {
    const p = providers.get(id);
    const t = totals(vs);
    const latest = vs.slice().sort((a, b) => cycles.findIndex((c) => String(c._id) === String(b.cycleId)) - cycles.findIndex((c) => String(c._id) === String(a.cycleId)))[0];
    return {
      providerId: id,
      name: p?.name || vs[0].snapshot?.provider?.name || '—',
      operator: p?.operatorName,
      routes: p?.routes || [],
      plan: planOf(latest),
      cycles: vs.length,
      net: t.net,
      gross: t.gross,
      hours: t.hours,
      trips: t.trips,
      avgPerformance: t.avgPerformance,
      weeksAt100: t.weeksAt100,
      hourlyWeeks: t.hourlyWeeks,
      bonusHours: t.bonusHours,
      issues: vs.reduce((a, v) => a + (v.issues?.length || 0), 0),
      autoApproved: vs.filter((v) => v.providerApproval?.method === 'AUTO').length,
      latestStatus: latest?.status,
      latestVdpId: latest?._id,
    };
  }).sort((a, b) => D(b.net).cmp(D(a.net)));

  const latest = series[series.length - 1] || null;
  const previous = series[series.length - 2] || null;
  return {
    division: { _id: division._id, divisionNumber: division.divisionNumber, name: division.name },
    period: { cycles: series.length, from: cycles[0]?.cycleStart ?? null, to: cycles[cycles.length - 1]?.cycleEnd ?? null },
    kpis: { ...totals(vdps), ...approvalFacts(vdps), providers: groups.size },
    latest,
    previous,
    series,
    tiers: tierDistribution(vdps),
    deductions: deductionBreakdown(vdps),
    issues: issueFacts(vdps),
    activity: staffActivity(vdps),
    scorecard,
  };
}

// ---------- provider portal ----------

const PROVIDER_VISIBLE = ['APPROVED', 'DISPUTED', 'PROCESSED', 'PAID'];

export async function providerReport(providerId) {
  const provider = await Provider.findById(providerId, 'name providerNumber operatorName routes');
  const vdps = await Vdp.find({ providerId, status: { $in: PROVIDER_VISIBLE }, snapshot: { $ne: null } })
    .populate('cycleId', 'cycleStart cycleEnd paymentDate submissionDate');
  vdps.sort((a, b) => a.cycleId.cycleStart - b.cycleId.cycleStart);

  const year = new Date().getUTCFullYear();
  const ytd = vdps.filter((v) => v.cycleId.paymentDate && new Date(v.cycleId.paymentDate).getUTCFullYear() === year);
  const last = vdps[vdps.length - 1] || null;
  const pending = vdps.filter((v) => v.status === 'APPROVED').sort((a, b) => a.providerDeadline - b.providerDeadline);

  const weeks = vdps.slice(-6).flatMap((v) => v.snapshot.calculation.weeks.map((w) => ({
    label: `${isoDate(w.start || v.cycleId.cycleStart).slice(5).replace('-', '/')}`,
    cycle: cycleLabel(v.cycleId),
    hours: Number(w.actualHours),
    contracted: w.contractedHours === null ? null : Number(w.contractedHours),
    trips: Number(w.trips),
    performance: w.performancePercentage === null ? null : round1(Number(w.performancePercentage)),
    tier: w.tierLabel,
    rate: w.incentiveRate,
    earnings: w.weeklyEarnings,
  })));

  return {
    provider,
    year,
    kpis: {
      ytd: { ...totals(ytd), statements: ytd.length },
      all: totals(vdps),
      last: last && {
        vdpId: last._id, cycle: cycleLabel(last.cycleId), net: calcOf(last).net, status: last.status,
        paymentDate: last.cycleId.paymentDate, paidAt: last.paidAt,
      },
      pending: pending.map((v) => ({
        vdpId: v._id, cycle: cycleLabel(v.cycleId), net: calcOf(v).net, submissionDate: v.cycleId.submissionDate,
      })),
      openIssues: vdps.filter((v) => v.status === 'DISPUTED').length,
    },
    cycles: vdps.slice(-12).map((v) => {
      const c = calcOf(v);
      return {
        vdpId: v._id, label: cycleLabel(v.cycleId), status: v.status,
        gross: c.gross, deductions: c.totalDeductions, additions: c.totalAdditions, net: c.net,
      };
    }),
    weeks,
    deductions: deductionBreakdown(ytd),
  };
}
