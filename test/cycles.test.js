// VDP cycles are company-wide: one schedule, and each period exists for every active division.
// Uses bigstar_vdp_test, dropped at the start of the run.
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../scripts/seed.js';
import VdpCycle from '../src/models/VdpCycle.js';
import { isoDate } from '../src/services/cycleService.js';

const TEST_DB = 'bigstar_vdp_test';
const skip = !process.env.MONGO_URI && 'MONGO_URI not set';
let server;
let base;
let cookie = '';

async function call(method, url, body) {
  const headers = { cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, headers: res.headers, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
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
  assert.equal((await call('POST', '/auth/setup', { name: 'Cycle Admin', email: 'cycles@test.local', password: 'correct-horse-1' })).status, 201);
});

after(async () => {
  if (skip) return;
  server?.close();
  await disconnectDb();
});

test('company-wide VDP cycles', { skip }, async (t) => {
  let r;
  await t.test('one schedule for the company, carried over from the existing division', async () => {
    r = await call('GET', '/settings/cycle-schedule');
    assert.deepEqual(r.data, { anchorDate: '2026-08-24', lengthDays: 14, submissionOffsetDays: 15, paymentOffsetDays: 4 });
    r = await call('PUT', '/settings/cycle-schedule', { anchorDate: '2026-08-25' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Monday/);
  });

  await t.test('generating creates each period for every active division, same dates', async () => {
    r = await call('POST', '/divisions', { divisionNumber: '6', name: 'Seattle' });
    assert.equal(r.status, 201);
    const today = isoDate(new Date());
    r = await call('POST', '/cycles/generate', { fromDate: today, count: 2 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.created.length, 4);
    assert.equal(r.data.divisions, 2);
    r = await call('POST', '/cycles/generate', { fromDate: today, count: 2 });
    assert.equal(r.data.created.length, 0);
    assert.equal(r.data.existing, 4);

    r = await call('GET', '/cycles/periods');
    assert.equal(r.data.periods.length, 2);
    for (const p of r.data.periods) assert.equal(p.cycles.length, 2);
    assert.equal(r.data.divisions.length, 2);
  });

  await t.test('a new division joins the current and upcoming periods', async () => {
    r = await call('POST', '/divisions', { divisionNumber: '7', name: 'Tacoma' });
    assert.equal(r.status, 201);
    assert.equal(await VdpCycle.countDocuments({ divisionId: r.data._id }), 2);
    r = await call('GET', '/cycles/periods');
    for (const p of r.data.periods) assert.equal(p.cycles.length, 3);
  });

  await t.test('schedule changes apply to new cycles only', async () => {
    r = await call('PUT', '/settings/cycle-schedule', { submissionOffsetDays: 10, paymentOffsetDays: 3 });
    assert.equal(r.status, 200);
    r = await call('GET', '/cycles/preview', undefined);
    const sub = new Date(r.data.cycleEnd);
    sub.setUTCDate(sub.getUTCDate() + 10);
    assert.equal(isoDate(r.data.submissionDate), isoDate(sub));
    const existing = await VdpCycle.findOne().sort({ cycleStart: 1 });
    assert.equal((existing.submissionDate - existing.cycleEnd) / 86400000, 15, 'existing cycles keep their dates');
  });

  await t.test('schedule downloads as a PDF', async () => {
    r = await call('GET', '/exports/cycle-schedule.pdf');
    assert.equal(r.status, 200);
    assert.match(r.type, /pdf/);
    assert.equal(r.data.subarray(0, 4).toString(), '%PDF');
    assert.match(r.headers.get('content-disposition'), /VDP Cycle Schedule/);
    r = await call('GET', `/exports/cycle-schedule.pdf?year=${new Date().getUTCFullYear()}`);
    assert.equal(r.status, 200);
  });
});
