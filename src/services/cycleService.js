// VDP cycle date generation. Dates are calendar dates handled as UTC midnight.
const DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_CYCLE_SETTINGS = {
  anchorDate: '2026-08-24', // any known cycle start (a Monday)
  lengthDays: 14,
  submissionOffsetDays: 15, // after cycle end ("Closed for Submission")
  paymentOffsetDays: 4, // after submission ("VDP Remittance / Pay Date")
};

export const toDateOnly = (value) => {
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) throw new Error(`Invalid date "${value}". Use YYYY-MM-DD.`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
};

export const addDays = (date, days) => new Date(toDateOnly(date).getTime() + days * DAY);
export const isoDate = (date) => toDateOnly(date).toISOString().slice(0, 10);

export function cycleDates(cycleStart, settings = DEFAULT_CYCLE_SETTINGS) {
  const start = toDateOnly(cycleStart);
  const length = settings.lengthDays ?? 14;
  const cycleEnd = addDays(start, length - 1);
  const submissionDate = addDays(cycleEnd, settings.submissionOffsetDays ?? 15);
  return {
    cycleStart: start,
    cycleEnd,
    week1Start: start,
    week1End: addDays(start, 6),
    week2Start: addDays(start, 7),
    week2End: addDays(start, 13),
    submissionDate,
    paymentDate: addDays(submissionDate, settings.paymentOffsetDays ?? 4),
  };
}

// Start of the cycle containing `date`, aligned to the division's anchor.
export function cycleStartFor(date, settings = DEFAULT_CYCLE_SETTINGS) {
  const anchor = toDateOnly(settings.anchorDate);
  const length = settings.lengthDays ?? 14;
  const diff = Math.floor((toDateOnly(date).getTime() - anchor.getTime()) / DAY);
  const offset = Math.floor(diff / length) * length;
  return addDays(anchor, offset);
}

// `count` consecutive cycles beginning with the one that contains `fromDate`.
export function generateCycles(fromDate, count, settings = DEFAULT_CYCLE_SETTINGS) {
  const first = cycleStartFor(fromDate, settings);
  return Array.from({ length: count }, (_, i) => cycleDates(addDays(first, i * (settings.lengthDays ?? 14)), settings));
}

export const weekOf = (date, cycle) => {
  const t = toDateOnly(date).getTime();
  if (t >= toDateOnly(cycle.week1Start).getTime() && t <= toDateOnly(cycle.week1End).getTime()) return 1;
  if (t >= toDateOnly(cycle.week2Start).getTime() && t <= toDateOnly(cycle.week2End).getTime()) return 2;
  return null;
};

// Offset (ms) of a time zone from UTC at a given instant.
function tzOffsetMs(instant, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - instant.getTime();
}

// The instant a calendar date ends in a time zone (= next local midnight), e.g. a submission deadline.
export function endOfDayIn(date, timeZone = 'America/Los_Angeles') {
  const next = addDays(date, 1); // UTC midnight of the next calendar day
  const guess = new Date(next.getTime() - tzOffsetMs(next, timeZone));
  return new Date(next.getTime() - tzOffsetMs(guess, timeZone)); // settle DST edges
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Calendar date of a moment as seen in a time zone: 'long' = Sep 26, 2026, 'short' = 09/26/2026.
export function localDate(instant, timeZone = 'America/Los_Angeles', style = 'long') {
  if (!instant) return '—';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return style === 'long'
    ? `${MONTH_NAMES[Number(p.month) - 1]} ${Number(p.day)}, ${p.year}`
    : `${p.month.padStart(2, '0')}/${p.day.padStart(2, '0')}/${p.year}`;
}

export function initialStatus(dates, today = new Date()) {
  const t = toDateOnly(today).getTime();
  if (t < dates.cycleStart.getTime()) return 'UPCOMING';
  return 'OPEN';
}
