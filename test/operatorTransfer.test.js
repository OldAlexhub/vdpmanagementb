// An operator moves from one provider to another on an effective date: report days before it
// stay with the old provider, days from it are paid to the new one — also inside a cycle.
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

test('operator moves to another provider mid-cycle', { skip }, async (t) => {
  const { data: divisions } = await call('GET', '/divisions');
  const div10 = divisions.find((d) => d.divisionNumber === '10');

  const loadCycle = async (fromDate) => {
    const r = await call('POST', '/cycles/generate', { divisionId: div10._id, fromDate, count: 1 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const cycleId = r.data.created[0]._id;
    const form = new FormData();
    form.append('cycleId', cycleId);
    form.append('file', new Blob([fs.readFileSync(REPORT)]), 'report.xlsx');
    const imp = await call('POST', '/performance-imports', undefined, form);
    assert.equal(imp.status, 201, JSON.stringify(imp.data));
    for (const route of OPEN_RUNS) {
      await call('POST', `/performance-imports/${imp.data._id}/routes`, { route, action: 'IGNORE', note: 'open run' });
    }
    return { cycleId, importId: imp.data._id };
  };
  const vdpOf = async (cycleId, name) => {
    const { data: list } = await call('GET', `/vdps?cycleId=${cycleId}`);
    const v = list.find((x) => x.provider.name === name);
    return v && (await call('GET', `/vdps/${v._id}`)).data;
  };

  const rimo = await Provider.findOne({ providerNumber: '10063' });
  const veri = await Provider.findOne({ providerNumber: '10115' });
  const lease = { amount: '197.50', frequency: 'WEEKLY' };
  let r = await call('PUT', `/providers/${rimo._id}`, { operators: [{ name: 'Lisa Moore', routes: '918', liftLease: lease }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const lisaId = r.data.operators[0].id;

  const earlier = await loadCycle('2026-08-10');
  const cycle = await loadCycle('2026-08-24');

  // Before the move: Rimo is paid for route 918 for the whole cycle.
  r = await call('POST', '/vdps/process', { cycleId: cycle.cycleId });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const before918 = (await vdpOf(cycle.cycleId, 'Rimo Transit LLC')).view.performance;
  const [w1, w2] = before918.weeks;
  assert.ok(Number(w2.trips) > 0);

  await t.test('the move is validated', async () => {
    const url = `/providers/${rimo._id}/operators/${lisaId}/transfer`;
    r = await call('POST', url, { toProviderId: String(veri._id) });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /effective date/);
    r = await call('POST', url, { toProviderId: String(rimo._id), effectiveDate: '2026-08-31' });
    assert.equal(r.status, 400);

    // An approved VDP covering the move date must be reopened first.
    const rimoVdp = await vdpOf(cycle.cycleId, 'Rimo Transit LLC');
    assert.equal(rimoVdp.status, 'READY', JSON.stringify(rimoVdp.exceptions));
    assert.equal((await call('POST', `/vdps/${rimoVdp._id}/approve`)).status, 200);
    r = await call('POST', url, { toProviderId: String(veri._id), effectiveDate: '2026-08-31' });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /Reopen them first/);
    assert.equal((await call('POST', `/vdps/${rimoVdp._id}/reopen`, { reason: 'Operator moved to VeriCare' })).status, 200);
  });

  await t.test('Lisa moves to VeriCare from week 2', async () => {
    r = await call('POST', `/providers/${rimo._id}/operators/${lisaId}/transfer`, { toProviderId: String(veri._id), effectiveDate: '2026-08-31', note: 'Changed provider' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const moved = r.data.operators.find((o) => o.id === lisaId);
    assert.equal(moved.endDate, '2026-08-30');
    assert.equal(moved.transferredTo.providerName, veri.name);
    assert.deepEqual(r.data.sharedRoutes, [], 'a handed-over route is not a shared route');

    const v = (await call('GET', `/providers/${veri._id}`)).data;
    const joined = v.operators.find((o) => o.name === 'Lisa Moore');
    assert.equal(joined.startDate, '2026-08-31');
    assert.deepEqual(joined.routes, ['918']);
    assert.equal(Number(joined.liftLease.amount), 197.5);
    assert.ok(v.operators.some((o) => o.routes.includes('917')), 'VeriCare keeps its own operator');

    r = await call('POST', `/providers/${rimo._id}/operators/${lisaId}/transfer`, { toProviderId: String(veri._id), effectiveDate: '2026-09-07' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /already moved/);
  });

  await t.test('the cycle is split by date and each week’s lease is charged once', async () => {
    r = await call('POST', '/vdps/process', { cycleId: cycle.cycleId });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const imp = (await call('GET', `/performance-imports/${cycle.importId}`)).data;
    const m918 = imp.routeMatches.find((m) => m.route === '918');
    assert.equal(m918.status, 'MATCHED');
    assert.deepEqual(m918.split.map((s) => [s.providerName, s.from <= '2026-08-30', s.to >= '2026-08-31']), [[rimo.name, true, false], [veri.name, false, true]]);

    const rv = await vdpOf(cycle.cycleId, 'Rimo Transit LLC');
    assert.deepEqual(rv.view.performance.weeks.map((w) => w.trips), [w1.trips, '0']);
    assert.equal(rv.view.calculation.lease, '197.50', 'Rimo pays week 1 only');

    const vv = await vdpOf(cycle.cycleId, veri.name);
    assert.ok(!vv.exceptions.some((e) => e.code === 'ROUTE_WITHOUT_OPERATOR'), JSON.stringify(vv.exceptions));
    const lisa = vv.view.calculation.operators.find((o) => o.name === 'Lisa Moore');
    assert.deepEqual(lisa.weeks.map((w) => w.trips), ['0', w2.trips]);
    assert.equal(lisa.lease, '197.50', 'VeriCare pays week 2 only');
    assert.match(vv.view.lease.note, /joined from Rimo/);
  });

  await t.test('an earlier cycle stays with the old provider', async () => {
    r = await call('POST', '/vdps/process', { cycleId: earlier.cycleId });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const imp = (await call('GET', `/performance-imports/${earlier.importId}`)).data;
    const m918 = imp.routeMatches.find((m) => m.route === '918');
    assert.equal(m918.status, 'MATCHED');
    assert.equal(m918.providerName, rimo.name);
    const vv = await vdpOf(earlier.cycleId, veri.name);
    assert.ok(!vv.view.calculation?.operators?.some((o) => o.name === 'Lisa Moore'));
  });

  await t.test('editing either provider keeps the move', async () => {
    const v = (await call('GET', `/providers/${veri._id}`)).data;
    r = await call('PUT', `/providers/${veri._id}`, { operators: v.operators.map((o) => ({ _id: o.id, ...o })) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.operators.find((o) => o.name === 'Lisa Moore').startDate, '2026-08-31');
    // The edit form leaves moved-away operators out; they are kept for earlier cycles.
    r = await call('PUT', `/providers/${rimo._id}`, { operators: [] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.operators.find((o) => o.id === lisaId)?.endDate, '2026-08-30');
    assert.ok(r.data.routes.includes('918'));
  });
});
