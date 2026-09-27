import VdpCycle, { CYCLE_STATUSES } from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import { generateCycles, initialStatus, cycleStartFor, isoDate } from '../services/cycleService.js';
import { cycleSummary } from '../services/summaryService.js';
import { badRequest, notFound } from '../services/errors.js';

const settingsOf = (division) => ({
  anchorDate: isoDate(division.cycleSettings.anchorDate),
  lengthDays: division.cycleSettings.lengthDays,
  submissionOffsetDays: division.cycleSettings.submissionOffsetDays,
  paymentOffsetDays: division.cycleSettings.paymentOffsetDays,
});

export async function list(req, res) {
  const filter = {};
  if (req.query.divisionId) filter.divisionId = req.query.divisionId;
  if (req.query.status) filter.status = req.query.status;
  const cycles = await VdpCycle.find(filter).sort({ cycleStart: -1 }).populate('divisionId', 'divisionNumber name');
  res.json(cycles.map((c) => ({ ...c.toJSON(), division: c.divisionId, divisionId: c.divisionId?._id })));
}

export async function get(req, res) {
  res.json(await cycleSummary(req.params.id));
}

// Generate `count` cycles starting with the one containing `fromDate` (default: today).
// Existing cycles are left untouched.
export async function generate(req, res) {
  const division = await Division.findById(req.body.divisionId);
  if (!division) throw badRequest('Choose a division.');
  const count = Math.min(Math.max(Number(req.body.count) || 1, 1), 26);
  const from = req.body.fromDate || new Date();
  const created = [];
  let existing = 0;
  for (const dates of generateCycles(from, count, settingsOf(division))) {
    const found = await VdpCycle.findOne({ divisionId: division._id, cycleStart: dates.cycleStart });
    if (found) { existing += 1; continue; }
    created.push(await VdpCycle.create({ divisionId: division._id, ...dates, status: initialStatus(dates) }));
  }
  res.status(201).json({ created, existing });
}

// Preview the cycle containing a date without saving anything.
export async function preview(req, res) {
  const division = await Division.findById(req.query.divisionId);
  if (!division) throw badRequest('Choose a division.');
  const settings = settingsOf(division);
  const [dates] = generateCycles(req.query.date || new Date(), 1, settings);
  res.json({ ...dates, alignedStart: cycleStartFor(req.query.date || new Date(), settings) });
}

export async function update(req, res) {
  const cycle = await VdpCycle.findById(req.params.id);
  if (!cycle) throw notFound('VDP cycle');
  if (req.body.status !== undefined) {
    if (!CYCLE_STATUSES.includes(req.body.status)) throw badRequest('Invalid cycle status.');
    cycle.status = req.body.status;
  }
  if (req.body.notes !== undefined) cycle.notes = req.body.notes;
  await cycle.save();
  res.json(cycle);
}
