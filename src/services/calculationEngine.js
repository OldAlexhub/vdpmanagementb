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

const contractedForWeek = (settings, week) => D(isBlank(week.contractedHours) ? settings.contractedHours : week.contractedHours);
const attainmentForWeek = (week) => D(isBlank(week.attainmentHours) ? week.actualHours : week.attainmentHours);

function attainmentPercentage(settings, week, contractedHours) {
  if (!isBlank(week.performancePercentageOverride)) return D(week.performancePercentageOverride);
  return attainmentForWeek(week).div(contractedHours).times(100);
}

function bonusQualification(settings, week, actualHours, attainmentHours, contractedHours) {
  const metric = settings.bonusQualificationMetric === 'ATTAINMENT_HOURS' ? attainmentHours : actualHours;
  const threshold = D(settings.bonusQualificationPercentage ?? 100);
  const hoursPassed = metric.div(contractedHours).times(100).gte(threshold);
  const daysPassed = !settings.bonusRequiresContractedDays
    || (!isBlank(week.workedDays) && !isBlank(settings.contractedDays) && D(week.workedDays).gte(settings.contractedDays));
  return { passed: hoursPassed && daysPassed, hoursPassed, daysPassed, metric, threshold };
}

function applyStandby(settings, week, normalEarnings, selectedRate) {
  const status = week.standbyStatus || 'NOT_APPLICABLE';
  if (!settings.standbyGuaranteeEnabled || status === 'NOT_APPLICABLE' || status === 'FORFEITED') {
    return { status, guaranteedHours: D(0), rate: D(0), proration: D(0), guaranteedEarnings: D(0), topUp: D(0), weeklyEarnings: normalEarnings };
  }
  if (!['QUALIFIED', 'FORCE_MAJEURE'].includes(status)) throw new CalculationError(`Unknown standby status "${status}".`);
  const directAmount = isBlank(week.standbyGuaranteeAmount) ? null : D(week.standbyGuaranteeAmount);
  const guaranteedHours = directAmount === null
    ? D(isBlank(week.standbyGuaranteedHours) ? contractedForWeek(settings, week) : week.standbyGuaranteedHours)
    : D(0);
  const rate = directAmount === null ? D(isBlank(settings.standbyRate) ? selectedRate : settings.standbyRate) : D(0);
  const proration = status === 'FORCE_MAJEURE' ? D(week.standbyProration ?? 1) : D(1);
  if (guaranteedHours.lt(0) || rate.lt(0) || proration.lt(0) || proration.gt(1)) {
    throw new CalculationError('Standby hours, rate, or proration are invalid.');
  }
  if (directAmount?.lt(0)) throw new CalculationError('Standby guarantee amount cannot be negative.');
  const guaranteedEarnings = cents((directAmount ?? guaranteedHours.times(rate)).times(proration));
  const topUp = max(guaranteedEarnings.minus(normalEarnings), 0);
  return { status, guaranteedHours, rate, proration, guaranteedEarnings, topUp, weeklyEarnings: normalEarnings.plus(topUp) };
}

function calculateHourlyWeek(settings, week) {
  const actualHours = D(week.actualHours);
  const attainmentHours = attainmentForWeek(week);
  const contractedHours = contractedForWeek(settings, week);
  if (contractedHours.lte(0)) throw new CalculationError('Contracted hours must be greater than zero.');

  const pct = attainmentPercentage(settings, week, contractedHours);
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

  const qualification = bonusQualification(settings, week, actualHours, attainmentHours, contractedHours);
  const bonusApplies = settings.bonusEnabled && qualification.passed && actualHours.gt(contractedHours);
  const corePaidHours = settings.bonusEnabled ? min(actualHours, contractedHours) : actualHours;
  const bonusHours = bonusApplies ? max(actualHours.minus(contractedHours), 0) : D(0);
  const bonusRate = settings.bonusEnabled ? D(settings.bonusRate) : D(0);
  const coreEarnings = cents(corePaidHours.times(rate));
  const bonusEarnings = cents(bonusHours.times(bonusRate));
  const normalEarnings = coreEarnings.plus(bonusEarnings);
  const standby = applyStandby(settings, week, normalEarnings, rate);
  const weeklyEarnings = standby.weeklyEarnings;

  const explanation = [
    `Actual hours: ${fmtNum(actualHours)}`,
    `Contracted hours: ${fmtNum(contractedHours)}`,
    `Incentive attainment: ${fmtNum(attainmentHours)} ÷ ${fmtNum(contractedHours)} × 100 = ${pct.toFixed(3)}%`,
    settings.tuiEligible
      ? `Incentive tier ${label} → rate ${fmtRate(rate)}`
      : `TUI not applied → base rate ${fmtRate(rate)}`,
    `Core hours: ${fmtNum(corePaidHours)}` + (settings.bonusEnabled ? ` (lesser of actual and contracted)` : ''),
    `Bonus hours: ${fmtNum(bonusHours)}` +
      (settings.bonusEnabled ? ` (hours above ${fmtNum(contractedHours)})` : ' (bonus not part of this plan)'),
    `Core: ${fmtNum(corePaidHours)} × ${fmtRate(rate)} = ${fmtMoney(coreEarnings)}`,
    `Bonus: ${fmtNum(bonusHours)} × ${fmtRate(bonusRate)} = ${fmtMoney(bonusEarnings)}`,
    ...(standby.topUp.gt(0) ? [`Standby guarantee top-up: ${fmtMoney(standby.topUp)}`] : []),
    `Week ${week.weekNumber}: ${fmtMoney(weeklyEarnings)}`,
  ];

  const steps = [
    step('Hours worked', 'Performance Report', fmtHours(actualHours)),
    step('Contracted hours', 'per week', fmtHours(contractedHours)),
    step('Incentive attainment', `${fmtNum(attainmentHours)} ÷ ${fmtNum(contractedHours)}`, fmtPct(pct)),
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
      bonusApplies ? `${fmtNum(bonusHours)} h above contract × ${fmtRate(bonusRate)}` : qualification.passed ? 'No hours above contract' : 'Bonus qualification not met',
      fmtMoney(bonusEarnings),
      'money',
    ));
  }
  if (standby.topUp.gt(0)) {
    steps.push(step('Standby guarantee', `${fmtNum(standby.guaranteedHours)} h × ${fmtRate(standby.rate)} × ${fmtNum(standby.proration)}`, fmtMoney(standby.topUp), 'plus'));
  }
  steps.push(step(`Week ${week.weekNumber} total`, '', fmtMoney(weeklyEarnings), 'total'));

  return {
    performancePercentage: pct,
    attainmentHours,
    tierLabel: label,
    tierIndex,
    steps,
    incentiveRate: rate,
    corePaidHours,
    bonusHours,
    bonusRate,
    coreEarnings,
    bonusEarnings,
    bonusQualified: qualification.passed,
    standby,
    weeklyEarnings,
    explanation,
  };
}

function calculatePerTripWeek(settings, week) {
  const trips = D(week.trips);
  const actualHours = D(week.actualHours);
  const attainmentHours = attainmentForWeek(week);
  const rawContracted = isBlank(week.contractedHours) ? settings.contractedHours : week.contractedHours;
  const contracted = isBlank(rawContracted) ? null : D(rawContracted);
  const pct = contracted && contracted.gt(0) ? attainmentPercentage(settings, week, contracted) : null;

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
  const qualification = contracted && contracted.gt(0)
    ? bonusQualification(settings, week, actualHours, attainmentHours, contracted)
    : { passed: false };
  const bonusTrips = settings.bonusEnabled && settings.bonusBasis === 'SIXTH_DAY_TRIPS' && qualification.passed
    ? D(week.bonusTrips || 0) : D(0);
  const bonusRate = settings.bonusEnabled ? D(settings.bonusRate || 0) : D(0);
  const bonusEarnings = cents(bonusTrips.times(bonusRate));
  const standby = applyStandby(settings, week, coreEarnings.plus(bonusEarnings), rate);
  const explanation = [
    `Trips provided: ${fmtNum(trips)}`,
    `Attainment hours: ${fmtNum(attainmentHours)}` + (pct ? ` (${pct.toFixed(3)}% of ${fmtNum(contracted)} contracted)` : ''),
    settings.tuiEligible
      ? `Incentive tier ${label} → ${fmtRate(rate)} per trip`
      : `TUI not applied → ${fmtRate(rate)} per trip`,
    `Trips: ${fmtNum(trips)} × ${fmtRate(rate)} = ${fmtMoney(coreEarnings)}`,
    ...(bonusTrips.gt(0) ? [`Sixth-day bonus: ${fmtNum(bonusTrips)} trips × ${fmtRate(bonusRate)} = ${fmtMoney(bonusEarnings)}`] : []),
    ...(standby.topUp.gt(0) ? [`Standby guarantee top-up: ${fmtMoney(standby.topUp)}`] : []),
    `Week ${week.weekNumber}: ${fmtMoney(standby.weeklyEarnings)}`,
  ];
  const steps = [
    step('Trips provided', 'Performance Report', `${fmtNum(trips)} trips`),
    step('Incentive attainment', pct ? `${fmtPct(pct)} of ${fmtNum(contracted)} h` : 'Performance Report', fmtHours(attainmentHours)),
    step('Rate', settings.tuiEligible ? `Tier ${label}` : 'Per-trip rate (no TUI)', `${fmtRate(rate)} / trip`),
    step('Trip pay', `${fmtNum(trips)} trips × ${fmtRate(rate)}`, fmtMoney(coreEarnings), 'money'),
  ];
  if (settings.bonusEnabled && settings.bonusBasis === 'SIXTH_DAY_TRIPS') {
    steps.push(step('Sixth-day bonus', qualification.passed ? `${fmtNum(bonusTrips)} qualifying trips × ${fmtRate(bonusRate)}` : 'Bonus qualification not met', fmtMoney(bonusEarnings), 'money'));
  }
  if (standby.topUp.gt(0)) {
    steps.push(step('Standby guarantee', `${fmtNum(standby.guaranteedHours)} h × ${fmtRate(standby.rate)}`, fmtMoney(standby.topUp), 'plus'));
  }
  steps.push(step(`Week ${week.weekNumber} total`, '', fmtMoney(standby.weeklyEarnings), 'total'));
  return {
    performancePercentage: pct,
    attainmentHours,
    tierLabel: label,
    tierIndex,
    steps,
    incentiveRate: rate,
    corePaidHours: actualHours,
    bonusHours: bonusTrips,
    bonusRate,
    coreEarnings,
    bonusEarnings,
    bonusQualified: qualification.passed,
    standby,
    weeklyEarnings: standby.weeklyEarnings,
    explanation,
  };
}

const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

function lineDayType(line) {
  if (line.dayType) return line.dayType;
  if (!line.date) return 'ANY';
  const day = new Date(`${line.date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6 ? 'WEEKEND' : 'WEEKDAY';
}

function componentMatches(component, line) {
  if (component.serviceType && !sameText(component.serviceType, line.serviceType)) return false;
  if (component.vehicleType && !sameText(component.vehicleType, line.vehicleType)) return false;
  if (component.dayType && component.dayType !== 'ANY' && component.dayType !== lineDayType(line)) return false;
  if (!isBlank(component.minimumDistance) || !isBlank(component.maximumDistance)) {
    const trips = D(line.trips || 0);
    const distance = !isBlank(line.distance) ? D(line.distance)
      : trips.gt(0) && !isBlank(line.miles) ? D(line.miles).div(trips) : null;
    if (distance === null) return false;
    if (!isBlank(component.minimumDistance) && distance.lt(component.minimumDistance)) return false;
    if (!isBlank(component.maximumDistance) && distance.gt(component.maximumDistance)) return false;
  }
  return true;
}

function componentQuantity(component, line) {
  if (component.basis === 'HOURS') return D(line.hours || 0);
  if (component.basis === 'TRIPS') return D(line.trips || 0);
  if (component.basis === 'MILES') return D(line.miles || 0);
  if (component.basis === 'EXCESS_MILES') {
    return max(D(line.miles || 0).minus(D(line.trips || 0).times(component.includedMiles || 0)), 0);
  }
  throw new CalculationError(`Unknown rate-card basis "${component.basis}".`);
}

function calculateRateCardWeek(settings, week) {
  const actualHours = D(week.actualHours || 0);
  const attainmentHours = attainmentForWeek(week);
  const contracted = isBlank(week.contractedHours) ? settings.contractedHours : week.contractedHours;
  const needsAttainment = settings.tuiEligible || (settings.rateCards || []).length > 1;
  if (needsAttainment && (isBlank(contracted) || D(contracted).lte(0))) {
    throw new CalculationError('Contracted hours are required to select an attainment rate card.');
  }
  const pct = isBlank(contracted) || D(contracted).lte(0) ? null : attainmentPercentage(settings, week, D(contracted));
  const cards = settings.rateCards || [];
  const selected = settings.tuiEligible || cards.length > 1
    ? selectTier(cards.map((card) => ({ ...card, rate: '0' })), pct)
    : (cards[0] ? { ...cards[0], index: 0 } : null);
  if (!selected) throw new CalculationError(`No rate card covers ${pct?.toFixed(3) ?? 'this week'}%.`);

  const lines = week.lineItems?.length ? week.lineItems : [{
    hours: week.actualHours || 0,
    trips: week.trips || 0,
    miles: week.serviceMiles || 0,
    serviceType: week.serviceType,
    vehicleType: week.vehicleType,
    dayType: week.dayType || 'ANY',
  }];
  const breakdown = [];
  lines.forEach((line, lineIndex) => {
    const matches = (selected.components || []).filter((component) => componentMatches(component, line));
    if (!matches.length && [line.hours, line.trips, line.miles].some((value) => !isBlank(value) && D(value).gt(0))) {
      throw new CalculationError(`Rate card "${selected.name}" has no matching component for service line ${lineIndex + 1}.`);
    }
    matches.forEach((component) => {
      const quantity = componentQuantity(component, line);
      const amount = cents(quantity.times(component.rate));
      breakdown.push({
        line: lineIndex + 1,
        name: component.name,
        basis: component.basis,
        quantity,
        rate: D(component.rate),
        amount,
        serviceType: line.serviceType || null,
        vehicleType: line.vehicleType || null,
        dayType: lineDayType(line),
      });
    });
  });
  const coreEarnings = sum(breakdown.map((entry) => entry.amount));
  const standby = applyStandby(settings, week, coreEarnings, settings.standbyRate || 0);
  const steps = [
    ...(pct === null ? [] : [step('Incentive attainment', `${fmtNum(attainmentHours)} / ${fmtNum(contracted)}`, fmtPct(pct))]),
    ...breakdown.map((entry) => step(entry.name, `${fmtNum(entry.quantity)} ${entry.basis.toLowerCase()} x ${fmtRate(entry.rate)}`, fmtMoney(entry.amount), 'money')),
    ...(standby.topUp.gt(0) ? [step('Standby guarantee', `${fmtNum(standby.guaranteedHours)} h x ${fmtRate(standby.rate)}`, fmtMoney(standby.topUp), 'plus')] : []),
    step(`Week ${week.weekNumber} total`, selected.name, fmtMoney(standby.weeklyEarnings), 'total'),
  ];
  return {
    performancePercentage: pct,
    attainmentHours,
    tierLabel: selected.name,
    tierIndex: selected.index,
    incentiveRate: null,
    corePaidHours: actualHours,
    bonusHours: D(0),
    bonusRate: D(0),
    coreEarnings,
    bonusEarnings: D(0),
    bonusQualified: false,
    standby,
    rateCardBreakdown: breakdown,
    weeklyEarnings: standby.weeklyEarnings,
    steps,
    explanation: [
      `Rate card: ${selected.name}${pct === null ? '' : ` at ${pct.toFixed(3)}% attainment`}`,
      ...breakdown.map((entry) => `${entry.name}: ${fmtNum(entry.quantity)} x ${fmtRate(entry.rate)} = ${fmtMoney(entry.amount)}`),
      `Week ${week.weekNumber}: ${fmtMoney(standby.weeklyEarnings)}`,
    ],
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

// The fuel price in effect on a service date (YYYY-MM-DD strings sort as dates).
export const priceOn = (prices, day) =>
  (prices || []).find((p) => p.effectiveFrom <= day && (!p.effectiveTo || p.effectiveTo >= day)) || null;

/**
 * Service mile fuel allowance (plan option). Per service date:
 *   allowed gallons = service miles ÷ MPG (e.g. 19)
 *   allowed fuel    = allowed gallons × the fuel price per gallon in effect that day
 * Daily values keep full precision; the sum is rounded once to cents (Maximum Allowed Fuel).
 * Only the actual expense above the maximum is deducted — an unused allowance is not income.
 * @param {object} input
 * @param {string} input.mpg     the plan's MPG (a day may carry its own: operator on another plan)
 * @param {Array}  input.days    [{ date, week, serviceMiles, pricePerGallon, mpg?, operator? }]
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
    if (isBlank(d.pricePerGallon)) throw new CalculationError(`No fuel price configured for ${d.date}.`);
    const miles = D(d.serviceMiles);
    const m = divisor(d.mpg ?? mpg);
    const price = D(d.pricePerGallon);
    const gallons = miles.div(m);
    return { date: d.date, week: d.week, operator: d.operator ?? null, serviceMiles: miles, mpg: m, gallons, pricePerGallon: price, allowed: gallons.times(price) };
  });
  const mpgs = [...new Set(daily.map((d) => d.mpg.toString()))];
  const m = mpgs.length === 1 ? D(mpgs[0]) : isBlank(mpg) ? null : D(mpg);
  const serviceMiles = sum(daily.map((d) => d.serviceMiles));
  const weekMiles = [1, 2].map((n) => sum(daily.filter((d) => d.week === n).map((d) => d.serviceMiles)));
  const gallons = sum(daily.map((d) => d.gallons));
  const pricesUsed = [...new Set(daily.map((d) => d.pricePerGallon.toString()))];
  const maxAllowed = cents(sum(daily.map((d) => d.allowed)));
  const entered = !isBlank(actualExpense);
  const actual = entered ? cents(actualExpense) : null;
  if (actual && actual.isNegative()) throw new CalculationError('Actual fuel expense cannot be negative.');
  const overspend = entered ? max(actual.minus(maxAllowed), 0) : D(0);
  const allowance = `${fmtNum(serviceMiles)} service miles ÷ ${mpgs.length > 1 ? `each operator’s MPG (${mpgs.join(' / ')})` : `${fmtNum(mpgs[0] ?? mpg)} MPG`}`
    + ` × fuel price per day (${pricesUsed.map((pr) => fmtRate(pr)).join(', ')}/gal) = ${fmtMoney(maxAllowed)} maximum`;
  return {
    enabled: true,
    mpg: mpgs.length > 1 ? null : m,
    mpgs,
    serviceMiles,
    weekMiles,
    gallons,
    pricesUsed,
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

export function calculateFuelPriceSurcharge({ mpg, threshold, days }) {
  if (!days?.length) throw new CalculationError('Service-mile fuel surcharge needs daily service miles and fuel prices.');
  const daily = days.map((day) => {
    const m = D(day.mpg ?? mpg);
    const floor = D(day.threshold ?? threshold);
    if (m.lte(0)) throw new CalculationError('Fuel MPG configuration is missing.');
    if (isBlank(day.serviceMiles)) throw new CalculationError(`Service Miles are missing for ${day.date}.`);
    if (isBlank(day.pricePerGallon)) throw new CalculationError(`No fuel price configured for ${day.date}.`);
    const serviceMiles = D(day.serviceMiles);
    const pricePerGallon = D(day.pricePerGallon);
    const excessPrice = max(pricePerGallon.minus(floor), 0);
    const gallons = serviceMiles.div(m);
    return {
      date: day.date,
      week: day.week,
      operator: day.operator ?? null,
      serviceMiles,
      mpg: m,
      threshold: floor,
      pricePerGallon,
      excessPrice,
      gallons,
      amount: gallons.times(excessPrice),
    };
  });
  const amount = cents(sum(daily.map((day) => day.amount)));
  return {
    enabled: true,
    amount,
    days: daily,
    detail: `${fmtNum(sum(daily.map((day) => day.serviceMiles)))} service miles; price above ${fmtRate(threshold)}/gal`,
    explanation: `Fuel price-threshold surcharge: ${fmtMoney(amount)}`,
  };
}

// One operator: every week measured against this operator's own contract.
function calculateOperator(settings, unit) {
  // An operator on a different VDP plan than the provider brings that plan's settings.
  const base = unit.settings || settings;
  if (!PAYMENT_TYPES.includes(base.paymentType)) throw new CalculationError(`Unsupported payment type "${base.paymentType}".`);
  const s = isBlank(unit.contractedHours) ? base : { ...base, contractedHours: unit.contractedHours };
  const weekFn = s.rateStructureType === 'RATE_CARD'
    ? calculateRateCardWeek
    : s.paymentType === 'HOURLY' ? calculateHourlyWeek : calculatePerTripWeek;
  const weeks = unit.weeks.map((w) => ({
    weekNumber: w.weekNumber,
    start: w.start,
    end: w.end,
    trips: D(w.trips),
    actualHours: D(w.actualHours),
    contractedHours: isBlank(w.contractedHours) ? (isBlank(s.contractedHours) ? null : D(s.contractedHours)) : D(w.contractedHours),
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

function withProviderAttainment(settings, units) {
  const prepared = units.map((unit) => ({ ...unit, weeks: unit.weeks.map((week) => ({ ...week })) }));
  const groups = new Map();
  prepared.forEach((unit) => {
    const effective = unit.settings || settings;
    if (effective.attainmentScope !== 'PROVIDER') return;
    const key = unit.attainmentGroup || unit.plan?.id || (unit.settings ? `settings:${JSON.stringify(effective)}` : 'provider-plan');
    const list = groups.get(key) || [];
    list.push({ unit, effective });
    groups.set(key, list);
  });
  for (const list of groups.values()) {
    const weekCount = Math.max(...list.map(({ unit }) => unit.weeks.length));
    for (let index = 0; index < weekCount; index += 1) {
      const rows = list.map(({ unit, effective }) => ({ unit, effective, week: unit.weeks[index] })).filter(({ week }) => week);
      const attainment = sum(rows.map(({ week }) => attainmentForWeek(week)));
      const contracted = sum(rows.map(({ unit, effective, week }) => contractedForWeek(
        isBlank(unit.contractedHours) ? effective : { ...effective, contractedHours: unit.contractedHours },
        week,
      )));
      if (contracted.lte(0)) throw new CalculationError('Provider-wide attainment needs contracted hours greater than zero.');
      const percentage = attainment.div(contracted).times(100).toString();
      rows.forEach(({ week }) => { week.performancePercentageOverride = percentage; });
    }
  }
  return prepared;
}

// Several operators: the provider's week is the sum of its operators' weeks.
// Tier, rate and % stay per operator (they would be meaningless summed).
function combineWeeks(ops) {
  return ops[0].weeks.map((first, i) => {
    const parts = ops.map((o) => ({ o, w: o.weeks[i] }));
    const total = (k) => sum(parts.map(({ w }) => w[k] ?? 0));
    const contracted = parts.every(({ w }) => w.contractedHours === null) ? null : total('contractedHours');
    const weeklyEarnings = total('weeklyEarnings');
    const line = ({ o, w }) => (o.settings.rateStructureType === 'RATE_CARD'
      ? `${w.tierLabel} rate card`
      : o.settings.paymentType === 'PER_TRIP'
      ? `${fmtNum(w.trips)} trips × ${fmtRate(w.incentiveRate)}`
      : `${fmtNum(w.actualHours)} h of ${fmtNum(w.contractedHours)} (${w.performancePercentage.toFixed(1)}%) · ${w.tierLabel}`);
    return {
      weekNumber: first.weekNumber,
      start: first.start,
      end: first.end,
      trips: total('trips'),
      actualHours: total('actualHours'),
      attainmentHours: total('attainmentHours'),
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
      standbyTopUp: sum(parts.map(({ w }) => w.standby?.topUp || 0)),
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
  const rawUnits = operators?.length ? operators : [{ name: null, weeks, lease }];
  const units = withProviderAttainment(settings, rawUnits);
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
  const usesActualFuel = ops.some((o) => o.settings.fuelMethod === 'ACTUAL_EXPENSE_REIMBURSEMENT');
  if (usesActualFuel && isBlank(fuelInput?.actualExpense)) {
    throw new CalculationError('Actual fuel expense is required for fuel-cost reimbursement.');
  }
  const fuelActualReimbursement = usesActualFuel ? cents(fuelInput.actualExpense) : D(0);
  if (fuelActualReimbursement.lt(0)) throw new CalculationError('Actual fuel expense cannot be negative.');
  const surchargeSettings = ops.find((o) => o.settings.fuelMethod === 'PRICE_THRESHOLD_SURCHARGE')?.settings;
  const fuelSurcharge = surchargeSettings
    ? calculateFuelPriceSurcharge({
      mpg: surchargeSettings.fuelMpg,
      threshold: surchargeSettings.fuelPriceThreshold,
      days: fuelInput?.days || [],
    })
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
  const totalAdditions = fuel.amount.plus(fuelActualReimbursement).plus(fuelSurcharge?.amount || 0)
    .plus(groups.reimbursements).plus(groups.otherIncome);
  const net = gross.minus(totalDeductions).plus(totalAdditions);

  const explanation = [
    ...weekResults.map((w) => `Week ${w.weekNumber}: ${fmtMoney(w.weeklyEarnings)}`),
    `Gross VDP: ${weekResults.map((w) => fmtMoney(w.weeklyEarnings)).join(' + ')} = ${fmtMoney(gross)}`,
    leaseResult.explanation,
    ...(fuel.enabled ? [fuel.explanation] : []),
    ...(allowance ? [allowance.explanation] : []),
    ...(usesActualFuel ? [`Actual fuel-cost reimbursement: ${fmtMoney(fuelActualReimbursement)}`] : []),
    ...(fuelSurcharge ? [fuelSurcharge.explanation] : []),
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
  if (usesActualFuel) steps.push(step('Actual fuel-cost reimbursement', 'Entered expense supported by receipts', `+${fmtMoney(fuelActualReimbursement)}`, 'plus'));
  if (fuelSurcharge) steps.push(step('Fuel price-threshold surcharge', fuelSurcharge.detail, `+${fmtMoney(fuelSurcharge.amount)}`, 'plus'));
  if (groups.reimbursements.gt(0)) steps.push(step('Reimbursements', entries('reimbursements'), `+${fmtMoney(groups.reimbursements)}`, 'plus'));
  if (groups.otherIncome.gt(0)) steps.push(step('Other income', entries('otherIncome'), `+${fmtMoney(groups.otherIncome)}`, 'plus'));
  steps.push(step('Net VDP payment', '', fmtMoney(net), 'total'));

  return {
    weeks: weekResults,
    gross,
    lease: leaseResult.amount,
    operators: ops.map((o) => ({ name: o.name, routes: o.routes, plan: o.plan, paymentType: o.settings.paymentType, rateStructureType: o.settings.rateStructureType || 'SIMPLE', weeks: o.weeks, earnings: o.earnings, lease: o.lease.amount, leaseDetail: o.lease.detail })),
    leaseWeeksCharged: leaseResult.weeksCharged ?? null,
    fares: groups.fares,
    otherDeductions: groups.otherDeductions,
    fuelReimbursement: fuel.amount,
    fuelTrips: fuel.enabled ? fuel.trips : null,
    fuelReimbursementRate: fuel.enabled ? fuel.rate : null,
    fuelReimbursementDetail: fuel.enabled ? fuel.detail : null,
    fuelAllowance: allowance,
    fuelActualReimbursement,
    fuelSurcharge,
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
  attainmentHours: str(w.attainmentHours),
  contractedHours: str(w.contractedHours),
  performancePercentage: w.performancePercentage === null ? null : w.performancePercentage.toDecimalPlaces(6).toString(),
  tierLabel: w.tierLabel,
  incentiveRate: str(w.incentiveRate),
  corePaidHours: str(w.corePaidHours),
  bonusHours: str(w.bonusHours),
  bonusRate: str(w.bonusRate),
  coreEarnings: money(w.coreEarnings),
  bonusEarnings: money(w.bonusEarnings),
  bonusQualified: w.bonusQualified ?? false,
  standby: w.standby ? {
    status: w.standby.status,
    guaranteedHours: str(w.standby.guaranteedHours),
    rate: str(w.standby.rate),
    proration: str(w.standby.proration),
    guaranteedEarnings: money(w.standby.guaranteedEarnings),
    topUp: money(w.standby.topUp),
  } : null,
  rateCardBreakdown: (w.rateCardBreakdown || []).map((entry) => ({
    ...entry,
    quantity: str(entry.quantity),
    rate: str(entry.rate),
    amount: money(entry.amount),
  })),
  weeklyEarnings: money(w.weeklyEarnings),
  tierIndex: w.tierIndex,
  steps: w.steps,
  explanation: w.explanation,
});

// Full precision for miles, gallons, prices and daily allowances; money at cents.
function serializeAllowance(a) {
  if (!a) return null;
  return {
    method: 'SERVICE_MILE_ALLOWANCE',
    mpg: str(a.mpg),
    mpgs: a.mpgs,
    serviceMiles: str(a.serviceMiles),
    weekMiles: a.weekMiles.map(str),
    gallons: str(a.gallons),
    pricesUsed: a.pricesUsed,
    maxAllowed: money(a.maxAllowed),
    actualExpense: a.actualExpense === null ? null : money(a.actualExpense),
    overspend: money(a.overspend),
    unused: a.unused === null ? null : money(a.unused),
    days: a.days.map((d) => ({
      date: d.date,
      week: d.week,
      operator: d.operator,
      serviceMiles: str(d.serviceMiles),
      mpg: str(d.mpg),
      gallons: str(d.gallons),
      pricePerGallon: str(d.pricePerGallon),
      allowed: str(d.allowed),
    })),
  };
}

function serializeSurcharge(surcharge) {
  if (!surcharge) return null;
  return {
    method: 'PRICE_THRESHOLD_SURCHARGE',
    amount: money(surcharge.amount),
    detail: surcharge.detail,
    days: surcharge.days.map((day) => ({
      ...day,
      serviceMiles: str(day.serviceMiles),
      mpg: str(day.mpg),
      threshold: str(day.threshold),
      pricePerGallon: str(day.pricePerGallon),
      excessPrice: str(day.excessPrice),
      gallons: str(day.gallons),
      amount: str(day.amount),
    })),
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
      rateStructureType: o.rateStructureType,
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
    fuelActualReimbursement: money(r.fuelActualReimbursement ?? 0),
    fuelSurcharge: serializeSurcharge(r.fuelSurcharge),
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
