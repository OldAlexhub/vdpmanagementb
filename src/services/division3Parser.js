import XLSX from 'xlsx';
import Decimal from 'decimal.js';
import { normalizeName } from './uberDriverMatching.js';

export const DIV3_IMPORT_KINDS = ['DIV3_ADA', 'DIV3_GOLINK', 'DIV3_ADA_FARE', 'DIV3_RETURNED_FARE'];
export const DIV3_ADA_FARE_RATE = '3.50';

// Name corrections are taken from the DIV 3 template queries. They are join
// aliases only; the uploaded spelling stays in the audit row and Compass stays
// the canonical operator identity.
const DIV3_DRIVER_ALIASES = new Map(Object.entries({
  'carol ann fagbemi': 'carol fagbemi',
  'tania hourruntinier': 'tania hourrutinier',
  'phillip saylor': 'philip saylor',
  'james king': 'james king jr',
  'cristian angel cordova': 'cristian cordova',
  'jontavia williams': 'jontavia millege williams',
  'charles dewit': 'charles dewitt',
  'williams sanders': 'sanders williams',
  'johnathan de la rosa': 'jonathan de la rosa',
  'catreana robinson': 'catreana cox robinson',
  'ameila bailey': 'amelia bailey',
  'billy prichett': 'billy pritchett',
  'jean luc kanga': 'jean luc olivier kanga',
  'candice cunnigham': 'candace cunningham',
  'karina jiminez': 'karina jimenez',
  'henok behre': 'henok berhe',
  'loveday igwe bst': 'loveday igwe',
  'alison skinny greene': 'alison greene',
}));

export function division3DriverKey(value) {
  const withoutSourceSuffix = String(value || '').replace(/\(\s*big star\s*\)/ig, ' ');
  const normalized = normalizeName(withoutSourceSuffix);
  return DIV3_DRIVER_ALIASES.get(normalized) || normalized;
}

export class Division3FileValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

const normalizedHeader = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const blank = (value) => value === null || value === undefined || String(value).trim() === '' || String(value).trim() === '-';

function exactNumber(value, { blankAsZero = false } = {}) {
  if (blank(value)) return blankAsZero ? '0' : null;
  if (typeof value === 'number' && Number.isFinite(value)) return Number(value.toPrecision(15)).toString();
  const clean = String(value).trim().replace(/[$,% ,]/g, '');
  if (/^-?\d+(\.\d+)?$/.test(clean)) return clean;
  return null;
}

function dateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H || 0, parsed.M || 0, Math.floor(parsed.S || 0)));
  }
  const text = String(value ?? '').trim();
  if (!text || text === '-') return null;
  const us = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})(?:\s+(.+))?$/.exec(text);
  if (us) {
    const year = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    const parsed = new Date(`${year}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}T${us[4] || '00:00:00'}`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const isoDate = (value) => {
  if (typeof value === 'string') {
    const text = value.trim();
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
    if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
    const us = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})/.exec(text);
    if (us) {
      const year = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
      return `${year}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`;
    }
    const named = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(text);
    if (named) {
      const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
      const month = months.indexOf(named[1].toLowerCase()) + 1;
      if (month > 0) return `${named[3]}-${String(month).padStart(2, '0')}-${String(named[2]).padStart(2, '0')}`;
    }
  }
  const parsed = dateValue(value);
  if (!parsed) return null;
  return parsed.toISOString().slice(0, 10);
};

const isoTime = (value) => {
  const parsed = dateValue(value);
  return parsed ? parsed.toISOString() : null;
};

function workbookRows(buffer, fileName) {
  const extension = String(fileName || '').toLowerCase().split('.').pop();
  if (!['xlsx', 'xls', 'csv'].includes(extension)) {
    throw new Division3FileValidationError('Division 3 data files must be .xlsx, .xls, or .csv.', { code: 'UNSUPPORTED_FILE_TYPE' });
  }
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: true });
  } catch (error) {
    throw new Division3FileValidationError(`The workbook could not be read: ${error.message}`, { code: 'UNREADABLE_FILE' });
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Division3FileValidationError('The workbook has no worksheets.', { code: 'EMPTY_WORKBOOK' });
  return {
    sheetName,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null, blankrows: false }),
  };
}

function table(buffer, fileName, required, aliases = {}) {
  const { rows, sheetName } = workbookRows(buffer, fileName);
  const names = new Set(required.flatMap((name) => [name, ...(aliases[name] || [])]).map(normalizedHeader));
  const headerIndex = rows.slice(0, 25).findIndex((row) => row.filter((cell) => names.has(normalizedHeader(cell))).length >= Math.min(4, required.length));
  if (headerIndex < 0) throw new Division3FileValidationError('Could not find the Division 3 data header row.', { code: 'HEADER_NOT_FOUND' });
  const headers = rows[headerIndex].map((header) => String(header ?? '').trim());
  const indexes = new Map(headers.map((header, index) => [normalizedHeader(header), index]));
  const indexOf = (name) => [name, ...(aliases[name] || [])].map(normalizedHeader).map((key) => indexes.get(key)).find((index) => index !== undefined);
  const missingColumns = required.filter((name) => indexOf(name) === undefined);
  if (missingColumns.length) {
    throw new Division3FileValidationError(`Missing required column${missingColumns.length === 1 ? '' : 's'}: ${missingColumns.join(', ')}.`, {
      code: 'MISSING_COLUMNS', missingColumns, detectedColumns: headers.filter(Boolean), sheetName,
    });
  }
  return {
    sheetName,
    headers,
    records: rows.slice(headerIndex + 1).filter((row) => row.some((value) => !blank(value))).map((row, offset) => ({
      row,
      rowNumber: headerIndex + offset + 2,
      get: (name) => row[indexOf(name)],
      has: (name) => indexOf(name) !== undefined,
    })),
  };
}

const DUTY_COLUMNS = [
  'Driver Name', 'Provider', 'Duty ID', 'Duty Scheduled Start Time', 'Duty Scheduled End Time',
  'Duty Status', 'First Seen In Service Area Time', 'Last Seen In Service Area Time',
  'Total Duty Duration (hours)', 'Total Scheduled Duty Duration (hours)', 'Total Revenue Hours',
  'Pause Duration while In Progress (min)', 'Total Actual Break (hours)',
];

const minTime = (left, right) => (!left || (right && right < left) ? right : left);
const maxTime = (left, right) => (!left || (right && right > left) ? right : left);
const decimal = (value) => new Decimal(value || 0);
// Division of source minutes by 60 can create repeating decimals. MongoDB
// Decimal128 accepts at most 34 significant digits, so calculated hour values
// are normalized at a precision far beyond what payroll rounding consumes.
const calculatedHours = (value) => decimal(value).toDecimalPlaces(12, Decimal.ROUND_HALF_UP).toString();

export async function parseDivision3DutyFile(buffer, fileName, service) {
  if (!['ADA', 'GOLINK'].includes(service)) throw new Division3FileValidationError('Choose ADA or GoLink duty data.', { code: 'INVALID_KIND' });
  const source = table(buffer, fileName, DUTY_COLUMNS);
  const errors = [];
  const grouped = new Map();
  let sourceRowCount = 0;
  let excludedRowCount = 0;

  for (const record of source.records) {
    const provider = String(record.get('Provider') ?? '').trim().toLowerCase();
    const status = String(record.get('Duty Status') ?? '').trim().toLowerCase();
    const firstSeen = isoTime(record.get('First Seen In Service Area Time'));
    if (provider !== 'big star' || status !== 'completed' || !firstSeen) {
      excludedRowCount += 1;
      continue;
    }
    sourceRowCount += 1;
    const driverName = String(record.get('Driver Name') ?? '').trim().replace(/\s+/g, ' ');
    const lastSeen = isoTime(record.get('Last Seen In Service Area Time'));
    const scheduledStart = isoTime(record.get('Duty Scheduled Start Time'));
    const scheduledEnd = isoTime(record.get('Duty Scheduled End Time'));
    const date = isoDate(record.get('Duty Actual Started Time') ?? record.get('First Seen In Service Area Time')) || isoDate(firstSeen);
    const numericNames = [
      'Total Duty Duration (hours)', 'Total Scheduled Duty Duration (hours)', 'Total Revenue Hours',
      'Pause Duration while In Progress (min)', 'Total Actual Break (hours)',
    ];
    const values = Object.fromEntries(numericNames.map((name) => [name, exactNumber(record.get(name), { blankAsZero: true })]));
    if (!driverName || !date || !lastSeen || Object.values(values).some((value) => value === null)) {
      errors.push(`Row ${record.rowNumber}: expected a driver, valid service timestamps, and numeric duty-hour values.`);
      continue;
    }
    const key = `${division3DriverKey(driverName)}|${date}`;
    const current = grouped.get(key) || {
      service, date, driverName, dutyCount: 0, paidHours: new Decimal(0), attainmentHours: new Decimal(0),
      revenueHours: new Decimal(0), pauseHours: new Decimal(0), breakHours: new Decimal(0),
      scheduledStart: null, scheduledEnd: null, firstSeen: null, lastSeen: null,
    };
    const revenue = decimal(values['Total Revenue Hours']);
    const pause = decimal(values['Pause Duration while In Progress (min)']).div(60);
    const actualBreak = decimal(values['Total Actual Break (hours)']);
    const elapsed = new Decimal(Math.max(0, (new Date(lastSeen) - new Date(firstSeen)) / 3600000));
    const adaCore = Decimal.min(decimal(values['Total Duty Duration (hours)']), decimal(values['Total Scheduled Duty Duration (hours)'])).minus(actualBreak);
    const goLinkCore = elapsed.minus(pause).minus(actualBreak);
    const core = Decimal.max(0, service === 'ADA' ? adaCore : goLinkCore);
    current.dutyCount += 1;
    current.revenueHours = current.revenueHours.plus(revenue);
    current.paidHours = current.paidHours.plus(service === 'ADA' ? revenue : core);
    current.attainmentHours = current.attainmentHours.plus(core);
    current.pauseHours = current.pauseHours.plus(pause);
    current.breakHours = current.breakHours.plus(actualBreak);
    current.scheduledStart = minTime(current.scheduledStart, scheduledStart);
    current.scheduledEnd = maxTime(current.scheduledEnd, scheduledEnd);
    current.firstSeen = minTime(current.firstSeen, firstSeen);
    current.lastSeen = maxTime(current.lastSeen, lastSeen);
    grouped.set(key, current);
  }
  if (errors.length) {
    throw new Division3FileValidationError(`Division 3 ${service} duty validation failed. ${errors.slice(0, 20).join(' ')}`, {
      code: 'MALFORMED_ROWS', errors, detectedColumns: source.headers.filter(Boolean), sheetName: source.sheetName,
    });
  }
  const rows = [...grouped.values()].map((row) => ({
    ...row,
    paidHours: calculatedHours(row.paidHours),
    attainmentHours: calculatedHours(row.attainmentHours),
    revenueHours: calculatedHours(row.revenueHours),
    pauseHours: calculatedHours(row.pauseHours),
    breakHours: calculatedHours(row.breakHours),
    lateStart: Boolean(row.scheduledStart && row.firstSeen && row.firstSeen > row.scheduledStart),
    earlyEnd: Boolean(row.scheduledEnd && row.lastSeen && row.lastSeen < row.scheduledEnd),
  })).sort((a, b) => a.date.localeCompare(b.date) || a.driverName.localeCompare(b.driverName));
  if (!rows.length) throw new Division3FileValidationError(`No completed Big Star ${service} duty rows were found.`, { code: 'NO_DATA_ROWS', detectedColumns: source.headers.filter(Boolean) });
  return {
    rows,
    rowCount: rows.length,
    sourceRowCount,
    excludedRowCount,
    sheetName: source.sheetName,
    detectedColumns: source.headers.filter(Boolean),
    datesDetected: [...new Set(rows.map((row) => row.date))].sort(),
    driversDetected: new Set(rows.map((row) => division3DriverKey(row.driverName))).size,
  };
}

const FARE_COLUMNS = ['Trip Status', 'Pickup Arrived At', 'Driver Name', 'Provider', 'Number of Riders (Adult)'];

export async function parseDivision3FareFile(buffer, fileName) {
  const source = table(buffer, fileName, FARE_COLUMNS);
  const grouped = new Map();
  const errors = [];
  let sourceRowCount = 0;
  let excludedRowCount = 0;
  for (const record of source.records) {
    if (String(record.get('Provider') ?? '').trim().toLowerCase() !== 'big star'
      || String(record.get('Trip Status') ?? '').trim().toLowerCase() !== 'completed') {
      excludedRowCount += 1;
      continue;
    }
    sourceRowCount += 1;
    const driverName = String(record.get('Driver Name') ?? '').trim().replace(/\s+/g, ' ');
    const date = isoDate(record.get('Pickup Arrived At'));
    const riders = exactNumber(record.get('Number of Riders (Adult)'), { blankAsZero: true });
    if (!driverName || !date || riders === null) {
      errors.push(`Row ${record.rowNumber}: expected Driver Name, Pickup Arrived At, and a numeric Number of Riders (Adult).`);
      continue;
    }
    const key = `${division3DriverKey(driverName)}|${date}`;
    const current = grouped.get(key) || { date, driverName, tripCount: 0, adultRiders: new Decimal(0), fareCost: new Decimal(0) };
    current.tripCount += 1;
    current.adultRiders = current.adultRiders.plus(riders);
    current.fareCost = current.fareCost.plus(decimal(riders).times(DIV3_ADA_FARE_RATE));
    grouped.set(key, current);
  }
  if (errors.length) throw new Division3FileValidationError(`Division 3 ADA fare validation failed. ${errors.slice(0, 20).join(' ')}`, { code: 'MALFORMED_ROWS', errors, detectedColumns: source.headers.filter(Boolean) });
  const rows = [...grouped.values()].map((row) => ({ ...row, adultRiders: row.adultRiders.toString(), fareCost: row.fareCost.toFixed(2) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.driverName.localeCompare(b.driverName));
  if (!rows.length) throw new Division3FileValidationError('No completed Big Star ADA fare rows were found.', { code: 'NO_DATA_ROWS', detectedColumns: source.headers.filter(Boolean) });
  return {
    rows, rowCount: rows.length, sourceRowCount, excludedRowCount,
    sheetName: source.sheetName, detectedColumns: source.headers.filter(Boolean),
    datesDetected: [...new Set(rows.map((row) => row.date))].sort(),
    driversDetected: new Set(rows.map((row) => division3DriverKey(row.driverName))).size,
    fareRate: DIV3_ADA_FARE_RATE,
  };
}

const RETURNED_REQUIRED = ['PARTNER NAME', 'DriverName', 'Date', 'Fare To Collect'];
const RETURNED_ALIASES = { DriverName: ['Driver Name'], 'PARTNER NAME': ['Partner Name'] };
const RETURNED_OPTIONAL = ['1029', '# Orange Coupon', '# Green Coupon', '$ Orange Coupon', '$ Green Coupon', '$ Stripe', '$ Wallet', 'Cash to be Deducted'];

export async function parseDivision3ReturnedFareFile(buffer, fileName) {
  const source = table(buffer, fileName, RETURNED_REQUIRED, RETURNED_ALIASES);
  const has = Object.fromEntries(RETURNED_OPTIONAL.map((name) => [name, source.records[0]?.has(name) || false]));
  const schemaComplete = has['1029'] && (has['$ Orange Coupon'] || has['# Orange Coupon'])
    && (has['$ Green Coupon'] || has['# Green Coupon']) && has['$ Stripe'] && has['$ Wallet'];
  const rows = [];
  const errors = [];
  for (const record of source.records) {
    const partnerName = String(record.get('PARTNER NAME') ?? '').trim().replace(/\s+/g, ' ');
    const driverName = String(record.get('DriverName') ?? '').trim().replace(/\s+/g, ' ');
    const date = isoDate(record.get('Date'));
    const fareToCollect = exactNumber(record.get('Fare To Collect'));
    if (!partnerName || !driverName || !date || fareToCollect === null) {
      errors.push(`Row ${record.rowNumber}: expected PARTNER NAME, DriverName, Date, and numeric Fare To Collect.`);
      continue;
    }
    const amount = (name) => (has[name] ? exactNumber(record.get(name), { blankAsZero: true }) : '0');
    const values = Object.fromEntries(RETURNED_OPTIONAL.map((name) => [name, amount(name)]));
    if (Object.values(values).some((value) => value === null)) {
      errors.push(`Row ${record.rowNumber}: an NSM reconciliation amount is not numeric.`);
      continue;
    }
    const orangeCoupon = has['$ Orange Coupon'] ? decimal(values['$ Orange Coupon']) : decimal(values['# Orange Coupon']).times(3);
    const greenCoupon = has['$ Green Coupon'] ? decimal(values['$ Green Coupon']) : decimal(values['# Green Coupon']).times('3.50');
    const deductions = decimal(values['1029']).plus(orangeCoupon).plus(greenCoupon).plus(values['$ Stripe']).plus(values['$ Wallet']);
    rows.push({
      partnerName, driverName, date, fareToCollect,
      route1029: values['1029'],
      orangeCouponCount: values['# Orange Coupon'], greenCouponCount: values['# Green Coupon'],
      orangeCoupon: orangeCoupon.toFixed(2), greenCoupon: greenCoupon.toFixed(2),
      stripe: values['$ Stripe'], wallet: values['$ Wallet'],
      cashToDeduct: decimal(fareToCollect).minus(deductions).toFixed(2),
      schemaComplete,
    });
  }
  if (errors.length) throw new Division3FileValidationError(`Division 3 returned-fare validation failed. ${errors.slice(0, 20).join(' ')}`, { code: 'MALFORMED_ROWS', errors, detectedColumns: source.headers.filter(Boolean) });
  if (!rows.length) throw new Division3FileValidationError('The returned-fare file has no reconciliation rows.', { code: 'NO_DATA_ROWS', detectedColumns: source.headers.filter(Boolean) });
  return {
    rows, rowCount: rows.length, sourceRowCount: rows.length, excludedRowCount: 0,
    sheetName: source.sheetName, detectedColumns: source.headers.filter(Boolean), schemaComplete,
    datesDetected: [...new Set(rows.map((row) => row.date))].sort(),
    driversDetected: new Set(rows.map((row) => division3DriverKey(row.driverName))).size,
    warnings: schemaComplete ? [] : ['The four-column Accounting file was accepted. NSM reconciliation amounts are still pending.'],
  };
}

export function reconcileDivision3Fares(fareRows, returnedRows) {
  const returns = new Map((returnedRows || []).map((row) => [`${division3DriverKey(row.driverName)}|${row.date}`, row]));
  // The source workbook combines weekly files before grouping. Group again
  // here so a trip that crosses midnight at a file boundary is neither lost
  // nor reconciled twice.
  const grouped = new Map();
  for (const fare of fareRows || []) {
    const key = `${division3DriverKey(fare.driverName)}|${fare.date}`;
    const plainFare = fare.toObject?.() || fare;
    const current = grouped.get(key) || { ...plainFare, tripCount: 0, adultRiders: '0', fareCost: '0' };
    current.tripCount += Number(fare.tripCount || 0);
    current.adultRiders = decimal(current.adultRiders).plus(fare.adultRiders || 0).toString();
    current.fareCost = decimal(current.fareCost).plus(fare.fareCost || 0).toFixed(2);
    grouped.set(key, current);
  }
  const rows = [...grouped.values()].map((fare) => {
    const returned = returns.get(`${division3DriverKey(fare.driverName)}|${fare.date}`);
    if (!returned) return { ...fare, status: 'PENDING_NSM', fareToCollect: null, cashToDeduct: fare.fareCost };
    const fareMatches = decimal(fare.fareCost).eq(returned.fareToCollect);
    const status = !fareMatches ? 'FARE_MISMATCH' : returned.schemaComplete ? 'RECONCILED' : 'PENDING_NSM';
    const offsets = decimal(returned.route1029).plus(returned.orangeCoupon).plus(returned.greenCoupon).plus(returned.stripe).plus(returned.wallet);
    return { ...fare, partnerName: returned.partnerName, status, fareToCollect: returned.fareToCollect, cashToDeduct: decimal(fare.fareCost).minus(offsets).toFixed(2) };
  });
  return {
    rows,
    totals: {
      fareCost: rows.reduce((total, row) => total.plus(row.fareCost), new Decimal(0)).toFixed(2),
      cashToDeduct: rows.reduce((total, row) => total.plus(row.cashToDeduct), new Decimal(0)).toFixed(2),
    },
    pendingCount: rows.filter((row) => row.status === 'PENDING_NSM').length,
    mismatchCount: rows.filter((row) => row.status === 'FARE_MISMATCH').length,
    reconciledCount: rows.filter((row) => row.status === 'RECONCILED').length,
  };
}
