import VdpCycle from '../models/VdpCycle.js';
import { isoDate } from './cycleService.js';
import { badRequest } from './errors.js';

const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const utcDate = (value) => new Date(`${value}T00:00:00.000Z`);

// Uploads identify their VDP period from source dates. The division is selected
// first because company periods have one cycle document per division.
export async function inferCycleFromDates({ divisionId, dates, label = 'dataset' }) {
  if (!divisionId) throw badRequest('Choose a division before uploading data.');
  const sourceDates = [...new Set((dates || []).map(String).filter(validDate))].sort();
  if (!sourceDates.length) throw badRequest(`The ${label} does not contain a usable date, so its VDP period could not be identified.`);
  const from = sourceDates[0];
  const to = sourceDates[sourceDates.length - 1];
  const cycles = await VdpCycle.find({
    divisionId,
    cycleStart: { $lte: utcDate(from) },
    cycleEnd: { $gte: utcDate(to) },
  }).sort({ cycleStart: 1 });
  if (!cycles.length) {
    throw badRequest(`The ${label} dates (${from} to ${to}) do not fit one generated VDP period for this division. Generate the period first, or upload files from only one period.`);
  }
  if (cycles.length > 1) {
    throw badRequest(`The ${label} dates match more than one VDP period. Check the cycle schedule before continuing.`);
  }
  const [cycle] = cycles;
  const outside = sourceDates.filter((date) => date < isoDate(cycle.cycleStart) || date > isoDate(cycle.cycleEnd));
  if (outside.length) throw badRequest(`The ${label} contains dates outside the identified VDP period.`);
  return cycle;
}
