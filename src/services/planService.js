// Plan version resolution and provider inheritance. The Provider profile UI and the
// calculation both use resolveSettings(), so the screen shows exactly what the math uses.
import { D, isBlank, str } from './money.js';
import { validateTiers } from './tiers.js';
import { toDateOnly, addDays } from './cycleService.js';

export const FUEL_METHODS = ['NONE', 'PER_TRIP', 'SERVICE_MILE_ALLOWANCE'];
export const SERVICE_MILE_ALLOWANCE = 'SERVICE_MILE_ALLOWANCE';

// Versions saved before fuelMethod existed only had the per-trip switch.
export const fuelMethodOf = (v) => v?.fuelMethod || (v?.fuelReimbursementEnabled ? 'PER_TRIP' : 'NONE');

export function validateVersion(v) {
  const errors = [];
  if (!['HOURLY', 'PER_TRIP'].includes(v.paymentType)) errors.push('Payment type must be Hourly or Per Trip.');
  if (isBlank(v.basePay) || D(v.basePay).lte(0)) errors.push('Base pay must be greater than zero.');
  if (!v.effectiveFrom) errors.push('Effective from date is required.');
  if (v.effectiveTo && v.effectiveFrom && toDateOnly(v.effectiveTo) < toDateOnly(v.effectiveFrom)) {
    errors.push('Effective to date is before effective from.');
  }
  if (v.paymentType === 'HOURLY' && (isBlank(v.contractedHours) || D(v.contractedHours).lte(0))) {
    errors.push('Hourly plans need contracted hours per week.');
  }
  if (v.bonusEnabled) {
    if (v.paymentType !== 'HOURLY') errors.push('Bonus hours apply to hourly plans only.');
    if (isBlank(v.bonusRate) || D(v.bonusRate).lte(0)) errors.push('Bonus rate must be greater than zero.');
  }
  const fuel = fuelMethodOf(v);
  if (!FUEL_METHODS.includes(fuel)) errors.push('Choose a fuel method.');
  if (fuel === 'PER_TRIP' && (isBlank(v.fuelReimbursementRate) || D(v.fuelReimbursementRate).lte(0))) {
    errors.push('Fuel reimbursement rate (per trip) must be greater than zero.');
  }
  if (fuel === SERVICE_MILE_ALLOWANCE && (isBlank(v.fuelMpg) || D(v.fuelMpg).lte(0))) {
    errors.push('Fuel efficiency (MPG) must be greater than zero for the service mile allowance.');
  }
  if (v.incentiveEnabled) {
    if (isBlank(v.contractedHours) || D(v.contractedHours).lte(0)) {
      errors.push('TUI tiers need contracted hours to measure performance %.');
    }
    errors.push(...validateTiers(v.incentiveTiers || []));
  } else if ((v.incentiveTiers || []).length) {
    // Tiers kept while TUI is switched off must still be valid so it can be switched back on.
    errors.push(...validateTiers(v.incentiveTiers).map((e) => `${e} (TUI is off, but the tiers are kept)`));
  }
  if (v.performanceHourMetric === 'OTHER' && isBlank(v.performanceHourColumn)) {
    errors.push('Choose the report column to use for the "Other" hour metric.');
  }
  return errors;
}

// Version effective on the cycle start + whether a different version starts inside the cycle.
export function resolveVersion(plan, cycle) {
  const start = toDateOnly(cycle.cycleStart).getTime();
  const end = toDateOnly(cycle.cycleEnd).getTime();
  const covers = (v, t) =>
    toDateOnly(v.effectiveFrom).getTime() <= t && (!v.effectiveTo || toDateOnly(v.effectiveTo).getTime() >= t);
  const version = plan.versions.find((v) => covers(v, start)) || null;
  const changesMidCycle = plan.versions.some((v) => {
    const f = toDateOnly(v.effectiveFrom).getTime();
    return v !== version && f > start && f <= end;
  }) || (version?.effectiveTo && toDateOnly(version.effectiveTo).getTime() < end);
  return { version, changesMidCycle: Boolean(changesMidCycle) };
}

// Current version = the one effective today, else the latest.
export function currentVersion(plan, today = new Date()) {
  const t = toDateOnly(today).getTime();
  const sorted = [...plan.versions].sort((a, b) => a.effectiveFrom - b.effectiveFrom);
  return (
    sorted.find((v) => toDateOnly(v.effectiveFrom).getTime() <= t && (!v.effectiveTo || toDateOnly(v.effectiveTo).getTime() >= t)) ||
    sorted[sorted.length - 1] ||
    null
  );
}

// When a new version starts, the previous open-ended version ends the day before.
export function closePreviousVersion(plan, newFrom) {
  const from = toDateOnly(newFrom);
  for (const v of plan.versions) {
    if (toDateOnly(v.effectiveFrom) < from && (!v.effectiveTo || toDateOnly(v.effectiveTo) >= from)) {
      v.effectiveTo = addDays(from, -1);
    }
  }
}

/**
 * Effective payment settings for a provider on a plan version.
 * Every value carries its source: PLAN or PROVIDER_OVERRIDE.
 */
export function resolveSettings(provider, plan, version) {
  const o = provider.overrides || {};
  const pick = (overrideValue, planValue) =>
    isBlank(overrideValue)
      ? { value: str(planValue), source: 'PLAN' }
      : { value: str(overrideValue), source: 'PROVIDER_OVERRIDE' };

  const tuiSource = !o.tuiEligibility || o.tuiEligibility === 'INHERIT' ? 'PLAN' : 'PROVIDER_OVERRIDE';
  const tuiEligible = tuiSource === 'PLAN' ? Boolean(version.incentiveEnabled) : o.tuiEligibility === 'ON';

  return {
    planId: plan._id,
    planName: plan.name,
    versionId: version._id,
    versionNumber: version.versionNumber,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    paymentType: { value: version.paymentType, source: 'PLAN' },
    basePay: pick(o.basePay, version.basePay),
    contractedHours: pick(o.contractedHours, version.contractedHours),
    bonusEnabled: { value: Boolean(version.bonusEnabled), source: 'PLAN' },
    bonusRate: pick(o.bonusRate, version.bonusRate),
    tuiEligible: { value: tuiEligible, source: tuiSource },
    fuelMethod: { value: fuelMethodOf(version), source: 'PLAN' },
    fuelReimbursementEnabled: { value: fuelMethodOf(version) === 'PER_TRIP', source: 'PLAN' },
    fuelReimbursementRate: { value: fuelMethodOf(version) === 'PER_TRIP' ? str(version.fuelReimbursementRate) : null, source: 'PLAN' },
    fuelMpg: fuelMethodOf(version) === SERVICE_MILE_ALLOWANCE ? pick(o.fuelMpg, version.fuelMpg) : { value: null, source: 'PLAN' },
    fuelMileageSource: { value: fuelMethodOf(version) === SERVICE_MILE_ALLOWANCE ? version.fuelMileageSource || 'SERVICE_MILES' : null, source: 'PLAN' },
    incentiveTiers: {
      value: (version.incentiveTiers || []).map((t) => ({
        minimumPercentage: str(t.minimumPercentage),
        maximumPercentage: str(t.maximumPercentage),
        rate: str(t.rate),
      })),
      source: 'PLAN',
    },
    performanceHourMetric: { value: version.performanceHourMetric, source: 'PLAN' },
    performanceHourColumn: { value: version.performanceHourColumn || null, source: 'PLAN' },
  };
}

// Flatten resolved settings for the engine.
export const engineSettings = (s) => ({
  paymentType: s.paymentType.value,
  basePay: s.basePay.value,
  contractedHours: s.contractedHours.value,
  tuiEligible: s.tuiEligible.value,
  incentiveTiers: s.incentiveTiers.value,
  bonusEnabled: s.bonusEnabled.value,
  bonusRate: s.bonusRate.value,
  fuelReimbursementEnabled: Boolean(s.fuelReimbursementEnabled?.value),
  fuelReimbursementRate: s.fuelReimbursementRate?.value ?? null,
  fuelMethod: s.fuelMethod?.value || (s.fuelReimbursementEnabled?.value ? 'PER_TRIP' : 'NONE'),
  fuelMpg: s.fuelMpg?.value ?? null,
});
