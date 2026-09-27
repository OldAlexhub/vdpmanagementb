// Generic pieces of the bulk-import Excel templates: building a sheet with coloured
// headers and drop-downs, and reading a filled-in sheet back into plain values.
import ExcelJS from 'exceljs';
import { toDateOnly } from './cycleService.js';
import { D } from './money.js';
import { badRequest } from './errors.js';

export const MAX_ROWS = 1000;
const DAY = 24 * 60 * 60 * 1000;

export const LEVELS = {
  required: { text: 'Required', fill: 'FF9F1D1D' },
  recommended: { text: 'Needed — blank uses the default or is flagged', fill: 'FFB45309' },
  optional: { text: 'Optional', fill: 'FF475569' },
};

export const headerText = (c) => (c.level === 'required' ? `${c.header} *` : c.header);
export const norm = (v) => String(v ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const colLetter = (n) => (n > 26 ? colLetter(Math.floor((n - 1) / 26)) : '') + String.fromCharCode(65 + ((n - 1) % 26));
const quoteSheet = (name) => `'${name.replace(/'/g, "''")}'`;
export const sheetRange = (sheet, col, last = MAX_ROWS + 1) => `${quoteSheet(sheet)}!$${col}$2:$${col}$${last}`;

// ---------- building ----------

// Drop-down values that come from the database live on a hidden "Lists" sheet.
// listRanges() gives the ranges the drop-downs point at; addListsSheet() writes the
// sheet itself (added last so it is never the first tab).
export const listRanges = (lists) =>
  Object.fromEntries(Object.entries(lists).map(([key, values], i) => [key, sheetRange('Lists', colLetter(i + 1), Math.max(values.length, 1) + 1)]));

export function addListsSheet(wb, lists) {
  const ws = wb.addWorksheet('Lists', { state: 'veryHidden' });
  Object.entries(lists).forEach(([key, values], i) => {
    const col = colLetter(i + 1);
    ws.getCell(`${col}1`).value = key;
    values.forEach((v, j) => { ws.getCell(`${col}${j + 2}`).value = v; });
  });
}

function validationFor(c, listRefs) {
  const base = { allowBlank: true, showErrorMessage: true, errorTitle: c.header, showInputMessage: Boolean(c.help), promptTitle: c.header.slice(0, 32), prompt: (c.help || '').slice(0, 255) };
  if (c.list || c.listKey || c.listFormula) {
    const formula = c.list ? `"${c.list.join(',')}"` : c.listFormula || listRefs[c.listKey];
    return {
      ...base,
      type: 'list',
      formulae: [formula],
      errorStyle: c.loose ? 'warning' : 'stop',
      error: c.loose ? 'This value is not in the list. Continue to keep it as typed.' : 'Choose a value from the drop-down list.',
    };
  }
  if (c.type === 'date') return { ...base, type: 'date', operator: 'greaterThan', formulae: [new Date(Date.UTC(2000, 0, 1))], error: 'Enter a date (YYYY-MM-DD).' };
  if (c.type === 'whole') return { ...base, type: 'whole', operator: 'between', formulae: [0, 365], error: 'Enter a whole number of days (0 or more).' };
  if (c.type === 'decimal') return { ...base, type: 'decimal', operator: 'greaterThanOrEqual', formulae: [0], error: 'Enter a number (0 or more), without $ or %.' };
  if (c.help) return { ...base, type: 'any' };
  return null;
}

export function addDataSheet(wb, { name, columns, listRefs, tab }) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }], properties: { tabColor: tab ? { argb: tab } : undefined } });
  ws.columns = columns.map((c) => ({
    key: c.key,
    header: headerText(c),
    width: c.width || Math.max(14, headerText(c).length + 4),
    style: c.type === 'date' ? { numFmt: 'yyyy-mm-dd' } : c.text ? { numFmt: '@' } : {},
  }));
  const head = ws.getRow(1);
  head.height = 32;
  columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LEVELS[c.level].fill } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.note = `${LEVELS[c.level].text}.${c.help ? `\n${c.help}` : ''}`;
    const dv = validationFor(c, listRefs);
    const col = colLetter(i + 1);
    if (dv) ws.dataValidations.add(`${col}2:${col}${MAX_ROWS + 1}`, dv);
  });
  ws.autoFilter = { from: 'A1', to: `${colLetter(columns.length)}1` };
  return ws;
}

// Read-only list of what is already in the system, so people can check before filling in.
export function addReferenceSheet(wb, { name, headers, rows }) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }], properties: { tabColor: { argb: 'FF64748B' } } });
  ws.columns = headers.map((h) => ({ header: h, width: Math.max(16, h.length + 4) }));
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  if (!rows.length) ws.addRow(['(none yet)']);
  return ws;
}

export function addInstructionsSheet(wb, { title, intro, steps, sheets }) {
  const ws = wb.addWorksheet('Instructions', { properties: { tabColor: { argb: 'FF1D4ED8' } } });
  ws.columns = [{ width: 38 }, { width: 22 }, { width: 70 }, { width: 26 }];
  ws.addRow([title]).font = { bold: true, size: 16 };
  intro.forEach((line) => ws.addRow([line]));
  ws.addRow([]);
  ws.addRow(['How to use this file']).font = { bold: true, size: 13 };
  steps.forEach((s, i) => ws.addRow([`${i + 1}. ${s}`]));
  ws.addRow([]);
  ws.addRow(['Header colours']).font = { bold: true, size: 13 };
  for (const lvl of Object.values(LEVELS)) {
    const r = ws.addRow([lvl.text]);
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: lvl.fill } };
    r.getCell(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  }
  for (const s of sheets) {
    ws.addRow([]);
    ws.addRow([`Sheet “${s.name}”`]).font = { bold: true, size: 13 };
    const h = ws.addRow(['Column', 'Required?', 'What to enter', 'Example']);
    h.font = { bold: true };
    for (const c of s.columns) {
      const allowed = c.list ? ` Choose: ${c.list.join(' / ')}.` : c.listKey || c.listFormula ? ' Choose from the drop-down.' : '';
      const r = ws.addRow([c.header, LEVELS[c.level].text.split(' — ')[0], `${c.help || ''}${allowed}`.trim(), c.example ?? '']);
      r.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    }
  }
  return ws;
}

export const newWorkbook = () => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Big Star VDP';
  wb.created = new Date();
  return wb;
};

// ---------- reading ----------

function rawValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('error' in v) return null;
    if ('result' in v) return rawValue(v.result);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return rawValue(v.text);
    return null;
  }
  return v;
}

function readCell(cell, column) {
  const v = rawValue(cell.value);
  if (v === null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') {
    // Excel stores 25.97 as a double; 15 significant digits gives back what was typed.
    const s = String(Number(v.toPrecision(15)));
    if (column.percent && /%/.test(cell.numFmt || '')) return D(s).times(100).toString();
    return s;
  }
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

export async function loadWorkbook(file) {
  if (!file) throw badRequest('Choose the completed Excel template to upload.');
  if (!/\.xlsx$/i.test(file.originalname || '')) throw badRequest('Upload the .xlsx template (an Excel workbook).');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(file.buffer);
  } catch {
    throw badRequest('The file could not be read as an Excel workbook.');
  }
  return wb;
}

// Rows of { row, values: { key: string | Date | null } }, blank rows skipped.
// Columns are matched by header text, so re-ordering columns is harmless.
export function readSheet(wb, name, columns, { optional = false } = {}) {
  const ws = wb.getWorksheet(name);
  if (!ws) {
    if (optional) return [];
    throw badRequest(`The workbook has no “${name}” sheet. Download a fresh template and fill that in.`);
  }
  const index = {};
  ws.getRow(1).eachCell((cell, n) => {
    const h = norm(rawValue(cell.value));
    const c = columns.find((x) => norm(x.header) === h);
    if (c && !index[c.key]) index[c.key] = n;
  });
  const missing = columns.filter((c) => c.level === 'required' && !index[c.key]);
  if (missing.length) {
    throw badRequest(`The “${name}” sheet is missing the column(s): ${missing.map((c) => c.header).join(', ')}. Download a fresh template.`);
  }
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const values = {};
    let any = false;
    for (const c of columns) {
      values[c.key] = index[c.key] ? readCell(row.getCell(index[c.key]), c) : null;
      if (values[c.key] !== null) any = true;
    }
    if (any) rows.push({ row: r, values });
  }
  if (rows.length > MAX_ROWS) throw badRequest(`The “${name}” sheet has ${rows.length} rows. Upload at most ${MAX_ROWS} at a time.`);
  return rows;
}

// Accepts Excel dates, YYYY-MM-DD, M/D/YYYY and raw Excel serial numbers.
export function parseDate(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return toDateOnly(v);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return toDateOnly(s);
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  m = /^\d{5}(\.\d+)?$/.exec(s);
  if (m) return toDateOnly(new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * DAY));
  return undefined;
}
