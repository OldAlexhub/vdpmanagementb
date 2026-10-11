import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import LiftLeaseOption from '../models/LiftLeaseOption.js';
import { markStale } from '../services/vdpService.js';
import { badRequest, conflict, notFound } from '../services/errors.js';
import { decimalInput } from './validate.js';

const FREQUENCIES = ['WEEKLY', 'PER_VDP_CYCLE', 'NONE'];
const currentOperators = (provider) => provider.operators.filter((operator) => !operator.transferredTo?.providerId);
const payUnitKey = (operator) => operator.vehicleUnit
  ? `vehicle:${operator.vehicleUnit.trim().toLowerCase()}`
  : `operator:${operator._id}`;
const regexEscape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function leaseValues(body, label = 'Lift lease') {
  const frequency = String(body.frequency || '').trim().toUpperCase();
  if (!FREQUENCIES.includes(frequency)) throw badRequest('Choose Weekly, Per VDP cycle, or No lease.');
  const amount = frequency === 'NONE'
    ? null
    : decimalInput(body.amount, `${label} amount`, { required: true, min: 0.01, maxDp: 2 });
  return { frequency, amount };
}

function row(division, providers) {
  const operators = providers.flatMap(currentOperators);
  const json = division.toJSON();
  return {
    divisionId: division._id,
    divisionNumber: division.divisionNumber,
    name: division.name,
    status: division.status,
    source: json.source,
    liftLease: json.liftLease,
    providerCount: providers.length,
    activeProviderCount: providers.filter((provider) => provider.status === 'ACTIVE').length,
    operatorCount: operators.length,
    activeOperatorCount: operators.filter((operator) => operator.status === 'ACTIVE').length,
    payUnitCount: providers.reduce((total, provider) => total + new Set(currentOperators(provider).map(payUnitKey)).size, 0),
  };
}

function optionRow(option, division, assignedOperatorCount = 0) {
  const json = option.toJSON();
  return {
    ...json,
    division: division ? {
      _id: division._id,
      divisionNumber: division.divisionNumber,
      name: division.name,
      status: division.status,
    } : null,
    assignedOperatorCount,
  };
}

async function assertUniqueName(divisionId, name, exceptId = null) {
  const duplicate = await LiftLeaseOption.exists({
    divisionId,
    name: { $regex: `^${regexEscape(name)}$`, $options: 'i' },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });
  if (duplicate) throw conflict(`A lift lease option named “${name}” already exists in this division.`);
}

export async function list(req, res) {
  const divisionFilter = req.query.divisionId ? { _id: req.query.divisionId } : {};
  const divisions = await Division.find(divisionFilter).sort({ divisionNumber: 1 });
  const divisionIds = divisions.map((division) => division._id);
  const [providers, options] = await Promise.all([
    Provider.find({ divisionId: { $in: divisionIds } }),
    LiftLeaseOption.find({ divisionId: { $in: divisionIds } }).sort({ name: 1 }),
  ]);
  const divisionById = new Map(divisions.map((division) => [String(division._id), division]));
  const assigned = new Map();
  providers.forEach((provider) => currentOperators(provider).forEach((operator) => {
    const optionId = operator.liftLease?.optionId;
    if (optionId) assigned.set(String(optionId), (assigned.get(String(optionId)) || 0) + 1);
  }));

  res.json({
    divisions: divisions.map((division) => ({
      _id: division._id,
      divisionNumber: division.divisionNumber,
      name: division.name,
      status: division.status,
      source: division.toJSON().source,
    })),
    options: options.map((option) => optionRow(
      option,
      divisionById.get(String(option.divisionId)),
      assigned.get(String(option._id)) || 0,
    )),
    defaults: divisions
      .filter((division) => division.source?.system === 'COMPASS')
      .map((division) => row(
        division,
        providers.filter((provider) => String(provider.divisionId) === String(division._id)),
      )),
  });
}

// Creating an option only makes it available for selection. It never changes an
// operator until the user explicitly selects it on that operator's provider.
export async function createOption(req, res) {
  const division = await Division.findById(req.body.divisionId);
  if (!division) throw badRequest('Choose an existing division.');
  const name = String(req.body.name || '').trim();
  if (!name) throw badRequest('Lift lease option name is required.');
  const values = leaseValues(req.body);
  await assertUniqueName(division._id, name);
  const option = await LiftLeaseOption.create({ divisionId: division._id, name, ...values });
  res.status(201).json(optionRow(option, division));
}

export async function updateOption(req, res) {
  const option = await LiftLeaseOption.findById(req.params.optionId);
  if (!option) throw notFound('Lift lease option');
  const division = await Division.findById(req.body.divisionId || option.divisionId);
  if (!division) throw badRequest('Choose an existing division.');
  const name = String(req.body.name ?? option.name).trim();
  if (!name) throw badRequest('Lift lease option name is required.');
  const values = leaseValues({
    frequency: req.body.frequency ?? option.frequency,
    amount: req.body.amount ?? option.amount,
  });
  const assignedProviders = await Provider.find({ 'operators.liftLease.optionId': option._id });
  if (String(division._id) !== String(option.divisionId) && assignedProviders.length) {
    throw conflict('This option is assigned to operators. Move those operators to another lease before changing its division.');
  }
  await assertUniqueName(division._id, name, option._id);
  option.divisionId = division._id;
  option.name = name;
  option.frequency = values.frequency;
  option.amount = values.amount;
  if (req.body.status !== undefined) {
    const status = String(req.body.status).toUpperCase();
    if (!['ACTIVE', 'INACTIVE'].includes(status)) throw badRequest('Status must be Active or Inactive.');
    option.status = status;
  }
  await option.save();

  let operatorCount = 0;
  for (const provider of assignedProviders) {
    provider.operators.forEach((operator) => {
      if (String(operator.liftLease?.optionId || '') !== String(option._id)) return;
      operator.liftLease = {
        optionId: option._id,
        optionName: option.name,
        amount: option.amount,
        frequency: option.frequency,
      };
      operatorCount += 1;
    });
    await provider.save();
  }
  if (assignedProviders.length) {
    await markStale({ providerId: { $in: assignedProviders.map((provider) => provider._id) } });
  }
  res.json({
    ...optionRow(option, division, operatorCount),
    applied: { providers: assignedProviders.length, operators: operatorCount },
  });
}

// Existing Compass division default. Operators using a saved option are explicit
// exceptions and are not overwritten when the default changes.
export async function update(req, res) {
  const division = await Division.findById(req.params.divisionId);
  if (!division) throw notFound('Division');
  if (division.source?.system !== 'COMPASS') throw badRequest('Division-level lift leases are available for Compass divisions.');

  const values = leaseValues(req.body);
  division.liftLease = { configured: true, ...values, updatedAt: new Date() };
  await division.save();

  const providers = await Provider.find({ divisionId: division._id });
  const changedProviders = [];
  let operatorCount = 0;
  let preservedOptionCount = 0;
  for (const provider of providers) {
    let changed = false;
    currentOperators(provider).forEach((operator) => {
      if (operator.liftLease?.optionId) {
        preservedOptionCount += 1;
        return;
      }
      operator.liftLease = { ...values, optionId: null, optionName: null };
      operatorCount += 1;
      changed = true;
    });
    if (!provider.operators.length) {
      provider.liftLease = { ...values, optionId: null, optionName: null };
      changed = true;
    }
    if (changed) {
      await provider.save();
      changedProviders.push(provider);
    }
  }
  if (changedProviders.length) {
    await markStale({ providerId: { $in: changedProviders.map((provider) => provider._id) } });
  }

  res.json({
    ...row(division, providers),
    applied: { providers: changedProviders.length, operators: operatorCount },
    preservedOptionCount,
  });
}
