import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import VdpPlan from '../models/VdpPlan.js';
import { badRequest, notFound } from '../services/errors.js';
import { toDateOnly } from '../services/cycleService.js';
import { pick } from './validate.js';

function applyInput(division, body) {
  Object.assign(division, pick(body, ['divisionNumber', 'name', 'location', 'timezone', 'notes']));
  if (body.cycleSettings) {
    const cs = body.cycleSettings;
    if (cs.anchorDate) {
      const d = toDateOnly(cs.anchorDate);
      if (d.getUTCDay() !== 1) throw badRequest('The cycle anchor date must be a Monday (invoice weeks run Monday–Sunday).');
      division.cycleSettings.anchorDate = d;
    }
    for (const k of ['submissionOffsetDays', 'paymentOffsetDays']) {
      if (cs[k] !== undefined && cs[k] !== '') {
        const n = Number(cs[k]);
        if (!Number.isInteger(n) || n < 0) throw badRequest('Cycle offsets must be whole days.');
        division.cycleSettings[k] = n;
      }
    }
  }
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
  if (!req.body.divisionNumber || !req.body.name) throw badRequest('Division number and name are required.');
  const d = new Division();
  applyInput(d, req.body);
  await d.save();
  res.status(201).json(d);
}

export async function update(req, res) {
  const d = await Division.findById(req.params.id);
  if (!d) throw notFound('Division');
  applyInput(d, req.body);
  await d.save();
  res.json(d);
}

export async function setStatus(req, res) {
  const d = await Division.findById(req.params.id);
  if (!d) throw notFound('Division');
  if (!['ACTIVE', 'INACTIVE'].includes(req.body.status)) throw badRequest('Status must be ACTIVE or INACTIVE.');
  d.status = req.body.status;
  await d.save();
  res.json(d);
}
