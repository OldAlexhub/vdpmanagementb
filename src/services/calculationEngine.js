// VDP calculation engine — pure, deterministic, no I/O.
// Every financial formula in the application lives here.
import { D, cents, sum, max, min, str, money, fmtMoney, fmtRate, fmtNum, isBlank } from './money.js';
import { selectTier, tierLabel } from './tiers.js';

export const PAYMENT_TYPES = ['HOURLY', 'PER_TRIP'];
export const LEASE_FREQUENCIES = ['WEEKLY', 'PER_VDP_CYCLE', 'NONE'];

export const ADJUSTMENT_TYPES = {
  FARES: { label: 'Fares Collected', direction: 'DEDUCTION', group: 'fares' },
  FUEL: { label: 'Fuel', direction: 'DEDUCTION', group: 'otherDeductions' },
  TOLL: { label: 'Toll', direction: 'DEDUCTION', group: 'otherDeductions' },
  LATE_DEPLOYMENT: { label: 'Late Deployment', direction: 'DEDUCTION', group: 'otherDeductions' },
  VIOLATION: { label: 'Violation', direction: 'DEDUCTION', group: 'otherDeductions' },
  OTHER_DEDUCTION: { label: 'Other Deduction', direction: 'DEDUCTION', group: 'otherDeductions' },
  REIMBURSEMENT: { label: 'Reimbursement', direction: 'ADDITION', group: 'reimbursements' },
  OTHER_INCOME: { label: 'Other Income', direction: 'ADDITION', group: 'otherIncome' },
};

export class CalculationError extends Error {}

// Structured explanation steps: { label, detail, value, tone }.
// tone: 'info' (inputs), 'money' (earned line), 'minus', 'plus', 'subtotal', 'total'.
const step = (label, detail, value, tone = 'info') => ({ label, detail, value, tone });
const fmtPct = (d) => `${d.toDecimalPlaces(3).toString()}%`;
const fmtHours = (d) => `${fmtNum(d)} h`;

function calculateHourlyWeek(settings, week) {
  const actualHours = D(week.actualHours);
  const contractedHours = D(settings.contractedHours);
  if (contractedHours.lte(0)) throw new CalculationError('Contracted hours must be greater than zero.');

  const pct = actualHours.div(contractedHours).times(100);
  let rate = D(settings.basePay);
  let label = 'Base rate (TUI not applied)';
  let tierIndex = null;
  if (settings.tuiEligible) {
    const tier = selectTier(settings.incentiveTiers, pct);
    if (!tier) throw new CalculationError(`No incentive tier covers ${pct.toFixed(3)}%.`);
    rate = D(tier.rate);
    label = tierLabel(tier);
    tierIndex = tier.index;
  }

  const bonusApplies = settings.bonusEnabled && actualHours.gt(contractedHours);
  const corePaidHours = settings.bonusEnabled ? min(actualHours, contractedHours) : actualHours;
  const bonusHours = bonusApplies ? max(actualHours.minus(contractedHours), 0) : D(0);
  const bonusRate = settings.bonusEnabled ? D(settings.bonusRate) : D(0);
  const coreEarnings = cents(corePaidHours.times(rate));
  const bonusEarnings = cents(bonusHours.times(bonusRate));
  const weeklyEarnings = coreEarnings.plus(bonusEarnings);

  const explanation = [
    `Actual hours: ${fmtNum(actualHours)}`,
    `Contracted hours: ${fmtNum(contractedHours)}`,
    `Performance: ${fmtNum(actualHours)} ÷ ${fmtNum(contractedHours)} × 100 = ${pct.toFixed(3)}%`,
    settings.tuiEligible
      ? `Incentive tier ${label} → rate ${fmtRate(rate)}`
      : `TUI not applied → base rate ${fmtRate(rate)}`,
    `Core hours: ${fmtNum(corePaidHours)}` + (settings.bonusEnabled ? ` (lesser of actual and contracted)` : ''),
    `Bonus hours: ${fmtNum(bonusHours)}` +
      (settings.bonusEnabled ? ` (hours above ${fmtNum(contractedHours)})` : ' (bonus not part of this plan)'),
    `Core: ${fmtNum(corePaidHours)} × ${fmtRate(rate)} = ${fmtMoney(coreEarnings)}`,
    `Bonus: ${fmtNum(bonusHours)} × ${fmtRate(bonusRate)} = ${fmtMoney(bonusEarnings)}`,
    `Week ${week.weekNumber}: ${fmtMoney(coreEarnings)} + ${fmtMoney(bonusEarnings)} = ${fmtMoney(weeklyEarnings)}`,
  ];

  const steps = [
    step('Hours worked', 'Performance Report', fmtHours(actualHours)),
    step('Contracted hours', 'per week', fmtHours(contractedHours)),
    step('Performance', `${fmtNum(actualHours)} ÷ ${fmtNum(contractedHours)}`, fmtPct(pct)),
    step('Rate', settings.tuiEligible ? `Incentive tier ${label}` : 'Base rate (no TUI)', `${fmtRate(rate)} / h`),
    step(
      'Core pay',
      settings.bonusEnabled && bonusApplies
        ? `${fmtNum(corePaidHours)} h (contract) × ${fmtRate(rate)}`
        : `${fmtNum(corePaidHours)} h × ${fmtRate(rate)}`,
      fmtMoney(coreEarnings),
      'money',
    ),
  ];
  if (settings.bonusEnabled) {
    steps.push(step(
      'Bonus pay',
      bonusApplies ? `${fmtNum(bonusHours)} h above contract × ${fmtRate(bonusRate)}` : 'No hours above contract',
      fmtMoney(bonusEarnings),
      'money',
    ));
  }
  steps.push(step(`Week ${week.weekNumber} total`, '', fmtMoney(weeklyEarnings), 'total'));

  return {
    performancePercentage: pct,
    tierLabel: label,
    tierIndex,
    steps,
    incentiveRate: rate,
    corePaidHours,
    bonusHours,
    bonusRate,
    coreEarnings,
    bonusEarnings,
    weeklyEarnings,
    explanation,
  };
}

function calculatePerTripWeek(settings, week) {
  const trips = D(week.trips);
  const actualHours = D(week.actualHours);
  const contracted = isBlank(settings.contractedHours) ? null : D(settings.contractedHours);
  const pct = contracted && contracted.gt(0) ? actualHours.div(contracted).times(100) : null;

  let rate = D(settings.basePay);
  let label = 'Base per-trip rate (TUI not applied)';
  let tierIndex = null;
  if (settings.tuiEligible) {
    if (pct === null) throw new CalculationError('Contracted hours are required to apply TUI tiers.');
    const tier = selectTier(settings.incentiveTiers, pct);
    if (!tier) throw new CalculationError(`No incentive tier covers ${pct.toFixed(3)}%.`);
    rate = D(tier.rate);
    label = tierLabel(tier);
    tierIndex = tier.index;
  }
  const coreEarnings = cents(trips.times(rate));
  const explanation = [
    `Trips provided: ${fmtNum(trips)}`,
    `Hours: ${fmtNum(actualHours)}` + (pct ? ` (${pct.toFixed(3)}% of ${fmtNum(contracted)} contracted)` : ''),
    settings.tuiEligible
      ? `Incentive tier ${label} → ${fmtRate(rate)} per trip`
      : `TUI not applied → ${fmtRate(rate)} per trip`,
    `Trips: ${fmtNum(trips)} × ${fmtRate(rate)} = ${fmtMoney(coreEarnings)}`,
    `Week ${week.weekNumber}: ${fmtMoney(coreEarnings)}`,
  ];
  const steps = [
    step('Trips provided', 'Performance Report', `${fmtNum(trips)} trips`),
    step('Hours worked', pct ? `${fmtPct(pct)} of ${fmtNum(contracted)} h` : 'Performance Report', fmtHours(actualHours)),
    step('Rate', settings.tuiEligible ? `Tier ${label}` : 'Per-trip rate (no TUI)', `${fmtRate(rate)} / trip`),
    step('Trip pay', `${fmtNum(trips)} trips × ${fmtRate(rate)}`, fmtMoney(coreEarnings), 'money'),
    step(`Week ${week.weekNumber} total`, '', fmtMoney(coreEarnings), 'total'),
  ];
  return {
    performancePercentage: pct,
    tierLabel: label,
    tierIndex,
    steps,
    incentiveRate: rate,
    corePaidHours: actualHours,
    bonusHours: D(0),
    bonusRate: D(0),
    coreEarnings,
    bonusEarnings: D(0),
    weeklyEarnings: coreEarnings,
    explanation,
  };
}

export function calculateLease(lease, weeksInCycle) {
  if (!lease || lease.frequency === 'NONE' || isBlank(lease.amount)) {
    return { amount: D(0), explanation: 'No lift lease.', detail: 'No lift lease' };
  }
  const weeksCharged = isBlank(lease.weeksCharged) ? D(weeksInCycle) : D(lease.weeksCharged);
  if (lease.frequency === 'WEEKLY') {
    const amount = cents(D(lease.amount).times(weeksCharged));
    return {
      amount,
      weeksCharged,
      explanation: `Lift lease: ${fmtRate(lease.amount)}/week × ${fmtNum(weeksCharged)} weeks = ${fmtMoney(amount)}`,
      detail: `${fmtRate(lease.amount)} / week × ${fmtNum(weeksCharged)} week${weeksCharged.eq(1) ? '' : 's'}`,
    };
  }
  // PER_VDP_CYCLE — prorated only if the reviewer charged fewer weeks than the cycle has.
  const factor = weeksCharged.div(weeksInCycle);
  const amount = cents(D(lease.amount).times(factor));
  return {
    amount,
    weeksCharged,
    explanation: factor.eq(1)
      ? `Lift lease: ${fmtMoney(amount)} per VDP cycle`
      : `Lift lease: ${fmtRate(lease.amount)}/cycle × ${fmtNum(weeksCharged)}/${weeksInCycle} weeks = ${fmtMoney(amount)}`,
    detail: factor.eq(1) ? 'per VDP cycle' : `${fmtRate(lease.amount)} / cycle × ${fmtNum(weeksCharged)} of ${weeksInCycle} weeks`,
  };
}

// Fuel reimbursement (plan option): every trip in the cycle × the plan's per-trip rate,
// rounded once to the cent. Added after Gross — it is not earnings. Off = $0 and no line.
export function calculateFuelReimbursement(settings, weekResults) {
  return fuelReimbursementFor([{ settings, trips: sum(weekResults.map((w) => w.trips)) }]);
}

// Operators on different plans: each plan's rate applies to its own operators' trips. Trips are
// summed per rate and rounded once per rate, so operators on one plan round exactly as before.
function fuelReimbursementFor(parts) {
  const paid = parts.filter((p) => p.settings.fuelReimbursementEnabled);
  if (!paid.length) return { enabled: false, amount: D(0) };
  const byRate = new Map();
  for (const p of paid) {
    if (isBlank(p.settings.fuelReimbursementRate) || D(p.settings.fuelReimbursementRate).lte(0)) {
      throw new CalculationError('Fuel reimbursement is on, but the per-trip rate is missing.');
    }
    const key = D(p.settings.fuelReimbursementRate).toString();
    byRate.set(key, (byRate.get(key) || D(0)).plus(p.trips));
  }
  const lines = [...byRate.entries()].map(([r, trips]) => ({ rate: D(r), trips, amount: cents(trips.times(D(r))) }));
  const amount = sum(lines.map((l) => l.amount));
  const trips = sum(lines.map((l) => l.trips));
  const detail = lines.map((l) => `${fmtNum(l.trips)} trips × ${fmtRate(l.rate)}`).join(' + ');
  return {
    enabled: true,
    trips,
    rate: lines.length === 1 ? lines[0].rate : null,
    amount,
    explanation: `Fuel reimbursement: ${detail} = ${fmtMoney(amount)}`,
    detail,
  };
}

/**
 * Service mile fuel allowance (plan option). Per service date:
 *   allowed fuel ($) = service miles ÷ X   (X = the plan's fuel divisor, e.g. 19; provider may override)
 * Daily values keep full precision; the sum is rounded once to cents (Maximum Allowed Fuel).
 * Only the actual expense above the maximum is deducted — an unused allowance is not income.
 * @param {object} input
 * @param {string} input.mpg     the divisor X
 * @param {Array}  input.days    [{ date, week, serviceMiles }] — one per service date (routes summed)
 * @param {string|null} input.actualExpense  null = not entered yet (no deduction until it is)
 */
export function calculateFuelAllowance({ mpg, days, actualExpense }) {
  const divisor = (value) => {
    if (isBlank(value) || D(value).lte(0)) throw new CalculationError('Fuel MPG configuration is missing.');
    return D(value);
  };
  if (!days.some((d) => !isBlank(d.mpg))) divisor(mpg);
  const daily = days.map((d) => {
    if (isBlank(d.serviceMiles)) throw new CalculationError(`Service Miles are missing for ${d.date}.`);
    const miles = D(d.serviceMiles);
    const m = divisor(d.mpg ?? mpg);
    return { date: d.date, week: d.week, operator: d.operator ?? null, serviceMiles: miles, mpg: m, allowed: miles.div(m) };
  });
  const mpgs = [...new Set(daily.map((d) => d.mpg.toString()))];
  const m = mpgs.length === 1 ? D(mpgs[0]) : isBlank(mpg) ? null : D(mpg);
  const serviceMiles = sum(daily.map((d) => d.serviceMiles));
  const weekMiles = [1, 2].map((n) => sum(daily.filter((d) => d.week === n).map((d) => d.serviceMiles)));
  const maxAllowed = cents(sum(daily.map((d) => d.allowed)));
  const entered = !isBlank(actualExpense);
  const actual = entered ? cents(actualExpense) : null;
  if (actual && actual.isNegative()) throw new CalculationError('Actual fuel expense cannot be negative.');
  const overspend = entered ? max(actual.minus(maxAllowed), 0) : D(0);
  const allowance = mpgs.length > 1
    ? `${fmtNum(serviceMiles)} service miles ÷ each operator’s MPG (${mpgs.join(' / ')}) = ${fmtMoney(maxAllowed)} maximum`
    : `${fmtNum(serviceMiles)} service miles ÷ ${fmtNum(mpgs[0] ?? mpg)} = ${fmtMoney(maxAllowed)} maximum`;
  return {
    enabled: true,
    mpg: mpgs.length > 1 ? null : m,
    mpgs,
    serviceMiles,
    weekMiles,
    maxAllowed,
    actualExpense: actual,
    entered,
    overspend,
    unused: entered ? max(maxAllowed.minus(actual), 0) : null,
    days: daily,
    detail: entered
      ? `${fmtMoney(actual)} actual − ${fmtMoney(maxAllowed)} allowed`
      : 'Actual fuel expense not entered yet',
    explanation: entered
      ? `Fuel allowance: ${allowance}; actual ${fmtMoney(actual)} → overspend ${fmtMoney(overspend)}`
      : `Fuel allowance: ${allowance}; actual fuel expense not entered`,
  };
}

// One operator: every week measured against this operator's own contract.
function calculateOperator(settings, unit) {
  // An operator on a different VDP plan than the provider brings that plan's settings.
  const base = unit.settings || settings;
  if (!PAYMENT_TYPES.includes(base.paymentType)) throw new CalculationError(`Unsupported payment type "${base.paymentType}".`);
  const s = isBlank(unit.contractedHours) ? base : { ...base, contractedHours: unit.contractedHours };
  const weekFn = s.paymentType === 'HOURLY' ? calculateHourlyWeek : calculatePerTripWeek;
  const weeks = unit.weeks.map((w) => ({
    weekNumber: w.weekNumber,
    start: w.start,
    end: w.end,
    trips: D(w.trips),
    actualHours: D(w.actualHours),
    contractedHours: isBlank(s.contractedHours) ? null : D(s.contractedHours),
    ...weekFn(s, w),
  }));
  return {
    name: unit.name ?? null,
    routes: unit.routes || [],
    plan: unit.plan ?? null,
    settings: base,
    weeks,
    earnings: sum(weeks.map((w) => w.weeklyEarnings)),
    lease: calculateLease(unit.lease, unit.weeks.length),
  };
}

// Several operators: the provider's week is the sum of its operators' weeks.
// Tier, rate and % stay per operator (they would be meaningless summed).
function combineWeeks(ops) {
  return ops[0].weeks.map((first, i) => {
    const parts = ops.map((o) => ({ o, w: o.weeks[i] }));
    const total = (k) => sum(parts.map(({ w }) => w[k] ?? 0));
    const contracted = parts.every(({ w }) => w.contractedHours === null) ? null : total('contractedHours');
    const weeklyEarnings = total('weeklyEarnings');
    const line = ({ o, w }) => (o.settings.paymentType === 'PER_TRIP'
      ? `${fmtNum(w.trips)} trips × ${fmtRate(w.incentiveRate)}`
      : `${fmtNum(w.actualHours)} h of ${fmtNum(w.contractedHours)} (${w.performancePercentage.toFixed(1)}%) · ${w.tierLabel}`);
    return {
      weekNumber: first.weekNumber,
      start: first.start,
      end: first.end,
      trips: total('trips'),
      actualHours: total('actualHours'),
      contractedHours: contracted,
      performancePercentage: null,
      tierLabel: 'Per operator',
      tierIndex: null,
      incentiveRate: null,
      corePaidHours: total('corePaidHours'),
      bonusHours: total('bonusHours'),
      bonusRate: null,
      coreEarnings: total('coreEarnings'),
      bonusEarnings: total('bonusEarnings'),
      weeklyEarnings,
      steps: [
        ...parts.map((p) => step(p.o.name, line(p), fmtMoney(p.w.weeklyEarnings), 'money')),
        step(`Week ${first.weekNumber} total`, `${parts.length} operators`, fmtMoney(weeklyEarnings), 'total'),
      ],
      explanation: [
        ...parts.map((p) => `${p.o.name}: ${line(p)} = ${fmtMoney(p.w.weeklyEarnings)}`),
        `Week ${first.weekNumber}: ${parts.map((p) => fmtMoney(p.w.weeklyEarnings)).join(' + ')} = ${fmtMoney(weeklyEarnings)}`,
      ],
    };
  });
}

/**
 * @param {object} input
 * @param {object} input.settings   resolved plan + provider settings
 * @param {Array}  input.operators  [{ name, routes, contractedHours?, weeks, lease }] — one per operator
 * @param {Array}  input.weeks      single-operator shorthand: [{ weekNumber, start, end, trips, actualHours }]
 * @param {object} input.lease      single-operator shorthand: { amount, frequency, weeksCharged? }
 * @param {Array}  input.adjustments [{ type, amount, description }]
 * @param {object} input.fuel       service mile allowance only: { days, actualExpense } (see calculateFuelAllowance)
 */
export function calculateVdp({ settings, weeks, lease, operators, adjustments = [], fuel: fuelInput }) {
  if (!PAYMENT_TYPES.includes(settings.paymentType)) {
    throw new CalculationError(`Unsupported payment type "${settings.paymentType}".`);
  }
  const units = operators?.length ? operators : [{ name: null, weeks, lease }];
  const ops = units.map((u) => calculateOperator(settings, u));
  const many = ops.length > 1;
  const weekResults = many ? combineWeeks(ops) : ops[0].weeks;

  const gross = sum(weekResults.map((w) => w.weeklyEarnings));
  const leaseResult = many
    ? {
      amount: sum(ops.map((o) => o.lease.amount)),
      weeksCharged: ops.find((o) => o.lease.weeksCharged !== undefined)?.lease.weeksCharged,
      explanation: ops.map((o) => `${o.name} — ${o.lease.explanation}`).join('; '),
    }
    : ops[0].lease;
  const fuel = fuelReimbursementFor(ops.map((o) => ({ settings: o.settings, trips: sum(o.weeks.map((w) => w.trips)) })));
  const allowance = ops.some((o) => o.settings.fuelMethod === 'SERVICE_MILE_ALLOWANCE')
    ? calculateFuelAllowance({ mpg: settings.fuelMpg, days: fuelInput?.days || [], actualExpense: fuelInput?.actualExpense })
    : null;
  const fuelOverspend = allowance ? allowance.overspend : D(0);

  const groups = { fares: D(0), otherDeductions: D(0), reimbursements: D(0), otherIncome: D(0) };
  for (const adj of adjustments) {
    const def = ADJUSTMENT_TYPES[adj.type];
    if (!def) throw new CalculationError(`Unknown adjustment type "${adj.type}".`);
    const amount = cents(adj.amount);
    if (amount.isNegative()) throw new CalculationError('Adjustment amounts must be positive; the type sets the direction.');
    groups[def.group] = groups[def.group].plus(amount);
  }

  // The overspend is the only fuel deduction; the actual expense itself is never deducted.
  const totalDeductions = leaseResult.amount.plus(groups.fares).plus(groups.otherDeductions).plus(fuelOverspend);
  const totalAdditions = fuel.amount.plus(groups.reimbursements).plus(groups.otherIncome);
  const net = gross.minus(totalDeductions).plus(totalAdditions);

  const explanation = [
    ...weekResults.map((w) => `Week ${w.weekNumber}: ${fmtMoney(w.weeklyEarnings)}`),
    `Gross VDP: ${weekResults.map((w) => fmtMoney(w.weeklyEarnings)).join(' + ')} = ${fmtMoney(gross)}`,
    leaseResult.explanation,
    ...(fuel.enabled ? [fuel.explanation] : []),
    ...(allowance ? [allowance.explanation] : []),
    `Fares collected: ${fmtMoney(groups.fares)}`,
    `Other deductions: ${fmtMoney(groups.otherDeductions)}`,
    `Reimbursements: ${fmtMoney(groups.reimbursements)}`,
    `Other income: ${fmtMoney(groups.otherIncome)}`,
    `Net VDP: ${fmtMoney(gross)} − ${fmtMoney(totalDeductions)} + ${fmtMoney(totalAdditions)} = ${fmtMoney(net)}`,
  ];

  const counts = adjustments.reduce((acc, a) => {
    const g = ADJUSTMENT_TYPES[a.type].group;
    acc[g] = (acc[g] || 0) + 1;
    return acc;
  }, {});
  const entries = (g) => (counts[g] === 1 ? '1 entry' : `${counts[g]} entries`);
  const steps = [
    ...weekResults.map((w) => step(`Week ${w.weekNumber} earnings`, '', fmtMoney(w.weeklyEarnings), 'money')),
    step('Gross VDP', '', fmtMoney(gross), 'subtotal'),
    ...(many
      ? ops.map((o) => step(`Lift lease — ${o.name}`, o.lease.detail, `−${fmtMoney(o.lease.amount)}`, 'minus'))
      : [step('Lift lease', leaseResult.detail, `−${fmtMoney(leaseResult.amount)}`, 'minus')]),
  ];
  if (groups.fares.gt(0)) steps.push(step('Fares collected', entries('fares'), `−${fmtMoney(groups.fares)}`, 'minus'));
  if (groups.otherDeductions.gt(0)) steps.push(step('Other deductions', entries('otherDeductions'), `−${fmtMoney(groups.otherDeductions)}`, 'minus'));
  if (allowance) {
    steps.push(allowance.overspend.gt(0)
      ? step('Fuel overspend', allowance.detail, `−${fmtMoney(allowance.overspend)}`, 'minus')
      : step('Fuel overspend', allowance.entered ? `${allowance.detail} — within allowance` : allowance.detail, fmtMoney(0)));
  }
  if (fuel.enabled) steps.push(step('Fuel reimbursement', fuel.detail, `+${fmtMoney(fuel.amount)}`, 'plus'));
  if (groups.reimbursements.gt(0)) steps.push(step('Reimbursements', entries('reimbursements'), `+${fmtMoney(groups.reimbursements)}`, 'plus'));
  if (groups.otherIncome.gt(0)) steps.push(step('Other income', entries('otherIncome'), `+${fmtMoney(groups.otherIncome)}`, 'plus'));
  steps.push(step('Net VDP payment', '', fmtMoney(net), 'total'));

  return {
    weeks: weekResults,
    gross,
    lease: leaseResult.amount,
    operators: ops.map((o) => ({ name: o.name, routes: o.routes, plan: o.plan, paymentType: o.settings.paymentType, weeks: o.weeks, earnings: o.earnings, lease: o.lease.amount, leaseDetail: o.lease.detail })),
    leaseWeeksCharged: leaseResult.weeksCharged ?? null,
    fares: groups.fares,
    otherDeductions: groups.otherDeductions,
    fuelReimbursement: fuel.amount,
    fuelTrips: fuel.enabled ? fuel.trips : null,
    fuelReimbursementRate: fuel.enabled ? fuel.rate : null,
    fuelReimbursementDetail: fuel.enabled ? fuel.detail : null,
    fuelAllowance: allowance,
    fuelOverspend,
    reimbursements: groups.reimbursements,
    otherIncome: groups.otherIncome,
    totalDeductions,
    totalAdditions,
    net,
    explanation,
    steps,
  };
}

// Plain-string form for storage / API. Money as fixed 2dp, rates/hours exact.
const serializeWeek = (w) => ({
  weekNumber: w.weekNumber,
  start: w.start,
  end: w.end,
  trips: str(w.trips),
  actualHours: str(w.actualHours),
  contractedHours: str(w.contractedHours),
  performancePercentage: w.performancePercentage === null ? null : w.performancePercentage.toDecimalPlaces(6).toString(),
  tierLabel: w.tierLabel,
  incentiveRate: str(w.incentiveRate),
  corePaidHours: str(w.corePaidHours),
  bonusHours: str(w.bonusHours),
  bonusRate: str(w.bonusRate),
  coreEarnings: money(w.coreEarnings),
  bonusEarnings: money(w.bonusEarnings),
  weeklyEarnings: money(w.weeklyEarnings),
  tierIndex: w.tierIndex,
  steps: w.steps,
  explanation: w.explanation,
});

// Full precision for miles and daily allowances; money at cents.
function serializeAllowance(a) {
  if (!a) return null;
  return {
    method: 'SERVICE_MILE_ALLOWANCE',
    mpg: str(a.mpg),
    mpgs: a.mpgs,
    serviceMiles: str(a.serviceMiles),
    weekMiles: a.weekMiles.map(str),
    maxAllowed: money(a.maxAllowed),
    actualExpense: a.actualExpense === null ? null : money(a.actualExpense),
    overspend: money(a.overspend),
    unused: a.unused === null ? null : money(a.unused),
    days: a.days.map((d) => ({ date: d.date, week: d.week, operator: d.operator, serviceMiles: str(d.serviceMiles), mpg: str(d.mpg), allowed: str(d.allowed) })),
  };
}

export function serializeResult(r) {
  return {
    weeks: r.weeks.map(serializeWeek),
    operators: (r.operators || []).map((o) => ({
      name: o.name,
      routes: o.routes,
      plan: o.plan ?? null,
      paymentType: o.paymentType,
      earnings: money(o.earnings),
      lease: money(o.lease),
      leaseDetail: o.leaseDetail,
      weeks: o.weeks.map(serializeWeek),
    })),
    gross: money(r.gross),
    lease: money(r.lease),
    leaseWeeksCharged: str(r.leaseWeeksCharged),
    fares: money(r.fares),
    otherDeductions: money(r.otherDeductions),
    fuelReimbursement: money(r.fuelReimbursement),
    fuelTrips: str(r.fuelTrips),
    fuelReimbursementRate: str(r.fuelReimbursementRate),
    fuelReimbursementDetail: r.fuelReimbursementDetail ?? null,
    fuelAllowance: serializeAllowance(r.fuelAllowance),
    fuelOverspend: money(r.fuelOverspend ?? 0),
    reimbursements: money(r.reimbursements),
    otherIncome: money(r.otherIncome),
    totalDeductions: money(r.totalDeductions),
    totalAdditions: money(r.totalAdditions),
    net: money(r.net),
    explanation: r.explanation,
    steps: r.steps,
  };
}
