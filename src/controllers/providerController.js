import Provider from '../models/Provider.js';
import VdpPlan from '../models/VdpPlan.js';
import Division from '../models/Division.js';
import { resolveSettings, currentVersion } from '../services/planService.js';
import Vdp from '../models/Vdp.js';
import VdpCycle from '../models/VdpCycle.js';
import { markStale } from '../services/vdpService.js';
import { operatorsOf, worksBetween, LEGACY_OPERATOR_ID } from '../services/operators.js';
import { isoDate, addDays, toDateOnly } from '../services/cycleService.js';
import { badRequest, conflict, notFound, actor } from '../services/errors.js';
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
  const basePay = decimalInput(o.basePay, `${label}: base hourly rate`);
  if (basePay !== null && Number(basePay) <= 0) throw badRequest(`${label}: base hourly rate must be greater than zero.`);
  const hours = decimalInput(o.contractedHours, `${label}: contracted hours`);
  if (hours !== null && Number(hours) <= 0) throw badRequest(`${label}: contracted hours must be greater than zero.`);
  return {
    ...(o._id ? { _id: o._id } : {}),
    name,
    routes: normRoutes(o.routes),
    status,
    vehicleUnit: String(o.vehicleUnit || '').trim() || null,
    basePay,
    contractedHours: hours,
    liftLease: leaseInput(o.liftLease, label),
    planId: o.planId || null,
    notes: o.notes || undefined,
  };
}

// Transfer dates are only set by a transfer, never by the edit form. Operators who moved to
// another provider are not on the form; they are kept so earlier cycles still pay correctly.
const TRANSFER_FIELDS = ['startDate', 'endDate', 'transferredFrom', 'transferredTo'];

function applyOperators(provider, list) {
  if (!Array.isArray(list)) throw badRequest('Operators must be a list.');
  const existing = new Map(provider.operators.map((o) => [String(o._id), o]));
  const operators = list.map(operatorInput).map((o) => {
    const before = o._id && existing.get(String(o._id));
    if (!before) return o;
    const kept = Object.fromEntries(TRANSFER_FIELDS.map((k) => [k, before.toObject()[k] ?? null]));
    return { ...o, ...kept };
  });
  const listed = new Set(operators.filter((o) => o._id).map((o) => String(o._id)));
  const movedAway = provider.operators.filter((o) => o.transferredTo?.providerId && !listed.has(String(o._id))).map((o) => o.toObject());
  const seenName = new Set();
  const routeOwner = new Map();
  for (const o of operators) {
    if (o.transferredTo?.providerId) continue; // moved away: their dates no longer overlap anyone here
    if (seenName.has(o.name.toLowerCase())) throw badRequest(`Operator ${o.name} is listed twice.`);
    seenName.add(o.name.toLowerCase());
    if (o.status !== 'ACTIVE') continue;
    for (const r of o.routes) {
      if (routeOwner.has(r)) throw badRequest(`Route ${r} is on both ${routeOwner.get(r)} and ${o.name}. A route belongs to one operator.`);
      routeOwner.set(r, o.name);
    }
  }
  provider.operators = [...operators, ...movedAway];
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
  // An operator's own plan must be a plan of the provider's division; the same plan as the provider = none.
  const opPlans = [...new Set(provider.operators.map((o) => o.planId && String(o.planId)).filter(Boolean))];
  for (const planId of opPlans) {
    const plan = await VdpPlan.findById(planId);
    if (!plan || String(plan.divisionId) !== String(body.divisionId ?? provider.divisionId)) {
      throw badRequest('An operator’s VDP plan must belong to the provider’s division.');
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
    const basePay = decimalInput(o.basePay, 'Base pay override');
    if (basePay !== null && Number(basePay) <= 0) throw badRequest('Base pay must be greater than zero.');
    const mpg = decimalInput(o.fuelMpg, 'Fuel MPG override');
    if (mpg !== null && Number(mpg) <= 0) throw badRequest('Fuel MPG override must be greater than zero.');
    provider.overrides = {
      contractedHours: hours,
      basePay,
      bonusRate: decimalInput(o.bonusRate, 'Bonus rate override'),
      tuiEligibility: tui,
      fuelMpg: mpg,
    };
  }
  if (body.contact) provider.contact = pick(body.contact, ['email', 'phone', 'address']);
  provider.operators.forEach((o) => { if (o.planId && String(o.planId) === String(provider.planId)) o.planId = null; });
}

async function withPayment(provider) {
  const json = provider.toJSON();
  const plan = provider.planId ? await VdpPlan.findById(provider.planId) : null;
  const version = plan ? currentVersion(plan) : null;
  json.plan = plan ? { _id: plan._id, name: plan.name, status: plan.status } : null;
  json.paymentSettings = plan && version ? resolveSettings(provider, plan, version) : null;
  json.operators = operatorsOf(provider);
  // Routes shared with another active provider are a matching problem worth showing early.
  // A route handed over by an operator transfer is on both profiles for different dates — not shared.
  if (provider.routes.length) {
    const others = await Provider.find(
      { divisionId: provider.divisionId, _id: { $ne: provider._id }, status: 'ACTIVE', routes: { $in: provider.routes } },
      'name routes operators operatorName liftLease',
    );
    const runs = (p, route) => operatorsOf(p).filter((o) => o.status === 'ACTIVE' && o.routes.includes(route));
    const overlap = (a, b) => worksBetween(a, b.startDate || '0000-01-01', b.endDate || '9999-12-31');
    json.sharedRoutes = others.flatMap((other) => other.routes
      .filter((r) => provider.routes.includes(r))
      .filter((r) => { const mine = runs(provider, r); const theirs = runs(other, r); return !mine.length || !theirs.length || mine.some((a) => theirs.some((b) => overlap(a, b))); })
      .map((route) => ({ route, provider: other.name })));
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

// A provider saved before operators existed gets its one operator as a real record first.
function materializeOperators(provider) {
  if (provider.operators.length || (!provider.routes.length && !provider.operatorName)) return;
  const [legacy] = operatorsOf(provider);
  provider.operators = [{ name: legacy.name, routes: legacy.routes, status: 'ACTIVE', liftLease: legacy.liftLease }];
}

const dayBefore = (day) => isoDate(addDays(day, -1));

/**
 * Move an operator to another provider from an effective date. The operator stays on the old
 * provider until the day before (so earlier report days still pay there) and is added to the
 * new provider from that date with the same routes, contracted hours and lift lease.
 */
export async function transferOperator(req, res) {
  const { toProviderId, effectiveDate, note } = req.body;
  const source = await Provider.findById(req.params.id);
  if (!source) throw notFound('Provider');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveDate || '')) || Number.isNaN(Date.parse(effectiveDate))) {
    throw badRequest('Choose the effective date (the operator’s first day with the new provider).');
  }
  if (!toProviderId || String(toProviderId) === String(source._id)) throw badRequest('Choose the provider the operator is moving to.');
  const target = await Provider.findById(toProviderId);
  if (!target || String(target.divisionId) !== String(source.divisionId)) throw badRequest('Choose a provider in the same division.');
  if (target.status !== 'ACTIVE') throw badRequest(`${target.name} is inactive. Activate it before moving an operator there.`);

  materializeOperators(source);
  const op = req.params.operatorId === LEGACY_OPERATOR_ID && source.operators.length === 1
    ? source.operators[0]
    : source.operators.id(req.params.operatorId);
  if (!op) throw notFound('Operator');
  if (op.status !== 'ACTIVE') throw badRequest(`${op.name} is inactive on ${source.name}.`);
  if (op.transferredTo?.providerId) throw badRequest(`${op.name} already moved to ${op.transferredTo.providerName} on ${op.transferredTo.effectiveDate}.`);
  if (op.startDate && effectiveDate <= op.startDate) throw badRequest(`${op.name} only started with ${source.name} on ${op.startDate}. Choose a later date.`);

  materializeOperators(target);
  const clash = target.operators.find((o) => o.status === 'ACTIVE' && worksBetween(o, effectiveDate, '9999-12-31')
    && (o.name.toLowerCase() === op.name.toLowerCase() || o.routes.some((r) => op.routes.includes(r))));
  if (clash) {
    throw badRequest(clash.name.toLowerCase() === op.name.toLowerCase()
      ? `${target.name} already has an operator named ${op.name}.`
      : `${target.name}’s operator ${clash.name} already runs route ${clash.routes.filter((r) => op.routes.includes(r)).join(', ')}.`);
  }

  // Approved statements are frozen; changing who ran those days would contradict them.
  const cycles = await VdpCycle.find({ divisionId: source.divisionId, cycleEnd: { $gte: toDateOnly(effectiveDate) } }, '_id');
  const locked = await Vdp.find({
    providerId: { $in: [source._id, target._id] },
    cycleId: { $in: cycles.map((c) => c._id) },
    status: { $nin: ['DRAFT', 'NEEDS_REVIEW', 'READY'] },
  }).populate('providerId', 'name').populate('cycleId', 'cycleStart cycleEnd');
  if (locked.length) {
    const list = locked.map((v) => `${v.providerId.name} (${isoDate(v.cycleId.cycleStart)} – ${isoDate(v.cycleId.cycleEnd)})`).join(', ');
    throw conflict(`These VDPs cover dates on or after ${effectiveDate} and are already approved: ${list}. Reopen them first, or choose a later date.`);
  }

  const by = actor(req.user);
  const text = String(note || '').trim() || undefined;
  target.operators.push({
    name: op.name,
    routes: op.routes,
    status: 'ACTIVE',
    vehicleUnit: op.vehicleUnit,
    basePay: op.basePay,
    contractedHours: op.contractedHours,
    liftLease: op.liftLease,
    planId: op.planId && String(op.planId) !== String(target.planId) ? op.planId : null,
    notes: op.notes,
    startDate: effectiveDate,
    transferredFrom: { providerId: source._id, providerName: source.name, effectiveDate, note: text, by },
  });
  op.endDate = dayBefore(effectiveDate);
  op.transferredTo = { providerId: target._id, providerName: target.name, effectiveDate, note: text, by };
  await target.save();
  await source.save();
  await markStale({ providerId: { $in: [source._id, target._id] } });
  res.json(await withPayment(source));
}
