import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import VdpPlan from '../models/VdpPlan.js';
import { markStale } from '../services/vdpService.js';
import { badRequest, notFound } from '../services/errors.js';

const sameId = (left, right) => String(left || '') === String(right || '');

function assignmentSource(provider, defaultPlanId) {
  const explicit = provider.planAssignment?.source;
  if (explicit === 'DIVISION' || explicit === 'PROVIDER_OVERRIDE') return explicit;
  if (!provider.planId) return 'UNASSIGNED';
  return defaultPlanId && sameId(provider.planId, defaultPlanId) ? 'DIVISION' : 'PROVIDER_OVERRIDE';
}

function row(division, plans, providers) {
  const defaultPlanId = division.planAssignment?.defaultPlanId || null;
  const active = providers.filter((provider) => provider.status === 'ACTIVE');
  const sources = active.map((provider) => assignmentSource(provider, defaultPlanId));
  return {
    divisionId: division._id,
    divisionNumber: division.divisionNumber,
    name: division.name,
    status: division.status,
    source: division.source,
    defaultPlanId,
    updatedAt: division.planAssignment?.updatedAt || null,
    plans: plans.map((plan) => ({ _id: plan._id, name: plan.name, status: plan.status })),
    providerCount: providers.length,
    activeProviderCount: active.length,
    assignedToDefaultCount: sources.filter((source) => source === 'DIVISION').length,
    overrideCount: sources.filter((source) => source === 'PROVIDER_OVERRIDE').length,
    unassignedCount: sources.filter((source) => source === 'UNASSIGNED').length,
  };
}

export async function list(_req, res) {
  const divisions = await Division.find().sort({ divisionNumber: 1 });
  const divisionIds = divisions.map((division) => division._id);
  const [plans, providers] = await Promise.all([
    VdpPlan.find({ divisionId: { $in: divisionIds } }).sort({ name: 1 }),
    Provider.find({ divisionId: { $in: divisionIds } }),
  ]);
  res.json(divisions.map((division) => row(
    division,
    plans.filter((plan) => sameId(plan.divisionId, division._id)),
    providers.filter((provider) => sameId(provider.divisionId, division._id)),
  )));
}

export async function update(req, res) {
  const division = await Division.findById(req.params.divisionId);
  if (!division) throw notFound('Division');
  if (!req.body.planId) throw badRequest('Choose a VDP plan to apply.');
  const plan = await VdpPlan.findById(req.body.planId);
  if (!plan || !sameId(plan.divisionId, division._id)) throw badRequest('The VDP plan must belong to this division.');
  if (plan.status !== 'ACTIVE') throw badRequest('Choose an active VDP plan.');

  const assignedAt = new Date();
  division.planAssignment = { defaultPlanId: plan._id, updatedAt: assignedAt };
  await division.save();

  const providers = await Provider.find({ divisionId: division._id });
  for (const provider of providers) {
    provider.planId = plan._id;
    provider.planAssignment = { source: 'DIVISION', assignedAt };
    // An operator-specific plan remains an intentional operator exception.
    provider.operators.forEach((operator) => {
      if (operator.planId && sameId(operator.planId, plan._id)) operator.planId = null;
    });
    await provider.save();
  }
  if (providers.length) await markStale({ providerId: { $in: providers.map((provider) => provider._id) } });

  const plans = await VdpPlan.find({ divisionId: division._id }).sort({ name: 1 });
  res.json({
    ...row(division, plans, providers),
    applied: { providers: providers.length },
  });
}
