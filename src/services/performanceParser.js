// Performance Report parser (Trapeze "Paratransit Operation Report" and simple tabular exports).
// Works on a 2-D array of cell values so XLSX and CSV share one code path.
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { D, sum } from './money.js';

export class ReportFormatError extends Error {}

export const HOUR_METRICS = {
  TOTAL_HOURS: { label: 'Total Hours', field: 'totalHours' },
  SERVICE_HOURS: { label: 'Service Hours', field: 'serviceHours' },
  REVENUE_HOURS: { label: 'Revenue Hours', field: 'revenueHours' },
  OTHER: { label: 'Other column', field: null },
};

const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return v.text;
    return null;
  }
  return v;
}

export async function readGrid(buffer, fileName) {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(fileName)) {
    await wb.csv.read(Readable.from(buffer), { parserOptions: { relax_column_count: true } });
  } else if (/\.xlsx$/i.test(fileName)) {
    await wb.xlsx.load(buffer);
  } else {
    throw new ReportFormatError('Unsupported file type. Upload the Performance Report as .xlsx or .csv.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new ReportFormatError('The file has no worksheet.');
  const grid = [];
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { values[col - 1] = cellValue(cell.value); });
    grid[rowNumber - 1] = values;
  });
  return Array.from(grid, (r) => r || []);
}

function parseDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function parseNumber(v) {
  if (v === null || v === undefined) return { value: D(0), ok: true };
  if (typeof v === 'number') return { value: D(v), ok: Number.isFinite(v) };
  const s = String(v).replace(/[,$\s]/g, '');
  if (s === '' || s === '-') return { value: D(0), ok: true };
  if (!/^-?\d*\.?\d+$/.test(s)) return { value: D(0), ok: false };
  return { value: D(s), ok: true };
}

function detectColumns(grid) {
  const headerIdx = grid.findIndex((row) => {
    const cells = row.map(norm);
    return cells.includes('date') && cells.some((c) => c === 'run/route' || c === 'route' || c === 'run') &&
      cells.includes('total prov');
  });
  if (headerIdx === -1) {
    throw new ReportFormatError(
      'Could not find the Performance Report header row. Expected columns "Date", "Run/Route" and "Total Prov".',
    );
  }
  const header = grid[headerIdx].map(norm);

  // Group header row (Trips / Passengers / Fares / Miles / Hours) sits just above.
  let groups = [];
  for (let i = headerIdx - 1; i >= Math.max(0, headerIdx - 3); i -= 1) {
    const row = grid[i].map(norm);
    if (row.includes('hours')) {
      groups = row.map((name, col) => ({ name, col })).filter((g) => g.name);
      break;
    }
  }
  const groupOf = (col) => {
    let name = null;
    for (const g of groups) if (g.col <= col) name = g.name;
    return name;
  };

  const find = (pred) => header.findIndex((h, col) => pred(h, col));
  const findLast = (pred) => {
    for (let c = header.length - 1; c >= 0; c -= 1) if (pred(header[c], c)) return c;
    return -1;
  };
  const inHours = (col) => (groups.length ? groupOf(col) === 'hours' : true);

  const cols = {
    date: find((h) => h === 'date'),
    route: find((h) => h === 'run/route' || h === 'route' || h === 'run'),
    trips: find((h) => h === 'total prov'),
    totalHours: find((h, c) => h === 'total hours' && inHours(c)),
    serviceHours: groups.length
      ? find((h, c) => (h === 'service' || h === 'service hours') && inHours(c))
      : find((h) => h === 'service hours'),
    revenueHours: groups.length
      ? find((h, c) => (h.startsWith('rev') || h === 'revenue hours') && inHours(c))
      : find((h) => h === 'revenue hours'),
  };
  if (cols.totalHours === -1) cols.totalHours = findLast((h) => h === 'total hours');

  const other = {};
  header.forEach((h, c) => {
    if (h && inHours(c) && groups.length && ![cols.totalHours, cols.serviceHours, cols.revenueHours].includes(c)) {
      other[grid[headerIdx][c]?.toString().trim()] = c;
    }
  });

  const hourCols = [cols.totalHours, cols.serviceHours, cols.revenueHours].filter((c) => c >= 0);
  if (hourCols.length === 0) {
    throw new ReportFormatError('No hour columns found (expected "Total Hours" in the Hours section).');
  }
  return { headerIdx, cols, other };
}

/**
 * @returns {{ rows, detectedColumns, reportRange, stats, warnings }}
 * rows are aggregated by date+route and restricted to [from, to] when given.
 */
export function parsePerformanceGrid(grid, { from, to } = {}) {
  const { headerIdx, cols, other } = detectColumns(grid);
  const warnings = [];
  const stats = { dataRows: 0, skippedTotals: 0, skippedBanners: 0, outsideCycle: 0, invalidDates: 0 };

  let reportRange = null;
  for (const row of grid.slice(0, headerIdx)) {
    for (const c of row) {
      const m = /From:\s*(\d{2}\/\d{2}\/\d{4})\s*To:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(String(c ?? ''));
      if (m) reportRange = { from: parseDate(m[1]), to: parseDate(m[2]) };
    }
  }

  const agg = new Map();
  let minDate = null;
  let maxDate = null;
  for (let i = headerIdx + 1; i < grid.length; i += 1) {
    const row = grid[i];
    const rawDate = row[cols.date];
    const route = String(row[cols.route] ?? '').trim();
    const dateText = norm(rawDate);
    if (!dateText && !route) continue;
    if (dateText.includes('total') || norm(route).includes('total') || norm(row[cols.date + 1]).includes('total')) {
      stats.skippedTotals += 1;
      continue;
    }
    const date = parseDate(rawDate);
    if (!date) {
      if (dateText && !['#', '%'].includes(dateText)) stats.invalidDates += 1;
      continue;
    }
    if (!route) {
      stats.skippedBanners += 1;
      continue;
    }
    if ((from && date < from) || (to && date > to)) {
      stats.outsideCycle += 1;
      continue;
    }
    stats.dataRows += 1;
    minDate = !minDate || date < minDate ? date : minDate;
    maxDate = !maxDate || date > maxDate ? date : maxDate;

    const num = (col, name) => {
      if (col < 0) return null;
      const r = parseNumber(row[col]);
      if (!r.ok) warnings.push(`Row ${i + 1}: "${row[col]}" in ${name} is not a number — treated as 0.`);
      return r.value;
    };
    const key = `${date}|${route}`;
    const entry = agg.get(key) || { date, route, trips: [], totalHours: [], serviceHours: [], revenueHours: [], otherHours: {} };
    entry.trips.push(num(cols.trips, 'Total Prov'));
    for (const f of ['totalHours', 'serviceHours', 'revenueHours']) {
      const v = num(cols[f], f);
      if (v !== null) entry[f].push(v);
    }
    for (const [name, col] of Object.entries(other)) {
      const v = parseNumber(row[col]);
      if (v.ok) (entry.otherHours[name] ||= []).push(v.value);
    }
    agg.set(key, entry);
  }

  const rows = [...agg.values()]
    .sort((a, b) => (a.date === b.date ? a.route.localeCompare(b.route, undefined, { numeric: true }) : a.date.localeCompare(b.date)))
    .map((e) => ({
      date: e.date,
      route: e.route,
      trips: sum(e.trips).toString(),
      totalHours: e.totalHours.length ? sum(e.totalHours).toString() : null,
      serviceHours: e.serviceHours.length ? sum(e.serviceHours).toString() : null,
      revenueHours: e.revenueHours.length ? sum(e.revenueHours).toString() : null,
      otherHours: Object.fromEntries(Object.entries(e.otherHours).map(([k, v]) => [k, sum(v).toString()])),
    }));

  const detectedColumns = {
    date: cols.date >= 0,
    route: cols.route >= 0,
    trips: cols.trips >= 0,
    TOTAL_HOURS: cols.totalHours >= 0,
    SERVICE_HOURS: cols.serviceHours >= 0,
    REVENUE_HOURS: cols.revenueHours >= 0,
    otherHourColumns: Object.keys(other),
  };

  return { rows, detectedColumns, reportRange, dataRange: { from: minDate, to: maxDate }, stats, warnings: warnings.slice(0, 50) };
}

export async function parsePerformanceFile(buffer, fileName, range) {
  const grid = await readGrid(buffer, fileName);
  return parsePerformanceGrid(grid, range);
}

// Hours for a stored row under a plan's metric.
export function hoursForMetric(row, metric, otherColumn) {
  if (metric === 'OTHER') {
    const v = row.otherHours?.[otherColumn] ?? (row.otherHours instanceof Map ? row.otherHours.get(otherColumn) : undefined);
    return v === undefined || v === null ? null : v;
  }
  const field = HOUR_METRICS[metric]?.field;
  return field ? row[field] : null;
}
