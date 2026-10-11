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

test('a matching division source workbook is accepted and dated', () => {
  const file = workbookBuffer([
    ['Trip Type', 'Date', 'Trip ID', 'Employee Name', 'Trip Miles', 'Trip Time Minutes'],
    ['ADA', new Date('2026-09-07T00:00:00Z'), 'T-1', 'Driver One', 12, 45],
  ]);
  const parsed = parseDivisionSourceFile(file, 'BIGSTAR.EXPORT.0907202609132026.xlsx', '5', 'DIV5_BIG_EXPORT');
  assert.deepEqual(parsed.datesDetected, ['2026-09-07']);
  assert.equal(parsed.datasetType, 'DIV5_BIG_EXPORT');
});

test('a valid spreadsheet in the wrong dataset slot is rejected by schema', () => {
  const file = workbookBuffer([
    ['Trip Type', 'Date', 'Trip ID', 'Employee Name', 'Trip Miles', 'Trip Time Minutes'],
    ['ADA', '2026-09-07', 'T-1', 'Driver One', 12, 45],
  ]);
  assert.throws(
    () => parseDivisionSourceFile(file, 'wrong-slot.xlsx', '5', 'DIV5_RPR'),
    (error) => error instanceof DivisionSourceValidationError && error.details.code === 'WRONG_DATASET_SCHEMA',
  );
});

test('daily manifest dates can be identified from an underscore filename', () => {
  const csv = Buffer.from('EVSTRNAME,STATUS,SPACE,Client Name,LOCATION,LASTNAME,FIRSTNAME,VEH\nR1,C,AMB,Client,Pickup,Driver,One,100\n');
  const parsed = parseDivisionSourceFile(csv, 'MANIFESTEXPORT_8-24-2026.csv', '10', 'DIV10_MANIFESTS');
  assert.deepEqual(parsed.datesDetected, ['2026-08-24']);
});

test('each source slot enforces its configured file extension', () => {
  const file = workbookBuffer([['EVSTRNAME', 'STATUS', 'SPACE', 'Client Name', 'LOCATION', 'LASTNAME', 'FIRSTNAME', 'VEH']]);
  assert.throws(
    () => parseDivisionSourceFile(file, 'MANIFESTEXPORT_8-24-2026.xlsx', '10', 'DIV10_MANIFESTS'),
    (error) => error instanceof DivisionSourceValidationError && error.details.code === 'UNSUPPORTED_FILE_TYPE',
  );
});

