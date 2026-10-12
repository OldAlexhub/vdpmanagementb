import XLSX from 'xlsx';

export const REQUIRED_UBER_TOLL_COLUMNS = [
  'Driver UUID',
  'Driver first name',
  'Driver last name',
  'Refunds & Expenses:Refunds:Toll',
];

export class UberTollFileValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

const normalizedHeader = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

function isoCompactDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

function addDays(day, count) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function periodFromFileName(fileName) {
  const match = /(?:^|[^0-9])(\d{8})-(\d{8})-payments_driver(?:[^a-z]|$)/i.exec(String(fileName || ''));
  const week = isoCompactDate(match?.[1]);
  const endExclusive = isoCompactDate(match?.[2]);
  if (!week || !endExclusive) {
    throw new UberTollFileValidationError(
      'The toll filename must begin with the Uber export period, for example 20260907-20260914-payments_driver-Company.csv.',
      { code: 'TOLL_PERIOD_NOT_FOUND' },
    );
  }
  if (endExclusive !== addDays(week, 7)) {
    throw new UberTollFileValidationError('The Uber toll export filename must cover one seven-day week.', {
      code: 'INVALID_TOLL_PERIOD', week, endExclusive,
    });
  }
  return { week, endExclusive };
}

function exactMoney(value) {
  if (value === null || value === undefined || String(value).trim() === '') return '0.00';
  const clean = String(value).trim().replace(/[$,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const number = Number(clean);
  if (!Number.isFinite(number)) return null;
  return number.toFixed(2);
}

export async function parseUberTollFile(buffer, fileName) {
  const extension = String(fileName || '').toLowerCase().split('.').pop();
  if (!['csv', 'xlsx', 'xls'].includes(extension)) {
    throw new UberTollFileValidationError('Uber toll reimbursement files must be .csv, .xlsx, or .xls.', { code: 'UNSUPPORTED_FILE_TYPE' });
  }
  const period = periodFromFileName(fileName);
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', raw: true });
  } catch (error) {
    throw new UberTollFileValidationError(`The toll reimbursement file could not be read: ${error.message}`, { code: 'UNREADABLE_FILE' });
  }
  const sheetName = workbook.SheetNames[0];
  const sourceRows = sheetName
    ? XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null, blankrows: false })
    : [];
  if (!sourceRows.length) throw new UberTollFileValidationError('The toll reimbursement file is empty.', { code: 'EMPTY_FILE' });
  const required = new Set(REQUIRED_UBER_TOLL_COLUMNS.map(normalizedHeader));
  const headerIndex = sourceRows.slice(0, 10).findIndex((row) => row.filter((cell) => required.has(normalizedHeader(cell))).length >= 3);
  if (headerIndex < 0) throw new UberTollFileValidationError('Could not find the Uber driver-payment header row.', { code: 'HEADER_NOT_FOUND' });
  const headers = sourceRows[headerIndex].map((header) => String(header ?? '').trim());
  const indexes = new Map(headers.map((header, index) => [normalizedHeader(header), index]));
  const missingColumns = REQUIRED_UBER_TOLL_COLUMNS.filter((column) => !indexes.has(normalizedHeader(column)));
  if (missingColumns.length) {
    throw new UberTollFileValidationError(`Missing required Uber toll column${missingColumns.length === 1 ? '' : 's'}: ${missingColumns.join(', ')}.`, {
      code: 'MISSING_COLUMNS', missingColumns, detectedColumns: headers.filter(Boolean),
    });
  }

  const rows = [];
  const errors = [];
  const seen = new Set();
  const valueAt = (row, column) => row[indexes.get(normalizedHeader(column))];
  for (let index = headerIndex + 1; index < sourceRows.length; index += 1) {
    const source = sourceRows[index];
    if (!source.some((value) => value !== null && String(value).trim() !== '')) continue;
    const rowNumber = index + 1;
    const driverUuid = String(valueAt(source, 'Driver UUID') ?? '').trim();
    const tollAmount = exactMoney(valueAt(source, 'Refunds & Expenses:Refunds:Toll'));
    if (!driverUuid) errors.push(`Row ${rowNumber}, Driver UUID: value is required.`);
    if (tollAmount === null) errors.push(`Row ${rowNumber}, Refunds & Expenses:Refunds:Toll: expected a non-negative dollar amount with at most two decimals.`);
    const key = driverUuid.toLowerCase();
    if (key && seen.has(key)) errors.push(`Row ${rowNumber}: duplicate Driver UUID ${driverUuid}.`);
    if (key) seen.add(key);
    if (!driverUuid || tollAmount === null) continue;
    rows.push({
      week: period.week,
      endExclusive: period.endExclusive,
      driverUuid,
      sourceFirstName: String(valueAt(source, 'Driver first name') ?? '').trim(),
      sourceLastName: String(valueAt(source, 'Driver last name') ?? '').trim(),
      amount: tollAmount,
    });
  }
  if (errors.length) {
    throw new UberTollFileValidationError(`Uber toll validation failed. ${errors.slice(0, 20).join(' ')}`, {
      code: 'MALFORMED_ROWS', errors, detectedColumns: headers.filter(Boolean),
    });
  }
  if (!rows.length) throw new UberTollFileValidationError('The Uber toll reimbursement file has no driver rows.', { code: 'NO_DATA_ROWS' });
  const tollTotal = rows.reduce((total, row) => total + Number(row.amount), 0).toFixed(2);
  return {
    rows,
    rowCount: rows.length,
    detectedColumns: headers.filter(Boolean),
    weeksDetected: [period.week],
    driversDetected: new Set(rows.map((row) => row.driverUuid.toLowerCase())).size,
    tollRowCount: rows.filter((row) => Number(row.amount) > 0).length,
    tollTotal,
    ...period,
  };
}

