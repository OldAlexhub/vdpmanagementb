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

/**
 * @param {object} input
 * @param {object} input.settings  resolved plan + provider settings
 * @param {Array}  input.weeks     [{ weekNumber, start, end, trips, actualHours }]
 * @param {object} input.lease     { amount, frequency, weeksCharged? }
 * @param {Array}  input.adjustments [{ type, amount, description }]
 */
export function calculateVdp({ settings, weeks, lease, adjustments = [] }) {
  if (!PAYMENT_TYPES.includes(settings.paymentType)) {
    throw new CalculationError(`Unsupported payment type "${settings.paymentType}".`);
  }
  const weekFn = settings.paymentType === 'HOURLY' ? calculateHourlyWeek : calculatePerTripWeek;

  const weekResults = weeks.map((w) => {
    const r = weekFn(settings, w);
    return {
      weekNumber: w.weekNumber,
      start: w.start,
      end: w.end,
      trips: D(w.trips),
      actualHours: D(w.actualHours),
      contractedHours: isBlank(settings.contractedHours) ? null : D(settings.contractedHours),
      ...r,
    };
  });

  const gross = sum(weekResults.map((w) => w.weeklyEarnings));
  const leaseResult = calculateLease(lease, weeks.length);

  const groups = { fares: D(0), otherDeductions: D(0), reimbursements: D(0), otherIncome: D(0) };
  for (const adj of adjustments) {
    const def = ADJUSTMENT_TYPES[adj.type];
    if (!def) throw new CalculationError(`Unknown adjustment type "${adj.type}".`);
    const amount = cents(adj.amount);
    if (amount.isNegative()) throw new CalculationError('Adjustment amounts must be positive; the type sets the direction.');
    groups[def.group] = groups[def.group].plus(amount);
  }

  const totalDeductions = leaseResult.amount.plus(groups.fares).plus(groups.otherDeductions);
  const totalAdditions = groups.reimbursements.plus(groups.otherIncome);
  const net = gross.minus(totalDeductions).plus(totalAdditions);

  const explanation = [
    ...weekResults.map((w) => `Week ${w.weekNumber}: ${fmtMoney(w.weeklyEarnings)}`),
    `Gross VDP: ${weekResults.map((w) => fmtMoney(w.weeklyEarnings)).join(' + ')} = ${fmtMoney(gross)}`,
    leaseResult.explanation,
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
    step('Lift lease', leaseResult.detail, `−${fmtMoney(leaseResult.amount)}`, 'minus'),
  ];
  if (groups.fares.gt(0)) steps.push(step('Fares collected', entries('fares'), `−${fmtMoney(groups.fares)}`, 'minus'));
  if (groups.otherDeductions.gt(0)) steps.push(step('Other deductions', entries('otherDeductions'), `−${fmtMoney(groups.otherDeductions)}`, 'minus'));
  if (groups.reimbursements.gt(0)) steps.push(step('Reimbursements', entries('reimbursements'), `+${fmtMoney(groups.reimbursements)}`, 'plus'));
  if (groups.otherIncome.gt(0)) steps.push(step('Other income', entries('otherIncome'), `+${fmtMoney(groups.otherIncome)}`, 'plus'));
  steps.push(step('Net VDP payment', '', fmtMoney(net), 'total'));

  return {
    weeks: weekResults,
    gross,
    lease: leaseResult.amount,
    leaseWeeksCharged: leaseResult.weeksCharged ?? null,
    fares: groups.fares,
    otherDeductions: groups.otherDeductions,
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
export function serializeResult(r) {
  return {
    weeks: r.weeks.map((w) => ({
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
    })),
    gross: money(r.gross),
    lease: money(r.lease),
    leaseWeeksCharged: str(r.leaseWeeksCharged),
    fares: money(r.fares),
    otherDeductions: money(r.otherDeductions),
    reimbursements: money(r.reimbursements),
    otherIncome: money(r.otherIncome),
    totalDeductions: money(r.totalDeductions),
    totalAdditions: money(r.totalAdditions),
    net: money(r.net),
    explanation: r.explanation,
    steps: r.steps,
  };
}
