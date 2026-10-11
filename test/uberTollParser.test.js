import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUberTollFile, UberTollFileValidationError } from '../src/services/uberTollParser.js';

const csv = (...rows) => Buffer.from([
  'Driver UUID,Driver first name,Driver last name,Total Earnings,Refunds & Expenses:Refunds:Toll',
  ...rows,
].join('\n'));

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
