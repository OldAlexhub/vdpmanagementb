import VdpCycle, { CYCLE_STATUSES } from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import { getCompanySettings } from '../models/CompanySettings.js';
import { generateCycles, initialStatus, cycleStartFor, isoDate, toDateOnly } from '../services/cycleService.js';
import { cycleSummary } from '../services/summaryService.js';
import { badRequest, notFound } from '../services/errors.js';

// VDP cycles are company-wide: one schedule, and every period exists for every active division
// with the same dates. Each division still uploads its own report and processes its own VDPs.
export async function cycleSchedule() {
  const { cycleSettings: cs } = await getCompanySettings();
  return {
    anchorDate: isoDate(cs.anchorDate),
    lengthDays: cs.lengthDays,
    submissionOffsetDays: cs.submissionOffsetDays,
    paymentOffsetDays: cs.paymentOffsetDays,
  };
}

// Create the missing cycles of the given periods for the given divisions. Existing ones are untouched.
async function createCycles(periods, divisions) {
  const created = [];
  let existing = 0;
  for (const dates of periods) {
    for (const division of divisions) {
      if (await VdpCycle.exists({ divisionId: division._id, cycleStart: dates.cycleStart })) { existing += 1; continue; }
      created.push(await VdpCycle.create({ divisionId: division._id, ...dates, status: initialStatus(dates) }));
    }
  }
  return { created, existing };
}

// A new division joins the company's current and upcoming periods.
export async function joinOpenPeriods(division) {
  const today = toDateOnly(new Date());
  const starts = await VdpCycle.distinct('cycleStart', { paymentDate: { $gte: today } });
  const periods = await Promise.all(starts.map((s) => VdpCycle.findOne({ cycleStart: s })));
  const dates = periods.filter(Boolean).map((c) => ({
    cycleStart: c.cycleStart, cycleEnd: c.cycleEnd, week1Start: c.week1Start, week1End: c.week1End,
    week2Start: c.week2Start, week2End: c.week2End, submissionDate: c.submissionDate, paymentDate: c.paymentDate,
  }));
  return createCycles(dates, [division]);
}

export async function list(req, res) {
  const filter = {};
  if (req.query.divisionId) filter.divisionId = req.query.divisionId;
  if (req.query.status) filter.status = req.query.status;
  const cycles = await VdpCycle.find(filter).sort({ cycleStart: -1 }).populate('divisionId', 'divisionNumber name');
  res.json(cycles.map((c) => ({ ...c.toJSON(), division: c.divisionId, divisionId: c.divisionId?._id })));
}

// Company periods, newest first, each with every division's cycle for that period.
export async function periods(_req, res) {
  const [cycles, divisions] = await Promise.all([
    VdpCycle.find().sort({ cycleStart: -1 }),
    Division.find({ status: 'ACTIVE' }).sort({ divisionNumber: 1 }),
  ]);
  const byStart = new Map();
  for (const c of cycles) {
    const key = isoDate(c.cycleStart);
    if (!byStart.has(key)) {
      byStart.set(key, {
        cycleStart: c.cycleStart, cycleEnd: c.cycleEnd, week1Start: c.week1Start, week1End: c.week1End,
        week2Start: c.week2Start, week2End: c.week2End, submissionDate: c.submissionDate, paymentDate: c.paymentDate, cycles: [],
      });
    }
    byStart.get(key).cycles.push({ _id: c._id, divisionId: c.divisionId, status: c.status });
  }
  res.json({
    divisions: divisions.map((d) => ({ _id: d._id, divisionNumber: d.divisionNumber, name: d.name })),
    periods: [...byStart.values()],
  });
}

export async function get(req, res) {
  res.json(await cycleSummary(req.params.id));
}

// Generate `count` company periods starting with the one containing `fromDate` (default: today),
// for every active division. Existing cycles are left untouched; missing divisions are filled in.
export async function generate(req, res) {
  const count = Math.min(Math.max(Number(req.body.count) || 1, 1), 26);
  const from = req.body.fromDate || new Date();
  const divisions = await Division.find({ status: 'ACTIVE' });
  if (!divisions.length) throw badRequest('Create a division first.');
  const result = await createCycles(generateCycles(from, count, await cycleSchedule()), divisions);
  res.status(201).json({ ...result, divisions: divisions.length, periods: count });
}

// Preview the period containing a date without saving anything.
export async function preview(req, res) {
  const settings = await cycleSchedule();
  const [dates] = generateCycles(req.query.date || new Date(), 1, settings);
  res.json({ ...dates, alignedStart: cycleStartFor(req.query.date || new Date(), settings) });
}

export async function getSchedule(_req, res) {
  res.json(await cycleSchedule());
}

// Changes apply to cycles generated from now on; existing cycles keep their dates.
export async function updateSchedule(req, res) {
  const settings = await getCompanySettings();
  const b = req.body;
  if (b.anchorDate) {
    const d = toDateOnly(b.anchorDate);
    if (d.getUTCDay() !== 1) throw badRequest('The cycle anchor date must be a Monday (invoice weeks run Monday–Sunday).');
    settings.cycleSettings.anchorDate = d;
  }
  for (const k of ['submissionOffsetDays', 'paymentOffsetDays']) {
    if (b[k] !== undefined && b[k] !== '') {
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < 0) throw badRequest('Cycle offsets must be whole days.');
      settings.cycleSettings[k] = n;
    }
  }
  await settings.save();
  res.json(await cycleSchedule());
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
