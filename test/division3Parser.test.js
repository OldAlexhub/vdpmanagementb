import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import XLSX from 'xlsx';
import {
  parseDivision3DutyFile,
  parseDivision3FareFile,
  parseDivision3ReturnedFareFile,
  reconcileDivision3Fares,
} from '../src/services/division3Parser.js';

const workbook = (rows) => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Data');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
};

const duty = (overrides = {}) => ({
  'Driver Name': 'Alex Driver', Provider: 'Big Star', 'Duty ID': 'duty-1',
  'Duty Scheduled Start Time': '2026-09-08 08:00:00', 'Duty Actual Started Time': '2026-09-08 08:05:00',
  'Duty Scheduled End Time': '2026-09-08 17:00:00', 'Duty Status': 'completed',
  'First Seen In Service Area Time': '2026-09-08 08:05:00', 'Last Seen In Service Area Time': '2026-09-08 16:55:00',
  'Total Duty Duration (hours)': 9.1, 'Total Scheduled Duty Duration (hours)': 9,
  'Total Revenue Hours': 7.5, 'Pause Duration while In Progress (min)': 30, 'Total Actual Break (hours)': 0.5,
  ...overrides,
});

describe('Division 3 source parsers', () => {
  test('calculates ADA revenue pay hours and separate fulfillment hours', async () => {
    const parsed = await parseDivision3DutyFile(workbook([duty()]), 'ada.xlsx', 'ADA');
    assert.equal(parsed.rowCount, 1);
    assert.equal(parsed.rows[0].paidHours, '7.5');
    assert.equal(parsed.rows[0].attainmentHours, '8.5');
    assert.equal(parsed.rows[0].date, '2026-09-08');
  });

  test('calculates GoLink service-window hours and violation flags', async () => {
    const parsed = await parseDivision3DutyFile(workbook([duty()]), 'golink.xlsx', 'GOLINK');
    assert.ok(Math.abs(Number(parsed.rows[0].paidHours) - (7 + (5 / 6))) < 1e-12);
    assert.equal(parsed.rows[0].attainmentHours, parsed.rows[0].paidHours);
    assert.equal(parsed.rows[0].lateStart, true);
    assert.equal(parsed.rows[0].earlyEnd, true);
  });

  test('streams a staged GoLink XLSX file to the same driver/day result', async () => {
    const buffer = workbook([duty()]);
    const expected = await parseDivision3DutyFile(buffer, 'golink.xlsx', 'GOLINK');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vdp-golink-test-'));
    const file = path.join(directory, 'golink.xlsx');
    try {
      await fs.writeFile(file, buffer);
      const streamed = await parseDivision3DutyFile(file, 'golink.xlsx', 'GOLINK');
      assert.deepEqual(streamed.rows, expected.rows);
      assert.equal(streamed.sourceRowCount, expected.sourceRowCount);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('normalizes repeating minute conversions for MongoDB Decimal128', async () => {
    const parsed = await parseDivision3DutyFile(workbook([duty({
      'Pause Duration while In Progress (min)': 18.1,
    })]), 'golink.xlsx', 'GOLINK');
    assert.equal(parsed.rows[0].pauseHours, '0.301666666667');
    for (const field of ['paidHours', 'attainmentHours', 'revenueHours', 'pauseHours', 'breakHours']) {
      assert.doesNotThrow(() => mongoose.Types.Decimal128.fromString(parsed.rows[0][field]), field);
    }
  });

  test('groups completed Big Star ADA riders at the template fare rate', async () => {
    const parsed = await parseDivision3FareFile(workbook([
      { 'Trip Status': 'completed', 'Pickup Arrived At': '2026-09-08 09:00:00', 'Driver Name': 'Alex Driver', Provider: 'Big Star', 'Number of Riders (Adult)': 2 },
      { 'Trip Status': 'completed', 'Pickup Arrived At': '2026-09-08 10:00:00', 'Driver Name': 'Alex Driver', Provider: 'Big Star', 'Number of Riders (Adult)': 1 },
      { 'Trip Status': 'cancelled', 'Pickup Arrived At': '2026-09-08 11:00:00', 'Driver Name': 'Alex Driver', Provider: 'Big Star', 'Number of Riders (Adult)': 9 },
    ]), 'fare.xlsx');
    assert.equal(parsed.rowCount, 1);
    assert.equal(parsed.rows[0].adultRiders, '3');
    assert.equal(parsed.rows[0].fareCost, '10.50');
  });

  test('preserves the source local service date for evening fare timestamps', async () => {
    const parsed = await parseDivision3FareFile(workbook([
      { 'Trip Status': 'completed', 'Pickup Arrived At': 'September 7, 2026 9:55:25 PM', 'Driver Name': 'Alex Driver', Provider: 'Big Star', 'Number of Riders (Adult)': 1 },
    ]), 'evening-fare.xlsx');
    assert.equal(parsed.rows[0].date, '2026-09-07');
  });

  test('accepts Accounting four-column returned fares and holds them for NSM', async () => {
    const returned = await parseDivision3ReturnedFareFile(workbook([
      { 'PARTNER NAME': 'Provider LLC', DriverName: 'Alex Driver', Date: '2026-09-08', 'Fare To Collect': 10.5 },
    ]), 'accounting.xlsx');
    assert.equal(returned.schemaComplete, false);
    assert.equal(returned.warnings.length, 1);
    const reconciliation = reconcileDivision3Fares([
      { driverName: 'Alex Driver', date: '2026-09-08', fareCost: '10.50', tripCount: 2, adultRiders: '3' },
    ], returned.rows);
    assert.equal(reconciliation.pendingCount, 1);
    assert.equal(reconciliation.totals.cashToDeduct, '10.50');
  });

  test('uses NSM collection detail and flags fare mismatches', async () => {
    const returned = await parseDivision3ReturnedFareFile(workbook([
      {
        'PARTNER NAME': 'Provider LLC', DriverName: 'Alex Driver', Date: '2026-09-08', 'Fare To Collect': 14,
        1029: 3.5, '# Orange Coupon': 1, '# Green Coupon': 1, '$ Stripe': 2, '$ Wallet': 1,
      },
    ]), 'returned.xlsx');
    assert.equal(returned.schemaComplete, true);
    const reconciliation = reconcileDivision3Fares([
      { driverName: 'Alex Driver', date: '2026-09-08', fareCost: '10.50', tripCount: 2, adultRiders: '3' },
    ], returned.rows);
    assert.equal(reconciliation.mismatchCount, 1);
    assert.equal(reconciliation.totals.cashToDeduct, '-2.50');
  });

  test('uses the template name aliases when joining fares to returned reconciliation', () => {
    const reconciliation = reconcileDivision3Fares([
      { driverName: 'Charles Dewit', date: '2026-09-08', fareCost: '14.00', tripCount: 4, adultRiders: '4' },
    ], [{
      partnerName: 'Provider LLC', driverName: 'CHARLES DEWITT', date: '2026-09-08', fareToCollect: '14',
      route1029: '10.5', orangeCoupon: '0', greenCoupon: '0', stripe: '0', wallet: '0', schemaComplete: true,
    }]);
    assert.equal(reconciliation.reconciledCount, 1);
    assert.equal(reconciliation.totals.cashToDeduct, '3.50');
  });
});
