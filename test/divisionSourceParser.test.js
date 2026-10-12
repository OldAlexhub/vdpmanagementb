import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { contractForDivisionNumber, definitionForDataset, publicContractForDivision } from '../src/services/divisionSourceDefinitions.js';
import { DivisionSourceValidationError, parseDivisionSourceFile } from '../src/services/divisionSourceParser.js';

const workbookBuffer = (rows) => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Export');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

test('division source contracts expose only recurring source datasets', () => {
  assert.deepEqual(contractForDivisionNumber('6').map((item) => item.id), ['DIV6_TRAPEZE', 'DIV6_RETURNED_TICKETS']);
  assert.equal(contractForDivisionNumber('13').length, 0);
  assert.equal(definitionForDataset('6', 'DIV5_BIG_EXPORT'), null);
  assert.equal(publicContractForDivision({ divisionNumber: '10' }).targetWorkbook, 'VDP_DIV10 UPDATED TEMPLATE.xlsm');
});

test('a matching division source workbook is accepted and dated', async () => {
  const file = workbookBuffer([
    ['Trip Type', 'Date', 'Trip ID', 'Employee Name', 'Trip Miles', 'Trip Time Minutes'],
    ['ADA', new Date('2026-09-07T00:00:00Z'), 'T-1', 'Driver One', 12, 45],
  ]);
  const parsed = await parseDivisionSourceFile(file, 'BIGSTAR.EXPORT.0907202609132026.xlsx', '5', 'DIV5_BIG_EXPORT');
  assert.deepEqual(parsed.datesDetected, ['2026-09-07']);
  assert.equal(parsed.datasetType, 'DIV5_BIG_EXPORT');
});

test('a valid spreadsheet in the wrong dataset slot is rejected by schema', async () => {
  const file = workbookBuffer([
    ['Trip Type', 'Date', 'Trip ID', 'Employee Name', 'Trip Miles', 'Trip Time Minutes'],
    ['ADA', '2026-09-07', 'T-1', 'Driver One', 12, 45],
  ]);
  await assert.rejects(
    parseDivisionSourceFile(file, 'wrong-slot.xlsx', '5', 'DIV5_RPR'),
    (error) => error instanceof DivisionSourceValidationError && error.details.code === 'WRONG_DATASET_SCHEMA',
  );
});

test('daily manifest dates can be identified from an underscore filename', async () => {
  const csv = Buffer.from('EVSTRNAME,ACT,STATUS,Arrived*,Departed*,LASTNAME,FIRSTNAME,VEH\nR1,Out,PERFORMED,17:00,16:45,Driver,One,100\nR1,P,NO SHOW,18:00,26:00,Driver,One,100\nR1,In,PERFORMED,25:00,25:30,Driver,One,100\n');
  const parsed = await parseDivisionSourceFile(csv, 'MANIFESTEXPORT_8-24-2026.csv', '10', 'DIV10_MANIFESTS');
  assert.deepEqual(parsed.datesDetected, ['2026-08-24']);
  assert.equal(parsed.adapterVersion, 'DIV10_V2');
  assert.deepEqual(parsed.division10ManifestRows, [{
    date: '2026-08-24', route: 'R1', operatorName: 'One Driver',
    actualStartMinutes: 1020, actualEndMinutes: 1500, actualHours: '8', lunchHours: '0',
  }]);
});

test('DIV 10 Trapeze pivots are reduced to route/day calculation rows', async () => {
  const header = Array(20).fill(null);
  ['CLI', 'PCA', 'ESC', 'Trips', 'Service', 'Live', 'DH'].forEach((value, index) => { header[index] = value; });
  const source = Array(20).fill(null);
  source[0] = '901';
  source[7] = 16;
  source[11] = 11.4;
  source[12] = 10.7;
  source[16] = 0.5;
  source[19] = 139.771;
  const parsed = await parseDivisionSourceFile(workbookBuffer([
    header,
    ['2026-08-24'],
    source,
  ]), 'BigStar Productivity Report 08-16 to 08-31.xlsx', '10', 'DIV10_TRAPEZE_HOURS', {
    cycle: { cycleStart: new Date('2026-08-24T00:00:00Z'), cycleEnd: new Date('2026-09-06T00:00:00Z') },
  });
  assert.deepEqual(parsed.rows, [{
    date: '2026-08-24', route: '901', trips: '16', totalHours: '11.4',
    serviceHours: '10.7', revenueHours: '10.9', serviceMiles: '139.771',
    otherHours: { 'Trapeze Lunch Hours': '0.5' },
  }]);
});

test('each source slot enforces its configured file extension', async () => {
  const file = workbookBuffer([['EVSTRNAME', 'ACT', 'STATUS', 'Arrived*', 'Departed*', 'LASTNAME', 'FIRSTNAME', 'VEH']]);
  await assert.rejects(
    parseDivisionSourceFile(file, 'MANIFESTEXPORT_8-24-2026.xlsx', '10', 'DIV10_MANIFESTS'),
    (error) => error instanceof DivisionSourceValidationError && error.details.code === 'UNSUPPORTED_FILE_TYPE',
  );
});

