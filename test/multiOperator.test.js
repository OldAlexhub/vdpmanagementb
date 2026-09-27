// A provider with several operators: each operator is measured against their own contract,
// the provider gets one VDP with the total, and the lift lease is charged per operator.
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

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(here, 'fixtures', 'performance-report-2026-08-01_to_09-09.xlsx');
const TEST_DB = 'bigstar_vdp_test';
const skip = !process.env.MONGO_URI && 'MONGO_URI not set';
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

test('provider with two operators', { skip }, async (t) => {
  const { data: divisions } = await call('GET', '/divisions');
  const div10 = divisions.find((d) => d.divisionNumber === '10');
  let r = await call('POST', '/cycles/generate', { divisionId: div10._id, fromDate: '2026-08-24', count: 1 });
  const cycleId = r.data.created[0]._id;
  const form = new FormData();
  form.append('cycleId', cycleId);
  form.append('file', new Blob([fs.readFileSync(REPORT)]), 'report.xlsx');
  r = await call('POST', '/performance-imports', undefined, form);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const importId = r.data._id;
  for (const route of ['900', '902', '912', '913', '914', '915', '919']) {
    await call('POST', `/performance-imports/${importId}/routes`, { route, action: 'IGNORE', note: 'open run' });
  }

  // Rimo takes on VeriCare's operator (route 917); VeriCare stops being a provider.
  const rimo = await Provider.findOne({ providerNumber: '10063' });
  const veri = await Provider.findOne({ providerNumber: '10115' });
  const lease = { amount: '197.50', frequency: 'WEEKLY' };
  await t.test('operators are validated and saved', async () => {
    r = await call('PUT', `/providers/${rimo._id}`, { operators: [{ name: 'Lisa Moore', routes: '918', liftLease: lease }, { name: 'Lisa Moore', routes: '917' }] });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /listed twice/);
    r = await call('PUT', `/providers/${rimo._id}`, { operators: [{ name: 'Lisa Moore', routes: '918', liftLease: lease }, { name: 'Verite Nitunga', routes: '918' }] });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Route 918 is on both/);
    r = await call('PUT', `/providers/${rimo._id}`, {
      operators: [{ name: 'Lisa Moore', routes: '918', liftLease: lease }, { name: 'Verite Nitunga', routes: '917', liftLease: lease }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.routes, ['918', '917']);
    assert.equal(r.data.operators.length, 2);
    r = await call('PUT', `/providers/${veri._id}`, { status: 'INACTIVE' });
    assert.equal(r.status, 200);
  });

  const vdpOf = async (name) => {
    const { data: list } = await call('GET', `/vdps?cycleId=${cycleId}`);
    return (await call('GET', `/vdps/${list.find((v) => v.provider.name === name)._id}`)).data;
  };

  let vdp;
  await t.test('one VDP, each operator on their own contract, lease per operator', async () => {
    r = await call('POST', '/vdps/process', { cycleId });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    vdp = await vdpOf('Rimo Transit LLC');
    assert.equal(vdp.status, 'READY', JSON.stringify(vdp.exceptions));
    const c = vdp.view.calculation;
    assert.deepEqual(c.operators.map((o) => o.name), ['Lisa Moore', 'Verite Nitunga']);
    const [lisa, verite] = c.operators;
    // Lisa alone is exactly the verified single-operator regression.
    assert.equal(lisa.earnings, '2637.69');
    assert.equal(lisa.weeks[0].performancePercentage, '123.175');
    assert.equal(lisa.lease, '395.00');
    assert.deepEqual(verite.routes, ['917']);
    assert.equal(verite.weeks[0].contractedHours, '40', 'measured against their own 40 h, not 80');
    assert.equal(c.gross, (Number(lisa.earnings) + Number(verite.earnings)).toFixed(2));
    assert.equal(c.lease, '790.00');
    assert.equal(c.weeks[0].contractedHours, '80');
    assert.equal(c.weeks[0].tierLabel, 'Per operator');
    assert.deepEqual(vdp.view.lease.operators.map((o) => o.name), ['Lisa Moore', 'Verite Nitunga']);
    assert.ok(!(await vdpOf('Rimo Transit LLC')).view.calculation.steps.some((s) => s.label === 'Lift lease'));
  });

  await t.test('a route assigned to the provider but to no operator is flagged, not guessed', async () => {
    r = await call('POST', `/performance-imports/${importId}/routes`, { route: '900', action: 'ASSIGN', providerId: String(rimo._id) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await call('POST', `/vdps/${vdp._id}/recalculate`);
    assert.equal(r.data.status, 'NEEDS_REVIEW');
    assert.ok(r.data.exceptions.some((e) => e.code === 'ROUTE_WITHOUT_OPERATOR'));

    r = await call('POST', `/performance-imports/${importId}/routes`, { route: '900', action: 'ASSIGN', providerId: String(rimo._id), saveToProfile: true });
    assert.equal(r.status, 400, 'must choose the operator');
    assert.match(r.data.error, /Choose which one runs route 900/);
    const verite = (await Provider.findById(rimo._id)).operators.find((o) => o.name === 'Verite Nitunga');
    r = await call('POST', `/performance-imports/${importId}/routes`, { route: '900', action: 'ASSIGN', providerId: String(rimo._id), saveToProfile: true, operatorId: String(verite._id) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await call('POST', `/vdps/${vdp._id}/recalculate`);
    assert.equal(r.data.status, 'READY', JSON.stringify(r.data.exceptions));
    assert.deepEqual((await Provider.findById(rimo._id)).operators[1].routes, ['917', '900']);
  });

  await t.test('statement PDF and cycle export include the operators', async () => {
    const pdf = await fetch(`${base}/api/vdps/${vdp._id}/statement.pdf`, { headers: { cookie } });
    assert.equal(pdf.status, 200);
    const xlsx = await fetch(`${base}/api/exports/cycles/${cycleId}.xlsx`, { headers: { cookie } });
    assert.equal(xlsx.status, 200);
  });
});
