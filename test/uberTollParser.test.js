import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { parseUberTollFile, UberTollFileValidationError } from '../src/services/uberTollParser.js';

const csv = (...rows) => Buffer.from([
  'Driver UUID,Driver first name,Driver last name,Total Earnings,Refunds & Expenses:Refunds:Toll',
  ...rows,
].join('\n'));

const excel = (bookType, ...rows) => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Driver UUID', 'Driver first name', 'Driver last name', 'Total Earnings', 'Refunds & Expenses:Refunds:Toll'],
    ...rows,
  ]), 'Payments');
  return XLSX.write(book, { type: 'buffer', bookType });
};

test('Uber toll parser gets the week from the end-exclusive filename and normalizes blank tolls to zero', async () => {
  const parsed = await parseUberTollFile(csv(
    'driver-a,First,Driver,100.00,2.25',
    'driver-b,Second,Driver,200.00,',
  ), '20260907-20260914-payments_driver-Big_Star_Chicago.csv');
  assert.equal(parsed.week, '2026-09-07');
  assert.equal(parsed.endExclusive, '2026-09-14');
  assert.equal(parsed.tollTotal, '2.25');
  assert.equal(parsed.tollRowCount, 1);
  assert.deepEqual(parsed.rows.map((row) => row.amount), ['2.25', '0.00']);
});

test('Uber toll parser accepts reordered export columns', async () => {
  const source = Buffer.from([
    'Driver last name,Refunds & Expenses:Refunds:Toll,Driver UUID,Driver first name',
    'Driver,4.10,driver-a,First',
  ].join('\n'));
  const parsed = await parseUberTollFile(source, '20260914-20260921-payments_driver-Big_Star_Chicago.csv');
  assert.equal(parsed.week, '2026-09-14');
  assert.equal(parsed.tollTotal, '4.10');
});

test('Uber toll parser accepts modern and legacy Excel files', async () => {
  for (const [bookType, extension] of [['xlsx', 'xlsx'], ['biff8', 'xls']]) {
    const parsed = await parseUberTollFile(
      excel(bookType, ['driver-a', 'First', 'Driver', 100, 2.25], ['driver-b', 'Second', 'Driver', 200, null]),
      `20260907-20260914-payments_driver-Big_Star_Chicago.${extension}`,
    );
    assert.equal(parsed.week, '2026-09-07');
    assert.equal(parsed.rowCount, 2);
    assert.equal(parsed.tollTotal, '2.25');
    assert.deepEqual(parsed.rows.map((row) => row.amount), ['2.25', '0.00']);
  }
});

test('Uber toll parser rejects unsupported file types', async () => {
  await assert.rejects(
    () => parseUberTollFile(Buffer.from('not a spreadsheet'), '20260907-20260914-payments_driver-Test.txt'),
    (error) => error instanceof UberTollFileValidationError && error.details.code === 'UNSUPPORTED_FILE_TYPE',
  );
});

test('Uber toll parser rejects filenames that are not a seven-day payments_driver export', async () => {
  await assert.rejects(
    () => parseUberTollFile(csv('driver-a,First,Driver,100.00,2.25'), 'tolls.csv'),
    (error) => error instanceof UberTollFileValidationError && error.details.code === 'TOLL_PERIOD_NOT_FOUND',
  );
  await assert.rejects(
    () => parseUberTollFile(csv('driver-a,First,Driver,100.00,2.25'), '20260907-20260915-payments_driver-Test.csv'),
    (error) => error instanceof UberTollFileValidationError && error.details.code === 'INVALID_TOLL_PERIOD',
  );
});
