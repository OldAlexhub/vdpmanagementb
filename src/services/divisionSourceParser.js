import path from 'node:path';
import XLSX from 'xlsx';
import { definitionForDataset } from './divisionSourceDefinitions.js';
import { D } from './money.js';

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
    workbook = typeof buffer === 'string'
      ? XLSX.readFile(buffer, { cellDates: true, raw: true })
      : XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: true });
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

const columnMap = (row) => new Map(row.map((value, index) => [headerKey(value), index]));
const cell = (row, columns, name) => row[columns.get(headerKey(name))];
const text = (value) => String(value ?? '').trim();
const number = (value) => {
  const cleaned = text(value).replace(/[,$\s]/g, '');
  return cleaned && /^-?\d*\.?\d+$/.test(cleaned) ? D(cleaned) : D(0);
};

function clockMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text(value));
  if (!match || Number(match[2]) > 59) return null;
  return (Number(match[1]) * 60) + Number(match[2]);
}

function elapsedMinutes(start, end) {
  if (start === null || end === null) return 0;
  let adjusted = end;
  while (adjusted < start) adjusted += 24 * 60;
  return Math.max(0, adjusted - start);
}

function manifestRows(sheet, datesDetected) {
  const headerIndex = sheet.rows.findIndex((row) => row.map(headerKey).includes('evstrname'));
  if (headerIndex < 0 || datesDetected.length !== 1) return [];
  const columns = columnMap(sheet.rows[headerIndex]);
  const date = datesDetected[0];
  const grouped = new Map();
  for (const row of sheet.rows.slice(headerIndex + 1)) {
    const route = text(cell(row, columns, 'EVSTRNAME'));
    if (!route) continue;
    const key = `${date}|${route}`;
    const item = grouped.get(key) || {
      date, route, operatorName: '', starts: [], ends: [], lunches: [],
    };
    const firstName = text(cell(row, columns, 'FIRSTNAME'));
    const lastName = text(cell(row, columns, 'LASTNAME'));
    item.operatorName ||= [firstName, lastName].filter(Boolean).join(' ');
    const action = headerKey(cell(row, columns, 'ACT'));
    const arrived = clockMinutes(cell(row, columns, 'Arrived*'));
    const departed = clockMinutes(cell(row, columns, 'Departed*'));
    if (action === 'l') item.lunches.push(elapsedMinutes(arrived, departed));
    // EVSTRNAME identifies the run. Each manifest file identifies one service
    // date, and the first/last Arrived* values are the actual service span.
    // Departed* and scheduled times must not extend TUI attainment.
    if (arrived !== null) {
      item.starts.push(arrived);
      item.ends.push(arrived);
    }
    grouped.set(key, item);
  }
  return [...grouped.values()].flatMap((item) => {
    const starts = item.starts.filter((value) => value !== null);
    const ends = item.ends.filter((value) => value !== null);
    if (!starts.length || !ends.length) return [];
    const actualStartMinutes = starts[0];
    let actualEndMinutes = ends[ends.length - 1];
    while (actualEndMinutes < actualStartMinutes) actualEndMinutes += 24 * 60;
    return [{
      date: item.date,
      route: item.route,
      operatorName: item.operatorName,
      actualStartMinutes,
      actualEndMinutes,
      actualHours: D(actualEndMinutes - actualStartMinutes).div(60).toDecimalPlaces(12).toString(),
      lunchHours: D(item.lunches.reduce((total, value) => total + value, 0)).div(60).toDecimalPlaces(12).toString(),
    }];
  });
}

function fareRows(sheet, cycle) {
  const headerIndex = sheet.rows.findIndex((row) => row.map(headerKey).includes('booking id'));
  if (headerIndex < 0) return [];
  const columns = columnMap(sheet.rows[headerIndex]);
  const grouped = new Map();
  for (const row of sheet.rows.slice(headerIndex + 1)) {
    if (headerKey(cell(row, columns, 'Trip Status')) !== 'performed') continue;
    if (headerKey(cell(row, columns, 'Fare Type')) !== 'cash') continue;
    const date = dateValue(cell(row, columns, 'Ride Date'), defaultYearFor(cycle));
    const route = text(cell(row, columns, 'Route'));
    if (!date || !route) continue;
    const operatorName = text(cell(row, columns, 'Operator Name'));
    const key = `${date}|${route}|${operatorName}`;
    const current = grouped.get(key) || { date, route, operatorName, cashFares: D(0) };
    const passengerUnits = number(cell(row, columns, 'PU'));
    current.cashFares = current.cashFares.plus(passengerUnits.gt(0) ? passengerUnits.times('2.80') : D('2.80'));
    grouped.set(key, current);
  }
  return [...grouped.values()].map((row) => ({ ...row, cashFares: row.cashFares.toString() }));
}

function fuelRows(sheet, cycle) {
  const headerIndex = sheet.rows.findIndex((row) => row.map(headerKey).includes('fuel grade'));
  if (headerIndex < 0) return [];
  const columns = columnMap(sheet.rows[headerIndex]);
  const grouped = new Map();
  for (const row of sheet.rows.slice(headerIndex + 1)) {
    const date = dateValue(cell(row, columns, 'Date'), defaultYearFor(cycle));
    const operatorName = text(cell(row, columns, 'User'));
    if (!date || !operatorName || headerKey(cell(row, columns, 'Status')) === 'declined') continue;
    const key = `${date}|${operatorName}`;
    const current = grouped.get(key) || { date, operatorName, amount: D(0) };
    current.amount = current.amount.plus(number(cell(row, columns, 'Amount')));
    grouped.set(key, current);
  }
  return [...grouped.values()].map((row) => ({ ...row, amount: row.amount.toString() }));
}

function lakesideFuelRows(sheet, cycle) {
  const { columns, rows } = headerAndRows(sheet, 'Driver ID');
  const grouped = new Map();
  for (const row of rows) {
    const date = dateValue(cell(row, columns, 'Date'), defaultYearFor(cycle));
    const operatorName = text(cell(row, columns, 'Driver ID'));
    if (!date || !operatorName) continue;
    const key = `${date}|${operatorName}`;
    const current = grouped.get(key) || { date, operatorName, amount: D(0) };
    current.amount = current.amount.plus(number(cell(row, columns, 'Cost ($)')));
    grouped.set(key, current);
  }
  return [...grouped.values()].map((row) => ({ ...row, amount: row.amount.toString() }));
}

function div10TrapezeRows(sheet, cycle) {
  const from = cycle ? new Date(cycle.cycleStart).toISOString().slice(0, 10) : null;
  const to = cycle ? new Date(cycle.cycleEnd).toISOString().slice(0, 10) : null;
  let currentDate = null;
  const rows = [];
  for (const sourceRow of sheet.rows) {
    const possibleDate = dateValue(sourceRow[0], defaultYearFor(cycle));
    if (possibleDate) {
      currentDate = possibleDate;
      continue;
    }
    const route = text(sourceRow[0]);
    if (!currentDate || !/^\d+[A-Za-z]?$/.test(route) || route === 'N/A') continue;
    if ((from && currentDate < from) || (to && currentDate > to)) continue;
    // This Trapeze productivity pivot has two unlabeled row dimensions before
    // its visible subheaders. The finalized workbook maps H=performed trips,
    // L=total hours, Q=lunch, and T=total service miles.
    const totalHours = number(sourceRow[11]);
    const lunch = number(sourceRow[16]);
    rows.push({
      date: currentDate,
      route,
      trips: number(sourceRow[7]).toString(),
      totalHours: totalHours.toString(),
      serviceHours: number(sourceRow[12]).toString(),
      revenueHours: DecimalMax(totalHours.minus(lunch), D(0)).toString(),
      serviceMiles: number(sourceRow[19]).toString(),
      otherHours: { 'Trapeze Lunch Hours': lunch.toString() },
    });
  }
  return rows;
}

function headerAndRows(sheet, requiredHeader) {
  const headerIndex = sheet.rows.findIndex((row) => row.map(headerKey).includes(headerKey(requiredHeader)));
  if (headerIndex < 0) return { columns: new Map(), rows: [] };
  return { columns: columnMap(sheet.rows[headerIndex]), rows: sheet.rows.slice(headerIndex + 1) };
}

function compactDate(value, cycle) {
  const raw = text(value);
  const match = /^(20\d{2})(\d{2})(\d{2})$/.exec(raw);
  return match ? iso(match[1], match[2], match[3]) : dateValue(value, defaultYearFor(cycle));
}

function clockFromTimestamp(value) {
  const raw = text(value);
  const match = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i.exec(raw);
  if (!match) return null;
  let hour = Number(match[1]);
  const suffix = String(match[3] || '').toUpperCase();
  if (suffix === 'PM' && hour < 12) hour += 12;
  if (suffix === 'AM' && hour === 12) hour = 0;
  return hour * 60 + Number(match[2]);
}

function div5RprRows(sheet, cycle) {
  return div10TrapezeRows(sheet, cycle);
}

function div6TrapezeRows(sheet, cycle) {
  const { columns, rows } = headerAndRows(sheet, 'ldate');
  const grouped = new Map();
  for (const row of rows) {
    const date = compactDate(cell(row, columns, 'ldate'), cycle);
    const route = text(cell(row, columns, 'evstrname'));
    if (!date || !route) continue;
    const key = `${date}|${route}`;
    const current = grouped.get(key) || { date, route, trips: D(0), serviceMiles: D(0) };
    current.trips = current.trips.plus(1);
    current.serviceMiles = current.serviceMiles.plus(number(cell(row, columns, 'Direct_Distance')));
    grouped.set(key, current);
  }
  return [...grouped.values()].map((row) => ({
    date: row.date, route: row.route, trips: row.trips.toString(),
    totalHours: null, serviceHours: null, revenueHours: null,
    serviceMiles: row.serviceMiles.toString(), otherHours: {},
  }));
}

function div7ProductivityRows(sheet, cycle) {
  let currentDate = null;
  let pending = null;
  const rows = [];
  for (const row of sheet.rows) {
    const possibleDate = dateValue(row[1], defaultYearFor(cycle));
    if (possibleDate && !text(row[1]).includes(',')) { currentDate = possibleDate; pending = null; continue; }
    const label = text(row[1]);
    if (currentDate && label && /^BST\w+/i.test(label)) {
      pending = { date: currentDate, route: label.split(',')[0].trim(), trips: number(row[6]).toString() };
      continue;
    }
    if (pending && headerKey(row[7]) === 'act') {
      rows.push({
        ...pending,
        totalHours: number(row[10]).toString(),
        serviceHours: number(row[10]).toString(),
        revenueHours: number(row[15]).toString(),
        serviceMiles: number(row[13]).toString(),
        otherHours: {},
      });
      pending = null;
    }
  }
  return rows;
}

function div7DriverWindows(sheet, cycle) {
  const { columns, rows } = headerAndRows(sheet, 'Driver Name');
  return rows.flatMap((row) => {
    const date = dateValue(cell(row, columns, 'Date'), defaultYearFor(cycle));
    const route = text(cell(row, columns, 'Run'));
    const start = clockFromTimestamp(cell(row, columns, 'Pull out act'));
    let end = clockFromTimestamp(cell(row, columns, 'Pull in act'));
    if (!date || !route || start === null || end === null) return [];
    if (end <= start) end += 24 * 60;
    return [{ date, route, operatorName: text(cell(row, columns, 'Driver Name')), actualStartMinutes: start, actualEndMinutes: end, actualHours: D(end - start).div(60).toString(), lunchHours: number(cell(row, columns, 'Scheduled breaks act')).toString() }];
  });
}

function div8DutyRows(sheet, cycle) {
  const { columns, rows } = headerAndRows(sheet, 'Duty ID');
  const performance = [];
  const windows = [];
  for (const row of rows) {
    const started = cell(row, columns, 'Duty Actual Started Time');
    const date = dateValue(started, defaultYearFor(cycle));
    const route = text(cell(row, columns, 'Duty Identifier'));
    if (!date || !route) continue;
    performance.push({
      date, route, trips: number(cell(row, columns, 'Total Boardings')).toString(),
      totalHours: number(cell(row, columns, 'Total Duty Duration (hours)')).toString(),
      serviceHours: number(cell(row, columns, 'Total Time Without Passengers (hours)')).plus(number(cell(row, columns, 'Total Revenue Hours'))).toString(),
      revenueHours: number(cell(row, columns, 'Total Revenue Hours')).toString(),
      serviceMiles: number(cell(row, columns, 'Total Travel Distance (Mi)')).toString(), otherHours: {},
    });
    const start = clockFromTimestamp(started);
    let end = clockFromTimestamp(cell(row, columns, 'Duty Actual Completed Time'));
    if (end === null) end = clockFromTimestamp(cell(row, columns, 'Last Seen In Service Area Time'));
    if (start !== null && end !== null) {
      if (end <= start) end += 24 * 60;
      windows.push({ date, route, operatorName: text(cell(row, columns, 'Driver Name')), actualStartMinutes: start, actualEndMinutes: end, actualHours: D(end - start).div(60).toString(), lunchHours: number(cell(row, columns, 'Total Actual Break (hours)')).toString() });
    }
  }
  return { performance, windows };
}

function div11ShiftRows(sheet, cycle) {
  const { columns, rows } = headerAndRows(sheet, 'Shift ID');
  const performance = [];
  const windows = [];
  let carriedDate = null;
  let carriedDriver = null;
  for (const row of rows) {
    carriedDate = dateValue(cell(row, columns, 'Date'), defaultYearFor(cycle)) || carriedDate;
    carriedDriver = text(cell(row, columns, 'Driver')) || text(cell(row, columns, 'Full Name')) || carriedDriver;
    const route = text(cell(row, columns, 'Shift'));
    if (!carriedDate || !route) continue;
    performance.push({
      date: carriedDate, route, trips: number(cell(row, columns, 'Total Passengers')).toString(),
      totalHours: number(cell(row, columns, 'Total Online Hours')).toString(),
      serviceHours: number(cell(row, columns, 'Vehicle Hours')).toString(),
      revenueHours: number(cell(row, columns, 'Vehicle Revenue Hours')).toString(),
      serviceMiles: number(cell(row, columns, 'Total Vehicle Distance (Miles)')).toString(), otherHours: {},
    });
    const start = clockFromTimestamp(cell(row, columns, 'Actual Shift Start'));
    let end = clockFromTimestamp(cell(row, columns, 'Actual Shift End'));
    if (start !== null && end !== null) {
      if (end <= start) end += 24 * 60;
      windows.push({ date: carriedDate, route, operatorName: carriedDriver, actualStartMinutes: start, actualEndMinutes: end, actualHours: D(end - start).div(60).toString(), lunchHours: number(cell(row, columns, 'Total Break Hours')).toString() });
    }
  }
  return { performance, windows };
}

function fareAdjustmentRows(sheet, cycle, type) {
  const { columns, rows } = headerAndRows(sheet, type === 'DIV5_TICKETS' ? 'Trip Type' : 'PARTNER NAME');
  const grouped = new Map();
  for (const row of rows) {
    const date = dateValue(cell(row, columns, 'Date'), defaultYearFor(cycle));
    const providerName = text(cell(row, columns, 'PARTNER NAME'));
    if (!date || !providerName) continue;
    const amount = type === 'DIV5_TICKETS'
      ? DecimalMax(number(cell(row, columns, 'Fare To Collect')).minus(number(cell(row, columns, 'Ticket Value'))), D(0))
      : number(cell(row, columns, 'Cash to be Deducted'));
    const key = `${date}|${providerName}`;
    const current = grouped.get(key) || { date, providerName, operatorName: text(cell(row, columns, 'DriverName')) || text(cell(row, columns, 'Employee Name')), amount: D(0) };
    current.amount = current.amount.plus(amount);
    grouped.set(key, current);
  }
  return [...grouped.values()].filter((row) => !row.amount.isZero()).map((row) => ({ ...row, type: 'FARES', amount: row.amount.abs().toString(), description: `${type === 'DIV5_TICKETS' ? 'DIV 5 collected-ticket' : 'DIV 6 returned-ticket'} fare reconciliation` }));
}

const DecimalMax = (left, right) => (left.gte(right) ? left : right);

export async function parseDivisionSourceFile(buffer, fileName, divisionNumber, datasetType, { cycle = null } = {}) {
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
  const result = {
    datasetType: definition.id,
    sheetName: sheet.name,
    rowCount: Math.max(0, populatedRows - 1),
    datesDetected,
    dataRange: { from: datesDetected[0], to: datesDetected[datesDetected.length - 1] },
    detectedColumns: [...new Set(sheet.rows.slice(0, 40).flat().filter((value) => typeof value === 'string' && value.trim()).map((value) => String(value).trim()))].slice(0, 120),
  };
  if (String(divisionNumber).trim() === '10') {
    result.adapterVersion = 'DIV10_V2';
    if (datasetType === 'DIV10_TRAPEZE_HOURS') {
      result.rows = div10TrapezeRows(sheet, cycle);
      result.performanceColumns = {
        date: true, route: true, trips: true, TOTAL_HOURS: true,
        SERVICE_HOURS: true, REVENUE_HOURS: true, SERVICE_MILES: true,
        otherHourColumns: ['Trapeze Lunch Hours'],
      };
      result.warnings = [];
    }
    if (datasetType === 'DIV10_MANIFESTS') result.division10ManifestRows = manifestRows(sheet, datesDetected);
    if (datasetType === 'DIV10_JASPER_TRIPS') result.division10FareRows = fareRows(sheet, cycle);
    if (datasetType === 'DIV10_COAST_FUEL') result.division10FuelRows = fuelRows(sheet, cycle);
  }
  const divisionKey = String(divisionNumber).trim().toUpperCase();
  if (['5', '6', '7', '8', '11'].includes(divisionKey)) result.adapterVersion = `DIV${divisionKey}_V1`;
  if (datasetType === 'DIV5_RPR') result.rows = div5RprRows(sheet, cycle);
  if (datasetType === 'DIV5_TICKETS') result.sourceAdjustmentRows = fareAdjustmentRows(sheet, cycle, datasetType);
  if (datasetType === 'DIV6_TRAPEZE') result.rows = div6TrapezeRows(sheet, cycle);
  if (datasetType === 'DIV6_RETURNED_TICKETS') result.sourceAdjustmentRows = fareAdjustmentRows(sheet, cycle, datasetType);
  if (datasetType === 'DIV7_DAILY_PRODUCTIVITY') result.rows = div7ProductivityRows(sheet, cycle);
  if (datasetType === 'DIV7_DRIVER_HOURS') result.division10ManifestRows = div7DriverWindows(sheet, cycle);
  if (datasetType === 'DIV7_COAST_FUEL') result.division10FuelRows = fuelRows(sheet, cycle);
  if (datasetType === 'DIV7_LAKESIDE_FUEL') result.division10FuelRows = lakesideFuelRows(sheet, cycle);
  if (datasetType === 'DIV8_DUTY') {
    const adapted = div8DutyRows(sheet, cycle);
    result.rows = adapted.performance;
    result.division10ManifestRows = adapted.windows;
  }
  if (datasetType === 'DIV11_SHIFT_HOURS') {
    const adapted = div11ShiftRows(sheet, cycle);
    result.rows = adapted.performance;
    result.division10ManifestRows = adapted.windows;
  }
  if (result.rows) {
    result.performanceColumns = {
      date: true, route: true, trips: true,
      TOTAL_HOURS: result.rows.some((row) => row.totalHours !== null),
      SERVICE_HOURS: result.rows.some((row) => row.serviceHours !== null),
      REVENUE_HOURS: result.rows.some((row) => row.revenueHours !== null),
      SERVICE_MILES: result.rows.some((row) => row.serviceMiles !== null),
      otherHourColumns: result.division10ManifestRows?.length ? ['Incentive Hours'] : [],
    };
  }
  return result;
}

