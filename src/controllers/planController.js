import VdpPlan from '../models/VdpPlan.js';
import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import { validateVersion, closePreviousVersion, currentVersion } from '../services/planService.js';
import { vdpUsesVersion, markStale } from '../services/vdpService.js';
import { toDateOnly } from '../services/cycleService.js';
import { D } from '../services/money.js';
import { badRequest, conflict, notFound, actor } from '../services/errors.js';
import { decimalInput } from './validate.js';

export function versionInput(body) {
  const tiers = (body.incentiveTiers || [])
    .map((t, i) => ({
      minimumPercentage: decimalInput(t.minimumPercentage, `Tier ${i + 1} minimum %`, { required: true }),
      maximumPercentage: decimalInput(t.maximumPercentage, `Tier ${i + 1} maximum %`),
      rate: decimalInput(t.rate, `Tier ${i + 1} rate`, { required: true }),
    }))
    .sort((a, b) => D(a.minimumPercentage).cmp(D(b.minimumPercentage)));
  // Older clients and the bulk import send only the per-trip switch.
  const fuelMethod = body.fuelMethod || (body.fuelReimbursementEnabled ? 'PER_TRIP' : 'NONE');
  const v = {
    paymentType: body.paymentType,
    basePay: decimalInput(body.basePay, 'Base pay', { required: true }),
    contractedHours: decimalInput(body.contractedHours, 'Contracted hours'),
    incentiveEnabled: Boolean(body.incentiveEnabled),
    incentiveTiers: tiers,
    bonusEnabled: Boolean(body.bonusEnabled),
    bonusRate: decimalInput(body.bonusRate, 'Bonus rate'),
    fuelMethod,
    fuelReimbursementEnabled: fuelMethod === 'PER_TRIP',
    fuelReimbursementRate: fuelMethod === 'PER_TRIP' ? decimalInput(body.fuelReimbursementRate, 'Fuel reimbursement rate') : null,
    fuelMpg: fuelMethod === 'SERVICE_MILE_ALLOWANCE' ? decimalInput(body.fuelMpg, 'Fuel efficiency (MPG)') : null,
    fuelMileageSource: 'SERVICE_MILES',
    performanceHourMetric: body.performanceHourMetric || 'TOTAL_HOURS',
    performanceHourColumn: body.performanceHourMetric === 'OTHER' ? body.performanceHourColumn : null,
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

export async function create(req, res) {
  const { divisionId, name, notes } = req.body;
  if (!name) throw badRequest('Plan name is required.');
  if (!(await Division.exists({ _id: divisionId }))) throw badRequest('Choose a division.');
  const version = versionInput(req.body.version || req.body);
  if (!version.effectiveFrom) throw badRequest('Effective from date is required.');
  const plan = await VdpPlan.create({
    divisionId,
    name,
    notes,
    versions: [{ ...version, versionNumber: 1, createdBy: actor(req.user) }],
  });
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
  await plan.save();
  await markStale({ planId: plan._id });
  res.json(await withUsage(plan));
}
