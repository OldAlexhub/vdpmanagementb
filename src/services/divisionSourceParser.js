import path from 'node:path';
import XLSX from 'xlsx';
import { definitionForDataset } from './divisionSourceDefinitions.js';

export class DivisionSourceValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

const headerKey = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9#]+/g, ' ');
const iso = (year, month, day) => {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const value = new Date(Date.UTC(y, m - 1, d));
  if (value.getUTCFullYear() !== y || value.getUTCMonth() !== m - 1 || value.getUTCDate() !== d) return null;
  return value.toISOString().slice(0, 10);
};

const year4 = (value) => {
  const year = Number(value);
  return year < 100 ? 2000 + year : year;
};

function excelSerialDate(value) {
  if (!Number.isFinite(Number(value)) || Number(value) < 30000 || Number(value) > 80000) return null;
  const parsed = XLSX.SSF.parse_date_code(Number(value));
  return parsed ? iso(parsed.y, parsed.m, parsed.d) : null;
}

function datesInText(value, defaultYear = null, allowCompactMonthDay = false) {
  const text = String(value ?? '');
  const found = new Set();
  let match;
  const add = (year, month, day) => {
    const value = iso(year, month, day);
    if (value) found.add(value);
  };
  const ymd = /(?<!\d)(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g;
  while ((match = ymd.exec(text))) add(match[1], match[2], match[3]);
  const mdy = /(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2}|\d{2})(?!\d)/g;
  while ((match = mdy.exec(text))) {
    if (match[3].length === 4 || Number(match[3]) >= 20) add(year4(match[3]), match[1], match[2]);
  }
  const compactYmd = /(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g;
  while ((match = compactYmd.exec(text))) add(match[1], match[2], match[3]);
  const compactMdy = /(?<!\d)(\d{2})(\d{2})(20\d{2})(?!\d)/g;
  while ((match = compactMdy.exec(text))) add(match[3], match[1], match[2]);
  const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const named = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(20\d{2})\b/gi;
  while ((match = named.exec(text))) add(match[3], months[match[1].toLowerCase()], match[2]);
  if (defaultYear && allowCompactMonthDay) {
    const compactMd = /(?:^|[^0-9])(\d{2})(\d{2})(?:[^0-9]|$)/g;
    while ((match = compactMd.exec(text))) add(defaultYear, match[1], match[2]);
    const separatedMd = /(?<!\d)(\d{1,2})[.-](\d{1,2})(?![.\-/]\d)(?!\d)/g;
    while ((match = separatedMd.exec(text))) add(defaultYear, match[1], match[2]);
  }
  return [...found];
}

function dateValue(value, defaultYear = null) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return iso(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  const serial = excelSerialDate(value);
  if (serial) return serial;
  return datesInText(value, defaultYear)[0] || null;
}

function workbookSheets(buffer, fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (!['.xlsx', '.xls', '.csv'].includes(extension)) {
    throw new DivisionSourceValidationError('This dataset only accepts .xlsx, .xls, or .csv files.', { code: 'UNSUPPORTED_FILE_TYPE' });
  }
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: true });
  } catch (error) {
    throw new DivisionSourceValidationError(`The file could not be read: ${error.message}`, { code: 'UNREADABLE_FILE' });
  }
  return workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false }),
  }));
}

function findSourceSheet(sheets, definition) {
  const required = definition.requiredCells.map(headerKey);
  for (const sheet of sheets) {
    const visible = new Set(sheet.rows.slice(0, 40).flat().filter((value) => value !== null && value !== '').map(headerKey));
    if (required.every((cell) => visible.has(cell))) return sheet;
  }
  const detected = [...new Set(sheets.flatMap((sheet) => sheet.rows.slice(0, 20).flat()).filter((value) => typeof value === 'string' && value.trim()).map((value) => String(value).trim()))].slice(0, 80);
  throw new DivisionSourceValidationError(
    `This is not the expected ${definition.title} format. Required fields or report labels were not found: ${definition.requiredCells.join(', ')}.`,
    { code: 'WRONG_DATASET_SCHEMA', expectedFields: definition.requiredCells, detectedColumns: detected },
  );
}

function defaultYearFor(cycle) {
  return cycle?.cycleStart ? new Date(cycle.cycleStart).getUTCFullYear() : null;
}

function detectDates(sheet, definition, fileName, cycle) {
  const dates = new Set();
  const year = defaultYearFor(cycle);
  const wantedHeaders = new Set((definition.dateHeaders || []).map(headerKey));
  for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
    const row = sheet.rows[rowIndex];
    const headerIndexes = row.map((cell, index) => (wantedHeaders.has(headerKey(cell)) ? index : -1)).filter((index) => index >= 0);
    if (!headerIndexes.length) continue;
    for (let dataIndex = rowIndex + 1; dataIndex < sheet.rows.length; dataIndex += 1) {
      for (const index of headerIndexes) {
        const parsed = dateValue(sheet.rows[dataIndex][index], year);
        if (parsed) dates.add(parsed);
      }
    }
  }
  for (const column of definition.dateColumns || []) {
    for (const row of sheet.rows) {
      const parsed = dateValue(row[column], year);
      if (parsed) dates.add(parsed);
    }
  }
  for (const row of sheet.rows.slice(0, definition.scanDateTextRows || 0)) {
    for (const cell of row) for (const parsed of datesInText(cell, year)) dates.add(parsed);
  }
  for (const parsed of datesInText(fileName, year, Boolean(definition.allowCompactMonthDayFileName))) dates.add(parsed);
  return [...dates].sort();
}

export function parseDivisionSourceFile(buffer, fileName, divisionNumber, datasetType, { cycle = null } = {}) {
  const definition = definitionForDataset(divisionNumber, datasetType);
  if (!definition) {
    throw new DivisionSourceValidationError('That dataset is not part of this division\'s upload contract.', { code: 'DATASET_NOT_ALLOWED' });
  }
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (!definition.accept.includes(extension)) {
    throw new DivisionSourceValidationError(`${definition.title} accepts only ${definition.accept.join(', ')} files.`, { code: 'UNSUPPORTED_FILE_TYPE' });
  }
  const sheet = findSourceSheet(workbookSheets(buffer, fileName), definition);
  const datesDetected = detectDates(sheet, definition, fileName, cycle);
  if (!datesDetected.length) {
    throw new DivisionSourceValidationError(`No usable service date was found in ${fileName}.`, { code: 'DATES_NOT_FOUND' });
  }
  const populatedRows = sheet.rows.filter((row) => row.some((cell) => cell !== null && String(cell).trim() !== '')).length;
  return {
    datasetType: definition.id,
    sheetName: sheet.name,
    rowCount: Math.max(0, populatedRows - 1),
    datesDetected,
    dataRange: { from: datesDetected[0], to: datesDetected[datesDetected.length - 1] },
    detectedColumns: [...new Set(sheet.rows.slice(0, 40).flat().filter((value) => typeof value === 'string' && value.trim()).map((value) => String(value).trim()))].slice(0, 120),
  };
}

