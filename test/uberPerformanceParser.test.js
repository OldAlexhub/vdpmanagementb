import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import XLSX from 'xlsx';
import { parseUberPerformanceFile, REQUIRED_UBER_COLUMNS, OPTIONAL_UBER_COLUMNS, UberFileValidationError } from '../src/services/uberPerformanceParser.js';

const fixtures = [
  '../artifacts/9.07.26 - 9.14.26.xlsx',
  '../artifacts/9.14.26 - 9.21.26.xlsx',
];

const validRow = () => ({
  Week: '2026-09-07', Driver_UUID: 'driver-1',
  'Total Supply Hours': 52.86, 'Paused Hours': 0.46, 'Core Hours_Total Supply Hours': 36.58,
  'Utilized Hours': 45.6, Total_Accepts: 110, Total_Rejects: 0, Total_Expired_Offers: 0,
  Total_Cancels: 5, Driver_Earnings_Excl_Tips: 1121, Driver_Tips: 57, First_Name: 'MARY', Last_Name: 'WITT',
});

const bufferFor = (rows, bookType = 'xlsx') => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Uber');
  return XLSX.write(workbook, { type: 'buffer', bookType });
};

describe('Uber performance parser', () => {
  test('retains required WITT source values without duplicating profile identity data', async () => {
    const source = await fs.readFile(fixtures[0]);
    const workbook = XLSX.read(source, { type: 'buffer', cellDates: true });
    const records = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { raw: true });
    const sourceWitt = records.find((row) => row.Last_Name === 'WITT');
    const parsed = await parseUberPerformanceFile(bufferFor([sourceWitt]), 'witt.xlsx');
    const [witt] = parsed.rows;
    assert.equal(witt.totalSupplyHours, '52.86');
    assert.equal(witt.pausedHours, '0.46');
    assert.equal(witt.driverTips, '57');
    assert.equal(witt.driverUuid, '68f0b1e8-da78-4d64-b477-0f1b68333483');
    assert.equal(witt.sourceFirstName, 'MARY');
    assert.equal(witt.sourceLastName, 'WITT');
    assert.equal(witt.identity, undefined);
  });

  test('imports Uber \\N numeric sentinels as exact zero with an audit warning', async () => {
    const [first, second] = await Promise.all(fixtures.map((fixture) => fs.readFile(fixture).then((buffer) => parseUberPerformanceFile(buffer, fixture))));
    assert.equal(first.rowCount, 69);
    assert.equal(second.rowCount, 68);
    assert.equal(first.warnings.length, 3);
    assert.equal(second.warnings.length, 2);

    const noActivity = first.rows.find((row) => row.driverUuid === '31514071-2415-4227-8dc0-206180ac1a94');
    assert.deepEqual(
      [noActivity.totalAccepts, noActivity.totalRejects, noActivity.totalExpiredOffers, noActivity.totalCancels, noActivity.driverEarningsExclTips, noActivity.driverTips],
      ['0', '0', '0', '0', '0', '0'],
    );
    assert.deepEqual(noActivity.sourceZeroFields, [
      'Total_Accepts', 'Total_Rejects', 'Total_Expired_Offers', 'Total_Cancels', 'Driver_Earnings_Excl_Tips', 'Driver_Tips',
    ]);
    const noCore = second.rows.find((row) => row.driverUuid === 'eab6aa54-34aa-493e-8561-a8d13a6d83c3');
    assert.equal(noCore.coreHoursTotalSupplyHours, '0');
    assert.deepEqual(noCore.sourceZeroFields, ['Core Hours_Total Supply Hours']);
  });

  test('reports every missing required column', async () => {
    const row = validRow();
    delete row['Paused Hours'];
    delete row.Total_Cancels;
    await assert.rejects(
      () => parseUberPerformanceFile(bufferFor([row]), 'missing.xlsx'),
      (error) => error instanceof UberFileValidationError
        && error.details.code === 'MISSING_COLUMNS'
        && error.details.missingColumns.includes('Paused Hours')
        && error.details.missingColumns.includes('Total_Cancels'),
    );
  });

  test('rejects malformed numeric cells with row and column detail', async () => {
    const row = validRow();
    row['Utilized Hours'] = 'not-a-number';
    await assert.rejects(
      () => parseUberPerformanceFile(bufferFor([row]), 'bad.xlsx'),
      (error) => error instanceof UberFileValidationError
        && error.details.code === 'MALFORMED_ROWS'
        && error.details.errors.some((message) => message.includes('Row 2, Utilized Hours')),
    );
  });

  test('accepts a missing Utilized Hours column so plan eligibility can be decided by the engine', async () => {
    const row = validRow();
    delete row['Utilized Hours'];
    const parsed = await parseUberPerformanceFile(bufferFor([row]), 'no-utilization.xlsx');
    assert.equal(parsed.rows[0].utilizedHours, null);
  });

  test('accepts legacy .xls and .csv files', async () => {
    const xls = await parseUberPerformanceFile(bufferFor([validRow()], 'biff8'), 'weekly.xls');
    const csvSheet = XLSX.utils.json_to_sheet([validRow()]);
    const csv = Buffer.from(XLSX.utils.sheet_to_csv(csvSheet));
    const parsedCsv = await parseUberPerformanceFile(csv, 'weekly.csv');
    assert.equal(xls.rowCount, 1);
    assert.equal(parsedCsv.rowCount, 1);
  });

  test('required and optional column contracts stay explicit', () => {
    assert.equal(REQUIRED_UBER_COLUMNS.length, 11);
    assert.deepEqual(OPTIONAL_UBER_COLUMNS, ['Utilized Hours']);
  });
});
