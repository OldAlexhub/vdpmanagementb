// Plan version resolution and provider inheritance. The Provider profile UI and the
// calculation both use resolveSettings(), so the screen shows exactly what the math uses.
import { D, isBlank, str } from './money.js';
import { validateTiers } from './tiers.js';
import { toDateOnly, addDays } from './cycleService.js';

export const FUEL_METHODS = ['NONE', 'PER_TRIP', 'SERVICE_MILE_ALLOWANCE'];
export const SERVICE_MILE_ALLOWANCE = 'SERVICE_MILE_ALLOWANCE';
export const CALCULATION_TYPES = ['STANDARD', 'UBER'];

export const DEFAULT_UBER_CONFIG = {
  coreRatePct: '0.65',
  approvedExtraHours: '0',
  contractHoursIncentiveTiers: [
    { minimum: '0.94', rate: '0.05' },
    { minimum: '0.96', rate: '0.10' },
    { minimum: '0.98', rate: '0.20' },
  ],
  acceptanceIncentiveTiers: [
    { minimum: '0.92', rate: '0.05' },
    { minimum: '0.95', rate: '0.10' },
  ],
  cancellationIncentiveTiers: [
    { maximum: '0.04', rate: '0.10' },
    { maximum: '0.05', rate: '0.05' },
  ],
  utilizationTarget: '0.70',
  utilizationIncentivePct: '0.05',
  coreHoursRequirement: '0.60',
};

// Versions saved before fuelMethod existed only had the per-trip switch.
export const fuelMethodOf = (v) => v?.fuelMethod || (v?.fuelReimbursementEnabled ? 'PER_TRIP' : 'NONE');

const calculationTypeOf = (v) => v?.calculationType || 'STANDARD';

function validateRatio(value, label, errors, { max = 1 } = {}) {
  if (isBlank(value)) errors.push(`${label} is required.`);
  else if (D(value).lt(0) || D(value).gt(max)) errors.push(`${label} must be between 0 and ${max}.`);
}

function validateMinimumTiers(tiers, label, errors, maxThreshold) {
  if (!tiers?.length) {
    errors.push(`${label} need at least one configured tier.`);
    return;
  }
  let previous = null;
  tiers.forEach((t, i) => {
    if (isBlank(t.minimum)) errors.push(`${label} tier ${i + 1} minimum is required.`);
    else {
      const minimum = D(t.minimum);
      if (minimum.lt(0) || minimum.gt(maxThreshold)) errors.push(`${label} tier ${i + 1} minimum is outside the allowed range.`);
      if (previous !== null && minimum.lte(previous)) errors.push(`${label} tier minimums must increase without duplicates.`);
      previous = minimum;
    }
    validateRatio(t.rate, `${label} tier ${i + 1} rate`, errors);
  });
}

function validateMaximumTiers(tiers, label, errors) {
  if (!tiers?.length) {
    errors.push(`${label} need at least one configured tier.`);
    return;
  }
  let previous = null;
  tiers.forEach((t, i) => {
    if (isBlank(t.maximum)) errors.push(`${label} tier ${i + 1} maximum is required.`);
    else {
      const maximum = D(t.maximum);
      if (maximum.lt(0) || maximum.gt(1)) errors.push(`${label} tier ${i + 1} maximum must be between 0 and 1.`);
      if (previous !== null && maximum.lte(previous)) errors.push(`${label} tier maximums must increase without duplicates.`);
      previous = maximum;
    }
    validateRatio(t.rate, `${label} tier ${i + 1} rate`, errors);
  });
}

export function validateVersion(v) {
  const errors = [];
  const calculationType = calculationTypeOf(v);
  if (!CALCULATION_TYPES.includes(calculationType)) errors.push('Calculation type must be Standard or Uber.');
  if (!['HOURLY', 'PER_TRIP'].includes(v.paymentType)) errors.push('Payment type must be Hourly or Per Trip.');
  if (calculationType !== 'UBER' && (isBlank(v.basePay) || D(v.basePay).lte(0))) errors.push('Base pay must be greater than zero.');
  if (!v.effectiveFrom) errors.push('Effective from date is required.');
  if (v.effectiveTo && v.effectiveFrom && toDateOnly(v.effectiveTo) < toDateOnly(v.effectiveFrom)) {
    errors.push('Effective to date is before effective from.');
  }
  if (calculationType !== 'UBER' && v.paymentType === 'HOURLY' && (isBlank(v.contractedHours) || D(v.contractedHours).lte(0))) {
    errors.push('Hourly plans need contracted hours per week.');
  }
  if (calculationType === 'UBER') {
    if (v.paymentType !== 'HOURLY') errors.push('Uber plans use an hourly base rate.');
    const u = v.uberConfig || {};
    validateRatio(u.coreRatePct, 'Uber core rate percentage', errors);
    if (isBlank(u.approvedExtraHours) || D(u.approvedExtraHours).lt(0)) errors.push('Uber approved extra hours cannot be negative.');
    validateMinimumTiers(u.contractHoursIncentiveTiers, 'Uber contract-hours incentive tiers', errors, 10);
    validateMinimumTiers(u.acceptanceIncentiveTiers, 'Uber acceptance incentive tiers', errors, 1);
    validateMaximumTiers(u.cancellationIncentiveTiers, 'Uber cancellation incentive tiers', errors);
    validateRatio(u.utilizationTarget, 'Uber utilization target', errors);
    validateRatio(u.utilizationIncentivePct, 'Uber utilization incentive percentage', errors);
    validateRatio(u.coreHoursRequirement, 'Uber core-hours requirement', errors);
    return errors;
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
    calculationType: { value: calculationTypeOf(version), source: 'PLAN' },
    paymentType: { value: version.paymentType, source: 'PLAN' },
    basePay: calculationTypeOf(version) === 'UBER'
      ? { value: str(o.basePay), source: isBlank(o.basePay) ? null : 'PROVIDER_PROFILE' }
      : pick(o.basePay, version.basePay),
    contractedHours: calculationTypeOf(version) === 'UBER'
      ? { value: null, source: 'OPERATOR_PROFILE' }
      : pick(o.contractedHours, version.contractedHours),
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
    uberConfig: calculationTypeOf(version) === 'UBER'
      ? {
          value: {
            coreRatePct: str(version.uberConfig?.coreRatePct),
            approvedExtraHours: str(version.uberConfig?.approvedExtraHours) ?? '0',
            contractHoursIncentiveTiers: (version.uberConfig?.contractHoursIncentiveTiers || []).map((t) => ({ minimum: str(t.minimum), rate: str(t.rate) })),
            acceptanceIncentiveTiers: (version.uberConfig?.acceptanceIncentiveTiers || []).map((t) => ({ minimum: str(t.minimum), rate: str(t.rate) })),
            cancellationIncentiveTiers: (version.uberConfig?.cancellationIncentiveTiers || []).map((t) => ({ maximum: str(t.maximum), rate: str(t.rate) })),
            utilizationTarget: str(version.uberConfig?.utilizationTarget),
            utilizationIncentivePct: str(version.uberConfig?.utilizationIncentivePct),
            coreHoursRequirement: str(version.uberConfig?.coreHoursRequirement),
          },
          source: 'PLAN',
        }
      : { value: null, source: 'PLAN' },
  };
}

// Flatten resolved settings for the engine.
export const engineSettings = (s) => ({
  calculationType: s.calculationType?.value || 'STANDARD',
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

export const uberEngineSettings = (s, operatorContractedHours = null, operatorBasePay = null, operatorBasePaySource = null) => ({
  baseHourlyRate: str(operatorBasePay),
  baseHourlyRateSource: isBlank(operatorBasePay) ? null : operatorBasePaySource || 'OPERATOR_PROFILE',
  contractedWeeklyHours: str(operatorContractedHours),
  contractedWeeklyHoursSource: operatorContractedHours === null ? null : 'OPERATOR_PROFILE',
  ...(s.uberConfig?.value || {}),
});
