// Service mile fuel allowance end to end: service miles stored at import, maximum = miles ÷ MPG,
// one actual-expense input, the overspend as the only fuel deduction, frozen on approval.
// Uses bigstar_vdp_test, dropped at the start of the run.
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../scripts/seed.js';
import Provider from '../src/models/Provider.js';
import PerformanceImport from '../src/models/PerformanceImport.js';
import { D, sum } from '../src/services/money.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(here, 'fixtures', 'performance-report-2026-08-01_to_09-09.xlsx');
const TEST_DB = 'bigstar_vdp_test';
const skip = !process.env.MONGO_URI && 'MONGO_URI not set';
const OPEN_RUNS = ['900', '902', '912', '913', '914', '915', '919', '9015'];
let server;
let base;
let cookie = '';

async function call(method, url, body, form) {
  const headers = { cookie };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}/api${url}`, { method, headers, body: payload });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, data: (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
}

before(async () => {
  if (skip) return;
  assert.ok(TEST_DB.endsWith('_test'));
  await connectDb(TEST_DB);
  assert.equal(mongoose.connection.name, TEST_DB);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  await seed({ log: () => {} });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call('POST', '/auth/setup', { name: 'Ops Admin', email: 'ops@test.local', password: 'correct-horse-1' })).status, 201);
});

after(async () => {
  if (skip) return;
  server?.close();
  await disconnectDb();
});

test('service mile fuel allowance', { skip }, async (t) => {
  const { data: divisions } = await call('GET', '/divisions');
  const div10 = divisions.find((d) => d.divisionNumber === '10');
  let r = await call('POST', '/vdp-plans', {
    divisionId: div10._id,
    name: 'Day Service (fuel allowance)',
    version: { paymentType: 'PER_TRIP', basePay: '21.50', fuelMethod: 'SERVICE_MILE_ALLOWANCE', fuelMpg: '19', effectiveFrom: '2026-08-01' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const plan = r.data;
  assert.equal(plan.versions[0].fuelMethod, 'SERVICE_MILE_ALLOWANCE');
  assert.equal(plan.versions[0].fuelMpg, '19');
  r = await call('POST', '/vdp-plans', { divisionId: div10._id, name: 'No MPG', version: { paymentType: 'PER_TRIP', basePay: '21.50', fuelMethod: 'SERVICE_MILE_ALLOWANCE', effectiveFrom: '2026-08-01' } });
  assert.equal(r.status, 400, 'MPG is required for the allowance');
  assert.match(r.data.error, /MPG/);

  const rimo = await Provider.findOne({ providerNumber: '10063' });
  assert.equal((await call('PUT', `/providers/${rimo._id}`, { planId: plan._id })).status, 200);

  r = await call('POST', '/cycles/generate', { divisionId: div10._id, fromDate: '2026-08-24', count: 1 });
  const cycleId = r.data.created[0]._id;
  const form = new FormData();
  form.append('cycleId', cycleId);
  form.append('file', new Blob([fs.readFileSync(REPORT)]), 'report.xlsx');
  r = await call('POST', '/performance-imports', undefined, form);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const importId = r.data._id;
  for (const route of OPEN_RUNS) await call('POST', `/performance-imports/${importId}/routes`, { route, action: 'IGNORE', note: 'open run' });

  // Service miles are stored with the import; the VDP never needs the Excel file again.
  const stored = await PerformanceImport.findById(importId);
  assert.equal(stored.detectedColumns.SERVICE_MILES, true);
  const rows918 = stored.toObject().rows.filter((x) => x.route === '918');
  assert.ok(rows918.length > 0 && rows918.every((x) => x.serviceMiles !== null));
  assert.equal(rows918.find((x) => x.date === '2026-08-24').serviceMiles, '115.9');

  const expectedMax = sum(rows918.map((x) => D(x.serviceMiles).div(19))).toDecimalPlaces(2).toFixed(2);
  const vdpOf = async () => {
    const { data: list } = await call('GET', `/vdps?cycleId=${cycleId}`);
    return (await call('GET', `/vdps/${list.find((v) => v.provider.name === 'Rimo Transit LLC')._id}`)).data;
  };
  const codes = (v) => v.exceptions.map((e) => e.code).sort();

  let vdp;
  await t.test('the allowance is calculated at once; the VDP waits for the actual expense', async () => {
    r = await call('POST', '/vdps/process', { cycleId });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    vdp = await vdpOf();
    assert.deepEqual(codes(vdp), ['FUEL_EXPENSE_MISSING']);
    assert.equal(vdp.exceptions[0].message, 'Fuel expense has not been entered.');
    assert.equal(vdp.status, 'NEEDS_REVIEW');
    const a = vdp.view.calculation.fuelAllowance;
    assert.equal(a.maxAllowed, expectedMax, 'service miles ÷ 19');
    assert.equal(a.serviceMiles, sum(rows918.map((x) => x.serviceMiles)).toString());
    assert.equal(D(a.weekMiles[0]).plus(a.weekMiles[1]).toString(), a.serviceMiles);
    assert.equal(vdp.view.calculation.fuelOverspend, '0.00');
    assert.equal(vdp.view.performance.weeks[0].serviceMiles, a.weekMiles[0]);
  });

  await t.test('a manual Fuel adjustment is refused (it would deduct fuel twice)', async () => {
    r = await call('POST', `/vdps/${vdp._id}/adjustments`, { type: 'FUEL', amount: '50' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /actual fuel expense/);
  });

  const netBefore = () => D(vdp.view.calculation.gross).minus(vdp.view.calculation.lease);
  await t.test('Accounting enters the actual expense; the overspend is deducted once', async () => {
    r = await call('PATCH', `/vdps/${vdp._id}/fuel-expense`, { amount: 'lots' });
    assert.equal(r.status, 400);
    const actual = D(expectedMax).plus('146.20').toFixed(2);
    r = await call('PATCH', `/vdps/${vdp._id}/fuel-expense`, { amount: actual });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    vdp = r.data;
    assert.equal(vdp.status, 'READY', JSON.stringify(vdp.exceptions));
    const c = vdp.view.calculation;
    assert.equal(c.fuelAllowance.actualExpense, actual);
    assert.equal(c.fuelOverspend, '146.20');
    assert.equal(c.totalDeductions, D(c.lease).plus('146.20').toFixed(2), 'not also the actual expense');
    assert.equal(c.net, netBefore().minus('146.20').toFixed(2));
    assert.ok(vdp.history.some((h) => h.action === 'FUEL_EXPENSE_SET'));
  });

  await t.test('under the allowance there is no deduction', async () => {
    r = await call('PATCH', `/vdps/${vdp._id}/fuel-expense`, { amount: D(expectedMax).minus('21.69').toFixed(2) });
    vdp = r.data;
    assert.equal(vdp.view.calculation.fuelOverspend, '0.00');
    assert.equal(vdp.view.calculation.fuelAllowance.unused, '21.69');
    assert.equal(vdp.view.calculation.net, netBefore().toFixed(2));
    r = await call('PATCH', `/vdps/${vdp._id}/fuel-expense`, { amount: D(expectedMax).plus('146.20').toFixed(2) });
    vdp = r.data;
  });

  await t.test('the provider can override the plan MPG', async () => {
    r = await call('PUT', `/providers/${rimo._id}`, { overrides: { fuelMpg: '20' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.paymentSettings.fuelMpg, { value: '20', source: 'PROVIDER_OVERRIDE' });
    vdp = (await call('POST', `/vdps/${vdp._id}/recalculate`)).data;
    assert.equal(vdp.view.calculation.fuelAllowance.mpg, '20');
    assert.ok(D(vdp.view.calculation.fuelAllowance.maxAllowed).lt(expectedMax), 'more MPG, fewer allowed gallons');
    await call('PUT', `/providers/${rimo._id}`, { overrides: { fuelMpg: '' } });
    vdp = (await call('POST', `/vdps/${vdp._id}/recalculate`)).data;
    assert.equal(vdp.view.calculation.fuelAllowance.mpg, '19');
  });

  await t.test('an approved VDP keeps its fuel figures when the MPG changes', async () => {
    assert.equal((await call('POST', `/vdps/${vdp._id}/approve`)).status, 200);
    const frozen = (await call('GET', `/vdps/${vdp._id}`)).data.view;
    assert.equal(frozen.source, 'SNAPSHOT');
    assert.equal(frozen.fuelExpense.amount, D(expectedMax).plus('146.20').toFixed(2));

    await call('PUT', `/providers/${rimo._id}`, { overrides: { fuelMpg: '18' } });

    const after = (await call('GET', `/vdps/${vdp._id}`)).data.view;
    assert.deepEqual(after.calculation.fuelAllowance, frozen.calculation.fuelAllowance);
    assert.equal(after.calculation.fuelAllowance.mpg, '19');
    assert.equal(after.calculation.fuelOverspend, '146.20');
    assert.equal(after.settings.fuelMpg.value, '19');

    r = await call('PATCH', `/vdps/${vdp._id}/fuel-expense`, { amount: '1' });
    assert.equal(r.status, 409, 'approved VDPs are frozen');
  });

  await t.test('missing service miles stop the VDP instead of counting as zero', async () => {
    assert.equal((await call('POST', `/vdps/${vdp._id}/reopen`, { reason: 'Check fuel' })).status, 200);
    await call('PUT', `/providers/${rimo._id}`, { overrides: { fuelMpg: '' } });
    await PerformanceImport.updateOne({ _id: importId }, { $set: { 'rows.$[x].serviceMiles': null } }, { arrayFilters: [{ 'x.route': '918', 'x.date': '2026-08-25' }] });
    vdp = (await call('POST', `/vdps/${vdp._id}/recalculate`)).data;
    assert.equal(vdp.status, 'NEEDS_REVIEW');
    assert.match(vdp.exceptions.find((e) => e.code === 'SERVICE_MILES_MISSING').message, /08\/25\/2026/);
    assert.equal(vdp.view.calculation, null);

    // A report uploaded before service miles were captured has no Miles → Service column at all.
    await PerformanceImport.updateOne({ _id: importId }, { $unset: { 'detectedColumns.SERVICE_MILES': 1 } });
    vdp = (await call('POST', `/vdps/${vdp._id}/recalculate`)).data;
    assert.match(vdp.exceptions.find((e) => e.code === 'SERVICE_MILES_MISSING').message, /Service Miles required for fuel calculation are missing/);
  });
});
