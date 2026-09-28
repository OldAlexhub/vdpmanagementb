// One provider, two operators on different VDP plans: each operator is paid under their own
// plan (payment type, rates, hours column, fuel), and the provider gets one VDP with the total.
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

test('operators on different VDP plans', { skip }, async (t) => {
  const { data: divisions } = await call('GET', '/divisions');
  const div10 = divisions.find((d) => d.divisionNumber === '10');
  let r = await call('POST', '/vdp-plans', {
    divisionId: div10._id,
    name: 'Day per trip',
    version: { paymentType: 'PER_TRIP', basePay: '21.50', fuelMethod: 'PER_TRIP', fuelReimbursementRate: '1.25', effectiveFrom: '2026-08-01' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const dayPlan = r.data;

  const rimo = await Provider.findOne({ providerNumber: '10063' });
  const veri = await Provider.findOne({ providerNumber: '10115' });
  const lease = { amount: '197.50', frequency: 'WEEKLY' };

  await t.test('an operator can be put on another plan of the same division', async () => {
    const other = await call('POST', '/divisions', { divisionNumber: '99', name: 'Elsewhere', timezone: 'America/Los_Angeles' });
    assert.equal(other.status, 201, JSON.stringify(other.data));
    const foreign = await call('POST', '/vdp-plans', { divisionId: other.data._id, name: 'Foreign', version: { paymentType: 'PER_TRIP', basePay: '20', effectiveFrom: '2026-08-01' } });
    r = await call('PUT', `/providers/${rimo._id}`, { operators: [{ name: 'Lisa Moore', routes: '918', liftLease: lease, planId: foreign.data._id }] });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /provider’s division/);

    r = await call('PUT', `/providers/${rimo._id}`, {
      operators: [
        { name: 'Lisa Moore', routes: '918', liftLease: lease, planId: String(rimo.planId) }, // same as provider = none
        { name: 'Verite Nitunga', routes: '917', planId: dayPlan._id },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.operators.map((o) => o.planId), [null, dayPlan._id]);
    await call('PUT', `/providers/${veri._id}`, { status: 'INACTIVE' });
  });

  r = await call('POST', '/cycles/generate', { divisionId: div10._id, fromDate: '2026-08-24', count: 1 });
  const cycleId = r.data.created[0]._id;
  const form = new FormData();
  form.append('cycleId', cycleId);
  form.append('file', new Blob([fs.readFileSync(REPORT)]), 'report.xlsx');
  r = await call('POST', '/performance-imports', undefined, form);
  const importId = r.data._id;
  for (const route of OPEN_RUNS) await call('POST', `/performance-imports/${importId}/routes`, { route, action: 'IGNORE', note: 'open run' });
  const rows917 = (await PerformanceImport.findById(importId)).toObject().rows.filter((x) => x.route === '917');
  const tripsByWeek = [['2026-08-24', '2026-08-30'], ['2026-08-31', '2026-09-06']]
    .map(([from, to]) => sum(rows917.filter((x) => x.date >= from && x.date <= to).map((x) => x.trips)));

  const vdpOf = async () => {
    const { data: list } = await call('GET', `/vdps?cycleId=${cycleId}`);
    return (await call('GET', `/vdps/${list.find((v) => v.provider.name === 'Rimo Transit LLC')._id}`)).data;
  };

  let vdp;
  await t.test('each operator is paid under their own plan, in one VDP', async () => {
    r = await call('POST', '/vdps/process', { cycleId });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    vdp = await vdpOf();
    assert.equal(vdp.status, 'READY', JSON.stringify(vdp.exceptions));
    const c = vdp.view.calculation;
    const [lisa, verite] = c.operators;
    // Lisa on the provider's hourly TUI plan: exactly the verified single-operator regression.
    assert.equal(lisa.earnings, '2637.69');
    assert.equal(lisa.plan, null);
    assert.equal(lisa.paymentType, 'HOURLY');
    // Verite on the per-trip day plan: trips × $21.50 per week, no TUI.
    assert.equal(verite.plan.name, 'Day per trip');
    assert.equal(verite.paymentType, 'PER_TRIP');
    assert.deepEqual(verite.weeks.map((w) => w.weeklyEarnings), tripsByWeek.map((tr) => tr.times('21.50').toFixed(2)));
    assert.equal(c.gross, D(lisa.earnings).plus(verite.earnings).toFixed(2));
    // Fuel only for Verite's plan, on Verite's trips.
    assert.equal(c.fuelReimbursement, sum(tripsByWeek).times('1.25').toDecimalPlaces(2).toFixed(2));
    assert.equal(c.lease, '395.00', 'Lisa’s lease only');
    assert.deepEqual(vdp.view.settings.operatorPlans.map((o) => [o.name, o.planName, o.source]), [
      ['Lisa Moore', vdp.view.settings.planName, 'PROVIDER'],
      ['Verite Nitunga', 'Day per trip', 'OPERATOR'],
    ]);
  });

  await t.test('provider overrides do not leak into an operator’s own plan', async () => {
    await call('PUT', `/providers/${rimo._id}`, { overrides: { basePay: '99', tuiEligibility: 'INHERIT' } });
    vdp = (await call('POST', `/vdps/${vdp._id}/recalculate`)).data;
    const verite = vdp.view.calculation.operators[1];
    assert.equal(verite.weeks[0].incentiveRate, '21.5');
    await call('PUT', `/providers/${rimo._id}`, { overrides: { basePay: '', tuiEligibility: 'INHERIT' } });
  });

  await t.test('an operator’s plan with the service mile allowance: only their miles, their divisor', async () => {
    r = await call('POST', '/vdp-plans', {
      divisionId: div10._id,
      name: 'Day allowance',
      version: { paymentType: 'PER_TRIP', basePay: '21.50', fuelMethod: 'SERVICE_MILE_ALLOWANCE', fuelMpg: '19', effectiveFrom: '2026-08-01' },
      fuelPrices: [{ pricePerGallon: '4.794', effectiveFrom: '2026-08-01' }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const allowancePlan = r.data;
    const p = (await call('GET', `/providers/${rimo._id}`)).data;
    r = await call('PUT', `/providers/${rimo._id}`, {
      operators: p.operators.map((o) => ({ _id: o.id, ...o, planId: o.name === 'Verite Nitunga' ? allowancePlan._id : o.planId })),
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    vdp = (await call('POST', `/vdps/${vdp._id}/recalculate`)).data;
    assert.deepEqual(vdp.exceptions.map((e) => e.code), ['FUEL_EXPENSE_MISSING']);
    const a = vdp.view.calculation.fuelAllowance;
    assert.equal(a.serviceMiles, sum(rows917.map((x) => x.serviceMiles)).toString(), 'Lisa’s route 918 miles are not counted');
    assert.equal(a.maxAllowed, sum(rows917.map((x) => D(x.serviceMiles).div(19).times('4.794'))).toDecimalPlaces(2).toFixed(2));
    assert.ok(a.days.every((d) => d.operator === 'Verite Nitunga' && d.mpg === '19'));

    r = await call('POST', `/vdps/${vdp._id}/adjustments`, { type: 'FUEL', amount: '5' });
    assert.equal(r.status, 400, 'no double fuel deduction');
    r = await call('PATCH', `/vdps/${vdp._id}/fuel-expense`, { amount: D(a.maxAllowed).plus(10).toFixed(2) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    vdp = r.data;
    assert.equal(vdp.status, 'READY', JSON.stringify(vdp.exceptions));
    assert.equal(vdp.view.calculation.fuelOverspend, '10.00');
  });

  await t.test('approval freezes which plan each operator was paid under', async () => {
    assert.equal((await call('POST', `/vdps/${vdp._id}/approve`)).status, 200);
    const p = (await call('GET', `/providers/${rimo._id}`)).data;
    await call('PUT', `/providers/${rimo._id}`, { operators: p.operators.map((o) => ({ _id: o.id, ...o, planId: null })) });
    const frozen = (await call('GET', `/vdps/${vdp._id}`)).data.view;
    assert.equal(frozen.source, 'SNAPSHOT');
    assert.equal(frozen.settings.operatorPlans[1].planName, 'Day allowance');
    assert.equal(frozen.calculation.operators[1].plan.name, 'Day allowance');
  });
});
