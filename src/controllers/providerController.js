import Provider from '../models/Provider.js';
import VdpPlan from '../models/VdpPlan.js';
import Division from '../models/Division.js';
import { resolveSettings, currentVersion } from '../services/planService.js';
import { markStale } from '../services/vdpService.js';
import { operatorsOf } from '../services/operators.js';
import { badRequest, notFound } from '../services/errors.js';
import { decimalInput, pick } from './validate.js';

const normRoutes = (routes) =>
  [...new Set((Array.isArray(routes) ? routes : String(routes || '').split(/[,\s]+/))
    .map((r) => String(r).trim())
    .filter(Boolean))];

function leaseInput(lease, label) {
  const freq = lease?.frequency || 'NONE';
  if (!['WEEKLY', 'PER_VDP_CYCLE', 'NONE'].includes(freq)) throw badRequest(`${label}: invalid lift lease frequency.`);
  const amount = decimalInput(lease?.amount, `${label}: lift lease amount`, { maxDp: 2 });
  if (freq !== 'NONE' && amount === null) throw badRequest(`${label}: enter the lift lease amount or set the frequency to None.`);
  return { amount: freq === 'NONE' ? null : amount, frequency: freq };
}

function operatorInput(o, i) {
  const name = String(o?.name ?? '').trim();
  const label = name ? `Operator ${name}` : `Operator ${i + 1}`;
  if (!name) throw badRequest(`${label}: name is required.`);
  const status = o.status || 'ACTIVE';
  if (!['ACTIVE', 'INACTIVE'].includes(status)) throw badRequest(`${label}: invalid status.`);
  const hours = decimalInput(o.contractedHours, `${label}: contracted hours`);
  if (hours !== null && Number(hours) <= 0) throw badRequest(`${label}: contracted hours must be greater than zero.`);
  return {
    ...(o._id ? { _id: o._id } : {}),
    name,
    routes: normRoutes(o.routes),
    status,
    contractedHours: hours,
    liftLease: leaseInput(o.liftLease, label),
    notes: o.notes || undefined,
  };
}

function applyOperators(provider, list) {
  if (!Array.isArray(list)) throw badRequest('Operators must be a list.');
  const operators = list.map(operatorInput);
  const seenName = new Set();
  const routeOwner = new Map();
  for (const o of operators) {
    if (seenName.has(o.name.toLowerCase())) throw badRequest(`Operator ${o.name} is listed twice.`);
    seenName.add(o.name.toLowerCase());
    if (o.status !== 'ACTIVE') continue;
    for (const r of o.routes) {
      if (routeOwner.has(r)) throw badRequest(`Route ${r} is on both ${routeOwner.get(r)} and ${o.name}. A route belongs to one operator.`);
      routeOwner.set(r, o.name);
    }
  }
  provider.operators = operators;
}

export async function applyInput(provider, body) {
  Object.assign(provider, pick(body, ['providerNumber', 'name', 'serviceType', 'notes']));
  if (body.divisionId !== undefined) {
    if (!(await Division.exists({ _id: body.divisionId }))) throw badRequest('Choose a division.');
    provider.divisionId = body.divisionId;
  }
  if (body.status !== undefined) {
    if (!['ACTIVE', 'INACTIVE'].includes(body.status)) throw badRequest('Invalid status.');
    provider.status = body.status;
  }
  if (body.operators !== undefined) applyOperators(provider, body.operators);
  else if (body.routes !== undefined || body.operatorName !== undefined || body.liftLease) {
    // Single-operator form of the input (older clients, scripts).
    if (provider.operators.length > 1) throw badRequest('This provider has several operators. Edit routes and leases per operator.');
    if (provider.operators.length === 1) {
      const [op] = operatorsOf(provider);
      applyOperators(provider, [{
        ...op,
        _id: provider.operators[0]._id,
        name: body.operatorName ?? op.name,
        routes: body.routes ?? op.routes,
        liftLease: body.liftLease ?? op.liftLease,
      }]);
    } else {
      if (body.operatorName !== undefined) provider.operatorName = body.operatorName;
      if (body.routes !== undefined) provider.routes = normRoutes(body.routes);
      if (body.liftLease) provider.liftLease = leaseInput(body.liftLease, 'Lift lease');
    }
  }
  if (body.planId !== undefined) {
    if (!body.planId) provider.planId = null;
    else {
      const plan = await VdpPlan.findById(body.planId);
      if (!plan || String(plan.divisionId) !== String(provider.divisionId)) {
        throw badRequest('The VDP plan must belong to the provider’s division.');
      }
      provider.planId = plan._id;
    }
  }
  if (body.overrides) {
    const o = body.overrides;
    const tui = o.tuiEligibility || 'INHERIT';
    if (!['INHERIT', 'ON', 'OFF'].includes(tui)) throw badRequest('Invalid TUI eligibility.');
    const hours = decimalInput(o.contractedHours, 'Contracted hours override');
    if (hours !== null && Number(hours) <= 0) throw badRequest('Contracted hours override must be greater than zero.');
    provider.overrides = {
      contractedHours: hours,
      basePay: decimalInput(o.basePay, 'Base pay override'),
      bonusRate: decimalInput(o.bonusRate, 'Bonus rate override'),
      tuiEligibility: tui,
    };
  }
  if (body.contact) provider.contact = pick(body.contact, ['email', 'phone', 'address']);
}

async function withPayment(provider) {
  const json = provider.toJSON();
  const plan = provider.planId ? await VdpPlan.findById(provider.planId) : null;
  const version = plan ? currentVersion(plan) : null;
  json.plan = plan ? { _id: plan._id, name: plan.name, status: plan.status } : null;
  json.paymentSettings = plan && version ? resolveSettings(provider, plan, version) : null;
  json.operators = operatorsOf(provider);
  // Routes shared with another active provider are a matching problem worth showing early.
  if (provider.routes.length) {
    const others = await Provider.find(
      { divisionId: provider.divisionId, _id: { $ne: provider._id }, status: 'ACTIVE', routes: { $in: provider.routes } },
      'name routes',
    );
    json.sharedRoutes = others.flatMap((o) => o.routes.filter((r) => provider.routes.includes(r)).map((route) => ({ route, provider: o.name })));
  }
  return json;
}

export async function list(req, res) {
  const filter = {};
  if (req.query.divisionId) filter.divisionId = req.query.divisionId;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.planId) filter.planId = req.query.planId;
  if (req.query.search) {
    const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { operatorName: rx }, { providerNumber: rx }, { routes: rx }];
  }
  const providers = await Provider.find(filter).sort({ name: 1 }).populate('planId', 'name').populate('divisionId', 'divisionNumber name');
  res.json(providers.map((p) => {
    const j = p.toJSON();
    return { ...j, planName: p.planId?.name || null, planId: p.planId?._id || null, division: p.divisionId, divisionId: p.divisionId?._id };
  }));
}

export async function get(req, res) {
  const p = await Provider.findById(req.params.id);
  if (!p) throw notFound('Provider');
  res.json(await withPayment(p));
}

export async function create(req, res) {
  if (!req.body.name) throw badRequest('Provider name is required.');
  if (!req.body.divisionId) throw badRequest('Choose a division.');
  const p = new Provider({ divisionId: req.body.divisionId });
  await applyInput(p, req.body);
  await p.save();
  res.status(201).json(await withPayment(p));
}

export async function update(req, res) {
  const p = await Provider.findById(req.params.id);
  if (!p) throw notFound('Provider');
  await applyInput(p, req.body);
  await p.save();
  await markStale({ providerId: p._id });
  res.json(await withPayment(p));
}
