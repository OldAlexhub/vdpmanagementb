import VdpPlan from '../models/VdpPlan.js';
import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import { validateVersion, closePreviousVersion, currentVersion, DEFAULT_UBER_CONFIG } from '../services/planService.js';
import { vdpUsesVersion, markStale } from '../services/vdpService.js';
import { toDateOnly } from '../services/cycleService.js';
import { D } from '../services/money.js';
import { badRequest, conflict, notFound, actor } from '../services/errors.js';
import { decimalInput } from './validate.js';

export function versionInput(body) {
  const calculationType = body.calculationType || 'STANDARD';
  const tiers = (body.incentiveTiers || [])
    .map((t, i) => ({
      minimumPercentage: decimalInput(t.minimumPercentage, `Tier ${i + 1} minimum %`, { required: true }),
      maximumPercentage: decimalInput(t.maximumPercentage, `Tier ${i + 1} maximum %`),
      rate: decimalInput(t.rate, `Tier ${i + 1} rate`, { required: true }),
    }))
    .sort((a, b) => D(a.minimumPercentage).cmp(D(b.minimumPercentage)));
  // Older clients and the bulk import send only the per-trip switch.
  const fuelMethod = body.fuelMethod || (body.fuelReimbursementEnabled ? 'PER_TRIP' : 'NONE');
  const uberSource = calculationType === 'UBER' ? { ...DEFAULT_UBER_CONFIG, ...(body.uberConfig || {}) } : null;
  const uberRateStructureType = uberSource?.rateStructureType || 'FLAT';
  const minimumTiers = (list, label) => (list || [])
    .map((t, i) => ({
      minimum: decimalInput(t.minimum, `${label} tier ${i + 1} minimum`, { required: true, maxDp: 8 }),
      rate: decimalInput(t.rate, `${label} tier ${i + 1} rate`, { required: true, maxDp: 8 }),
    }))
    .sort((a, b) => D(a.minimum).cmp(D(b.minimum)));
  const maximumTiers = (list, label) => (list || [])
    .map((t, i) => ({
      maximum: decimalInput(t.maximum, `${label} tier ${i + 1} maximum`, { required: true, maxDp: 8 }),
      rate: decimalInput(t.rate, `${label} tier ${i + 1} rate`, { required: true, maxDp: 8 }),
    }))
    .sort((a, b) => D(a.maximum).cmp(D(b.maximum)));
  const v = {
    calculationType,
    paymentType: calculationType === 'UBER' ? 'HOURLY' : body.paymentType,
    // Uber rates and hours are operator profile data, not plan-version data.
    basePay: calculationType === 'UBER' ? null : decimalInput(body.basePay, 'Base pay', { required: true }),
    // Uber contract hours belong to each operator on the provider profile. They
    // are deliberately not stored as a plan rule or used as a fallback.
    contractedHours: calculationType === 'UBER' ? null : decimalInput(body.contractedHours, 'Contracted hours'),
    incentiveEnabled: calculationType === 'UBER' ? false : Boolean(body.incentiveEnabled),
    incentiveTiers: calculationType === 'UBER' ? [] : tiers,
    bonusEnabled: calculationType === 'UBER' ? false : Boolean(body.bonusEnabled),
    bonusRate: calculationType === 'UBER' ? null : decimalInput(body.bonusRate, 'Bonus rate'),
    fuelMethod: calculationType === 'UBER' ? 'NONE' : fuelMethod,
    fuelReimbursementEnabled: calculationType === 'STANDARD' && fuelMethod === 'PER_TRIP',
    fuelReimbursementRate: calculationType === 'STANDARD' && fuelMethod === 'PER_TRIP' ? decimalInput(body.fuelReimbursementRate, 'Fuel reimbursement rate') : null,
    fuelMpg: calculationType === 'STANDARD' && fuelMethod === 'SERVICE_MILE_ALLOWANCE' ? decimalInput(body.fuelMpg, 'Fuel efficiency (MPG)') : null,
    fuelMileageSource: 'SERVICE_MILES',
    performanceHourMetric: body.performanceHourMetric || 'TOTAL_HOURS',
    performanceHourColumn: body.performanceHourMetric === 'OTHER' ? body.performanceHourColumn : null,
    uberConfig: uberSource
      ? {
          coreRatePct: decimalInput(uberSource.coreRatePct, 'Uber core rate percentage', { required: true, maxDp: 8 }),
          approvedExtraHours: decimalInput(uberSource.approvedExtraHours, 'Uber approved extra hours', { required: true, maxDp: 8 }),
          minimumFulfillmentForIncentives: decimalInput(uberSource.minimumFulfillmentForIncentives, 'Uber minimum fulfillment for incentives', { required: true, maxDp: 8 }),
          belowThresholdBehavior: uberSource.belowThresholdBehavior || 'FARES_ONLY',
          rateStructureType: uberRateStructureType,
          // A client can retain band rows while the flat-rate option is selected.
          // They are inactive configuration and must not block or leak into the saved version.
          hourlyRateBands: uberRateStructureType === 'HOURLY_BANDS'
            ? (uberSource.hourlyRateBands || [])
              .map((band, i) => ({
                fromHour: decimalInput(band.fromHour, `Hourly rate band ${i + 1} from hour`, { required: true, maxDp: 8 }),
                toHour: decimalInput(band.toHour, `Hourly rate band ${i + 1} to hour`, { required: true, maxDp: 8 }),
                hourlyRate: decimalInput(band.hourlyRate, `Hourly rate band ${i + 1} rate`, { required: true, maxDp: 8 }),
              }))
              .sort((a, b) => D(a.fromHour).cmp(D(b.fromHour)))
            : [],
          contractHoursIncentiveTiers: minimumTiers(uberSource.contractHoursIncentiveTiers, 'Contract-hours incentive'),
          acceptanceIncentiveTiers: minimumTiers(uberSource.acceptanceIncentiveTiers, 'Acceptance incentive'),
          cancellationIncentiveTiers: maximumTiers(uberSource.cancellationIncentiveTiers, 'Cancellation incentive'),
          utilizationEnabled: uberSource.utilizationEnabled !== false,
          utilizationTarget: decimalInput(uberSource.utilizationTarget, 'Uber utilization target', { required: uberSource.utilizationEnabled !== false, maxDp: 8 }),
          utilizationIncentivePct: decimalInput(uberSource.utilizationIncentivePct, 'Uber utilization incentive percentage', { required: uberSource.utilizationEnabled !== false, maxDp: 8 }),
          coreHoursRuleType: uberSource.coreHoursRuleType || 'PERCENTAGE',
          coreHoursRequirement: decimalInput(uberSource.coreHoursRequirement, 'Uber core-hours requirement', { required: (uberSource.coreHoursRuleType || 'PERCENTAGE') === 'PERCENTAGE', maxDp: 8 }),
        }
      : undefined,
    effectiveFrom: body.effectiveFrom ? toDateOnly(body.effectiveFrom) : null,
    effectiveTo: body.effectiveTo ? toDateOnly(body.effectiveTo) : null,
    notes: body.notes,
  };
  const errors = validateVersion(v);
  if (errors.length) throw badRequest(errors.join(' '), { errors });
  return v;
}

function assertNoOverlap(plan) {
  const sorted = [...plan.versions].sort((a, b) => a.effectiveFrom - b.effectiveFrom);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    if (!prev.effectiveTo || toDateOnly(prev.effectiveTo) >= toDateOnly(sorted[i].effectiveFrom)) {
      throw badRequest(`Version ${prev.versionNumber} overlaps version ${sorted[i].versionNumber}. Adjust the effective dates.`);
    }
  }
}

async function withUsage(plan) {
  const json = plan.toJSON();
  const current = currentVersion(plan);
  json.currentVersionId = current?._id ?? null;
  json.providerCount = await Provider.countDocuments({ planId: plan._id, status: 'ACTIVE' });
  json.versions = await Promise.all(
    json.versions
      .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))
      .map(async (v) => ({ ...v, locked: await vdpUsesVersion(v._id) })),
  );
  return json;
}

export async function list(req, res) {
  const filter = {};
  if (req.query.divisionId) filter.divisionId = req.query.divisionId;
  const plans = await VdpPlan.find(filter).sort({ name: 1 });
  res.json(await Promise.all(plans.map(withUsage)));
}

export async function get(req, res) {
  const plan = await VdpPlan.findById(req.params.id);
  if (!plan) throw notFound('VDP plan');
  res.json(await withUsage(plan));
}

// ---- Fuel prices (service mile allowance) ----

const DAY_RX = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d) => DAY_RX.test(d) && !Number.isNaN(Date.parse(d));

function fuelPriceInput(body) {
  const pricePerGallon = decimalInput(body.pricePerGallon, 'Fuel price per gallon', { required: true, maxDp: 6 });
  if (Number(pricePerGallon) <= 0) throw badRequest('Fuel price per gallon must be greater than zero.');
  const effectiveFrom = String(body.effectiveFrom || '').trim();
  const effectiveTo = String(body.effectiveTo || '').trim() || null;
  if (!validDay(effectiveFrom)) throw badRequest('Effective from date is required.');
  if (effectiveTo && !validDay(effectiveTo)) throw badRequest('Effective to date is not a valid date.');
  if (effectiveTo && effectiveTo < effectiveFrom) throw badRequest('Effective to date is before effective from.');
  return { pricePerGallon, effectiveFrom, effectiveTo, notes: body.notes || undefined };
}

// A plan's fuel prices, replaced as a whole list (the plan form edits them as a table).
// One price per day: periods may not overlap.
function applyFuelPrices(plan, list, user) {
  if (!Array.isArray(list)) throw badRequest('Fuel prices must be a list.');
  const prices = list
    .filter((p) => String(p?.pricePerGallon ?? '').trim() || String(p?.effectiveFrom ?? '').trim())
    .map((p, i) => {
      try { return { ...fuelPriceInput(p), ...(p._id ? { _id: p._id } : {}) }; } catch (e) { e.message = `Fuel price ${i + 1}: ${e.message}`; throw e; }
    })
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1];
    if (!prev.effectiveTo || prev.effectiveTo >= prices[i].effectiveFrom) {
      throw badRequest(`Fuel prices overlap: $${prev.pricePerGallon}/gal from ${prev.effectiveFrom}${prev.effectiveTo ? ` to ${prev.effectiveTo}` : ' (open-ended)'} and $${prices[i].pricePerGallon}/gal from ${prices[i].effectiveFrom}. Each day needs one price.`);
    }
  }
  const before = new Map(plan.fuelPrices.map((p) => [String(p._id), p]));
  plan.fuelPrices = prices.reverse().map((p) => {
    const old = p._id && before.get(String(p._id));
    const same = old && String(old.pricePerGallon) === String(p.pricePerGallon) && old.effectiveFrom === p.effectiveFrom
      && (old.effectiveTo || null) === p.effectiveTo && (old.notes || undefined) === p.notes;
    return same ? old.toObject() : { ...p, updatedBy: actor(user), updatedAt: new Date() };
  });
}

// Open VDPs recalculate with new prices; approved ones keep the prices they used.
export async function setFuelPrices(req, res) {
  const plan = await VdpPlan.findById(req.params.id);
  if (!plan) throw notFound('VDP plan');
  applyFuelPrices(plan, req.body.fuelPrices, req.user);
  await plan.save();
  await markStale({ divisionId: plan.divisionId });
  res.json(await withUsage(plan));
}

export async function create(req, res) {
  const { divisionId, name, notes } = req.body;
  if (!name) throw badRequest('Plan name is required.');
  if (!(await Division.exists({ _id: divisionId }))) throw badRequest('Choose a division.');
  const version = versionInput(req.body.version || req.body);
  if (!version.effectiveFrom) throw badRequest('Effective from date is required.');
  const plan = new VdpPlan({
    divisionId,
    name,
    notes,
    versions: [{ ...version, versionNumber: 1, createdBy: actor(req.user) }],
  });
  const prices = req.body.fuelPrices ?? req.body.version?.fuelPrices;
  if (prices !== undefined) applyFuelPrices(plan, prices, req.user);
  await plan.save();
  res.status(201).json(await withUsage(plan));
}

export async function update(req, res) {
  const plan = await VdpPlan.findById(req.params.id);
  if (!plan) throw notFound('VDP plan');
  if (req.body.name !== undefined) plan.name = req.body.name;
  if (req.body.notes !== undefined) plan.notes = req.body.notes;
  if (req.body.status !== undefined) {
    if (!['ACTIVE', 'INACTIVE'].includes(req.body.status)) throw badRequest('Invalid status.');
    plan.status = req.body.status;
  }
  await plan.save();
  res.json(await withUsage(plan));
}

// New rates / rules from a date: previous version is closed the day before.
export async function addVersion(req, res) {
  const plan = await VdpPlan.findById(req.params.id);
  if (!plan) throw notFound('VDP plan');
  const version = versionInput(req.body);
  const latest = Math.max(...plan.versions.map((v) => v.effectiveFrom.getTime()));
  if (version.effectiveFrom.getTime() <= latest) {
    throw badRequest('A new version must start after the latest existing version. To correct an unused version, edit it instead.');
  }
  closePreviousVersion(plan, version.effectiveFrom);
  plan.versions.push({
    ...version,
    versionNumber: Math.max(...plan.versions.map((v) => v.versionNumber)) + 1,
    createdBy: actor(req.user),
  });
  assertNoOverlap(plan);
  if (req.body.fuelPrices !== undefined) applyFuelPrices(plan, req.body.fuelPrices, req.user);
  await plan.save();
  await markStale({ planId: plan._id });
  res.status(201).json(await withUsage(plan));
}

// Correct a version in place — only while no approved/paid VDP depends on it.
export async function updateVersion(req, res) {
  const plan = await VdpPlan.findById(req.params.id);
  if (!plan) throw notFound('VDP plan');
  const v = plan.versions.id(req.params.versionId);
  if (!v) throw notFound('Plan version');
  if (await vdpUsesVersion(v._id)) {
    throw conflict('Approved VDPs were calculated with this version, so it cannot be edited. Add a new version with a new effective date.');
  }
  const input = versionInput({ ...req.body, effectiveFrom: req.body.effectiveFrom || v.effectiveFrom });
  Object.assign(v, input);
  assertNoOverlap(plan);
  if (req.body.fuelPrices !== undefined) applyFuelPrices(plan, req.body.fuelPrices, req.user);
  await plan.save();
  await markStale({ planId: plan._id });
  res.json(await withUsage(plan));
}
