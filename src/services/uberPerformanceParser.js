import XLSX from 'xlsx';

export const REQUIRED_UBER_COLUMNS = [
  'Total Supply Hours',
  'Paused Hours',
  'Core Hours_Total Supply Hours',
  'Utilized Hours',
  'Total_Accepts',
  'Total_Rejects',
  'Total_Expired_Offers',
  'Total_Cancels',
  'Driver_Earnings_Excl_Tips',
  'Driver_Tips',
  'Driver_UUID',
  'Week',
];

const NUMERIC_COLUMNS = REQUIRED_UBER_COLUMNS.filter((column) => !['Driver_UUID', 'Week'].includes(column));
const FIELD_NAMES = {
  'Total Supply Hours': 'totalSupplyHours',
  'Paused Hours': 'pausedHours',
  'Core Hours_Total Supply Hours': 'coreHoursTotalSupplyHours',
  'Utilized Hours': 'utilizedHours',
  Total_Accepts: 'totalAccepts',
  Total_Rejects: 'totalRejects',
  Total_Expired_Offers: 'totalExpiredOffers',
  Total_Cancels: 'totalCancels',
  Driver_Earnings_Excl_Tips: 'driverEarningsExclTips',
  Driver_Tips: 'driverTips',
};

export class UberFileValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

const normalizedHeader = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

function isoWeek(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const us = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/.exec(text);
  if (us) {
    const year = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    const month = Number(us[1]);
    const day = Number(us[2]);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day) {
      return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

function exactNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel stores decimals as IEEE doubles. Fifteen significant digits removes
    // artifacts such as 1199.94999999999 while retaining worksheet precision.
    return Number(value.toPrecision(15)).toString();
  }
  if (typeof value === 'string') {
    const clean = value.trim().replace(/[$,]/g, '');
    if (/^-?\d+(\.\d+)?$/.test(clean)) return clean;
  }
  return null;
}

// Uber exports use the database-style \N sentinel when an additive numeric
// metric has no reported value. Accounting treats those cells as exact zero;
// other non-numeric text remains a validation error.
const isUberNull = (value) => typeof value === 'string' && value.trim().toUpperCase() === '\\N';

function workbookRows(buffer, fileName) {
  const extension = String(fileName || '').toLowerCase().split('.').pop();
  if (!['xlsx', 'xls', 'csv'].includes(extension)) {
    throw new UberFileValidationError('Uber data files must be .xlsx, .xls, or .csv.', { code: 'UNSUPPORTED_FILE_TYPE' });
  }
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: true });
  } catch (error) {
    throw new UberFileValidationError(`The workbook could not be read: ${error.message}`, { code: 'UNREADABLE_FILE' });
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new UberFileValidationError('The workbook has no worksheets.', { code: 'EMPTY_WORKBOOK' });
  return {
    sheetName,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null, blankrows: false }),
  };
}

export async function parseUberPerformanceFile(buffer, fileName) {
  const { sheetName, rows } = workbookRows(buffer, fileName);
  if (!rows.length) throw new UberFileValidationError('The Uber data file is empty.', { code: 'EMPTY_FILE' });

  const requiredKeys = new Set(REQUIRED_UBER_COLUMNS.map(normalizedHeader));
  const headerIndex = rows.slice(0, 20).findIndex((row) => row.filter((cell) => requiredKeys.has(normalizedHeader(cell))).length >= 4);
  if (headerIndex < 0) {
    throw new UberFileValidationError('Could not find the Uber data header row.', { code: 'HEADER_NOT_FOUND', missingColumns: REQUIRED_UBER_COLUMNS });
  }
  const headers = rows[headerIndex].map((header) => String(header ?? '').trim());
  const byNormalized = new Map(headers.map((header, index) => [normalizedHeader(header), index]));
  const missingColumns = REQUIRED_UBER_COLUMNS.filter((column) => !byNormalized.has(normalizedHeader(column)));
  if (missingColumns.length) {
    throw new UberFileValidationError(`Missing required Uber column${missingColumns.length === 1 ? '' : 's'}: ${missingColumns.join(', ')}.`, {
      code: 'MISSING_COLUMNS', missingColumns, detectedColumns: headers.filter(Boolean), sheetName,
    });
  }

  const parsed = [];
  const errors = [];
  const warnings = [];
  const seen = new Set();
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const source = rows[i];
    if (!source.some((value) => value !== null && String(value).trim() !== '')) continue;
    const rowNumber = i + 1;
    const valueFor = (column) => source[byNormalized.get(normalizedHeader(column))];
    const optionalValueFor = (...columns) => {
      const column = columns.find((candidate) => byNormalized.has(normalizedHeader(candidate)));
      return column ? source[byNormalized.get(normalizedHeader(column))] : null;
    };
    const driverUuid = String(valueFor('Driver_UUID') ?? '').trim();
    const week = isoWeek(valueFor('Week'));
    if (!driverUuid) errors.push(`Row ${rowNumber}, Driver_UUID: value is required.`);
    if (!week) errors.push(`Row ${rowNumber}, Week: expected a valid date, found "${String(valueFor('Week') ?? '')}".`);
    const numeric = {};
    const sourceZeroFields = [];
    for (const column of NUMERIC_COLUMNS) {
      const value = valueFor(column);
      const sourceNull = isUberNull(value);
      const parsedNumber = sourceNull ? '0' : exactNumber(value);
      if (parsedNumber === null) errors.push(`Row ${rowNumber}, ${column}: expected a numeric value, found "${String(value ?? '')}".`);
      else {
        numeric[FIELD_NAMES[column]] = parsedNumber;
        if (sourceNull) sourceZeroFields.push(column);
      }
    }
    if (sourceZeroFields.length) warnings.push(`Row ${rowNumber}: Uber \\N treated as 0 for ${sourceZeroFields.join(', ')}.`);
    const key = driverUuid && week ? `${driverUuid.toLowerCase()}|${week}` : null;
    if (key && seen.has(key)) errors.push(`Row ${rowNumber}: duplicate Driver_UUID and Week (${driverUuid}, ${week}).`);
    if (key) seen.add(key);
    if (!driverUuid || !week || NUMERIC_COLUMNS.some((column) => numeric[FIELD_NAMES[column]] === undefined)) continue;
    parsed.push({
      week,
      driverUuid,
      // These two optional source values are retained only to suggest a match
      // to the provider-profile operator. The profile remains the master name.
      sourceFirstName: String(optionalValueFor('First_Name', 'First Name', 'FirstName') ?? '').trim(),
      sourceLastName: String(optionalValueFor('Last_Name', 'Last Name', 'LastName') ?? '').trim(),
      sourceZeroFields,
      ...numeric,
    });
  }
  if (errors.length) {
    const shown = errors.slice(0, 20);
    const more = errors.length > shown.length ? ` ${errors.length - shown.length} additional error(s) were found.` : '';
    throw new UberFileValidationError(`Uber data validation failed. ${shown.join(' ')}${more}`, {
      code: 'MALFORMED_ROWS', errors, detectedColumns: headers.filter(Boolean), sheetName,
    });
  }
  if (!parsed.length) throw new UberFileValidationError('The Uber data file has no driver rows.', { code: 'NO_DATA_ROWS', detectedColumns: headers.filter(Boolean), sheetName });
  return {
    rows: parsed,
    rowCount: parsed.length,
    sheetName,
    detectedColumns: headers.filter(Boolean),
    warnings,
    weeksDetected: [...new Set(parsed.map((row) => row.week))].sort(),
    driversDetected: new Set(parsed.map((row) => row.driverUuid.toLowerCase())).size,
  };
}
