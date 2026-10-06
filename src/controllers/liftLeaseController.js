import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import { markStale } from '../services/vdpService.js';
import { badRequest, notFound } from '../services/errors.js';
import { decimalInput } from './validate.js';

const FREQUENCIES = ['WEEKLY', 'PER_VDP_CYCLE', 'NONE'];
const currentOperators = (provider) => provider.operators.filter((operator) => !operator.transferredTo?.providerId);
const payUnitKey = (operator) => operator.vehicleUnit
  ? `vehicle:${operator.vehicleUnit.trim().toLowerCase()}`
  : `operator:${operator._id}`;

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

export async function list(_req, res) {
  const divisions = await Division.find({ 'source.system': 'COMPASS' }).sort({ divisionNumber: 1 });
  const providers = await Provider.find({ divisionId: { $in: divisions.map((division) => division._id) } });
  res.json(divisions.map((division) => row(
    division,
    providers.filter((provider) => String(provider.divisionId) === String(division._id)),
  )));
}

export async function update(req, res) {
  const division = await Division.findById(req.params.divisionId);
  if (!division) throw notFound('Division');
  if (division.source?.system !== 'COMPASS') throw badRequest('Division-level lift leases are available for Compass divisions.');

  const frequency = String(req.body.frequency || '').trim().toUpperCase();
  if (!FREQUENCIES.includes(frequency)) throw badRequest('Choose Weekly, Per VDP cycle, or No lease.');
  const amount = frequency === 'NONE'
    ? null
    : decimalInput(req.body.amount, 'Lift lease amount', { required: true, min: 0.01, maxDp: 2 });

  division.liftLease = { configured: true, amount, frequency, updatedAt: new Date() };
  await division.save();

  const providers = await Provider.find({ divisionId: division._id });
  const lease = { amount, frequency };
  let operatorCount = 0;
  for (const provider of providers) {
    const operators = currentOperators(provider);
    operators.forEach((operator) => { operator.liftLease = lease; });
    operatorCount += operators.length;
    if (!provider.operators.length) provider.liftLease = lease;
    await provider.save();
  }
  if (providers.length) await markStale({ providerId: { $in: providers.map((provider) => provider._id) } });

  res.json({
    ...row(division, providers),
    applied: { providers: providers.length, operators: operatorCount },
  });
}
