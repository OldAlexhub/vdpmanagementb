import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import VdpPlan from '../models/VdpPlan.js';
import { badRequest, notFound } from '../services/errors.js';
import { pick } from './validate.js';
import { joinOpenPeriods } from './cycleController.js';
import { isCompassRosterAuthority } from '../services/compassClient.js';

const compassOwned = (division) => division.source?.system === 'COMPASS';
const manualRosterDisabled = () => badRequest('Compass manages divisions and providers. Use Sync from Compass in Settings.');

// The VDP cycle schedule is company-wide (Settings), not per division.
export function applyInput(division, body) {
  Object.assign(division, pick(body, ['divisionNumber', 'name', 'location', 'timezone', 'notes']));
}

export async function list(_req, res) {
  const divisions = await Division.find().sort({ divisionNumber: 1 });
  const [providerCounts, planCounts] = await Promise.all([
    Provider.aggregate([{ $match: { status: 'ACTIVE' } }, { $group: { _id: '$divisionId', n: { $sum: 1 } } }]),
    VdpPlan.aggregate([{ $match: { status: 'ACTIVE' } }, { $group: { _id: '$divisionId', n: { $sum: 1 } } }]),
  ]);
  const count = (arr, id) => arr.find((c) => String(c._id) === String(id))?.n || 0;
  res.json(divisions.map((d) => ({ ...d.toJSON(), activeProviders: count(providerCounts, d._id), activePlans: count(planCounts, d._id) })));
}

export async function get(req, res) {
  const d = await Division.findById(req.params.id);
  if (!d) throw notFound('Division');
  res.json(d);
}

export async function create(req, res) {
  if (isCompassRosterAuthority()) throw manualRosterDisabled();
  if (!req.body.divisionNumber || !req.body.name) throw badRequest('Division number and name are required.');
  const d = new Division();
  applyInput(d, req.body);
  await d.save();
  await joinOpenPeriods(d);
  res.status(201).json(d);
}

export async function update(req, res) {
  const d = await Division.findById(req.params.id);
  if (!d) throw notFound('Division');
  applyInput(d, compassOwned(d) ? pick(req.body, ['location', 'notes']) : req.body);
  await d.save();
  res.json(d);
}

export async function setStatus(req, res) {
  const d = await Division.findById(req.params.id);
  if (!d) throw notFound('Division');
  if (compassOwned(d)) throw badRequest("Compass controls this division's status. Refresh the Compass roster instead.");
  if (!['ACTIVE', 'INACTIVE'].includes(req.body.status)) throw badRequest('Status must be ACTIVE or INACTIVE.');
  d.status = req.body.status;
  await d.save();
  res.json(d);
}
