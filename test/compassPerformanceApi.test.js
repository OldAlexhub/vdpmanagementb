import 'dotenv/config';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { connectDb, disconnectDb } from '../src/config/db.js';
import Division from '../src/models/Division.js';
import Provider from '../src/models/Provider.js';
import VdpPlan from '../src/models/VdpPlan.js';
import VdpCycle from '../src/models/VdpCycle.js';
import Vdp from '../src/models/Vdp.js';
import User from '../src/models/User.js';
import PerformanceImport from '../src/models/PerformanceImport.js';
import CompassPerformanceState from '../src/models/CompassPerformanceState.js';
import { createApp } from '../src/app.js';
import { jwtSecret } from '../src/middleware/auth.js';
import { syncCompassPerformance, correctCompassPerformance, compassPerformanceView, compassDatasetReplacement, performanceDates, ensureCompassPerformance, withCompassApprovalLock } from '../src/services/compassPerformanceService.js';
import { computeVdp, recalculate } from '../src/services/vdpService.js';
import { divisionSourceReadiness } from '../src/services/divisionSourceService.js';
import { refreshDivisionDerivedImport } from '../src/services/division10Adapter.js';
import { compassFixture, fixtureRequest } from './fixtures/compassPerformance.js';

const TEST_DB = 'bigstar_vdp_compass_test';
const skip = !process.env.MONGO_URI && 'MONGO_URI not set';
let server, base, cycle, division, provider, plan, user, statement, frozen;
const dates = performanceDates('2026-09-01', '2026-09-14');
const oldBase = process.env.COMPASS_BASE_URL, oldToken = process.env.COMPASS_API_TOKEN;

before(async () => {
  if (skip) return;
  assert.ok(TEST_DB.endsWith('_test'));
  process.env.COMPASS_BASE_URL = 'https://compass.example.test'; process.env.COMPASS_API_TOKEN = 'test-only';
  await connectDb(TEST_DB);
  assert.equal(mongoose.connection.name, TEST_DB);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
  division = await Division.create({ divisionNumber: '6', name: 'Test division', source: { system: 'COMPASS', externalId: 'external-6' } });
  plan = await VdpPlan.create({ divisionId: division._id, name: 'Service hours', status: 'ACTIVE', versions: [{ versionNumber: 1, effectiveFrom: new Date('2026-01-01'), paymentType: 'HOURLY', basePay: '20', contractedHours: '40', performanceHourMetric: 'SERVICE_HOURS', fuelMethod: 'NONE' }] });
  provider = await Provider.create({ divisionId: division._id, name: 'Test provider', planId: plan._id, operators: [{ name: 'Driver One', routes: ['600'], source: { system: 'COMPASS', externalId: 'external-op-1' } }] });
  cycle = await VdpCycle.create({ divisionId: division._id, cycleStart: new Date('2026-09-01'), cycleEnd: new Date('2026-09-14'), week1Start: new Date('2026-09-01'), week1End: new Date('2026-09-07'), week2Start: new Date('2026-09-08'), week2End: new Date('2026-09-14'), status: 'OPEN' });
  user = await User.create({ name: 'Test Accounting', email: 'compass-accounting@example.test', passwordHash: 'unused', role: 'ACCOUNTING', active: true });
  statement = await Vdp.create({ divisionId: division._id, cycleId: cycle._id, providerId: provider._id, status: 'DRAFT' });
  const lockedProvider = await Provider.create({ divisionId: division._id, name: 'Frozen provider', status: 'INACTIVE' });
  frozen = await Vdp.create({ divisionId: division._id, cycleId: cycle._id, providerId: lockedProvider._id, status: 'PAID', snapshot: { gross: '123.45', performance: { serviceHours: '6' } } });
  server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  if (!skip) await disconnectDb();
  if (oldBase === undefined) delete process.env.COMPASS_BASE_URL; else process.env.COMPASS_BASE_URL = oldBase;
  if (oldToken === undefined) delete process.env.COMPASS_API_TOKEN; else process.env.COMPASS_API_TOKEN = oldToken;
});

test('Compass snapshots, calculations, audited corrections and refresh lifecycle', { skip }, async (t) => {
  let view;
  const request = fixtureRequest(compassFixture({ dates }));
  await t.test('imports reconciled metrics once and preserves approved history', async () => {
    view = await syncCompassPerformance(cycle._id, { expectedRevision: 0, user, request });
    assert.equal(view.loaded, true); assert.equal(view.rows.length, 14); assert.equal(view.unresolvedCount, 0);
    assert.equal(view.totals.serviceHours, '112');
    assert.equal((await Vdp.findById(statement._id)).stale, true);
    assert.deepEqual((await Vdp.findById(frozen._id)).snapshot, frozen.snapshot);
    assert.equal((await Vdp.findById(frozen._id)).stale, false);
    const importId = String(view.importId), revision = view.revision;
    await Vdp.updateOne({ _id: statement._id }, { $set: { stale: false } });
    view = await syncCompassPerformance(cycle._id, { expectedRevision: view.revision, user, request });
    assert.equal(String(view.importId), importId);
    assert.equal(view.revision, revision);
    assert.equal((await Vdp.findById(statement._id)).stale, false, 'identical refresh does not invalidate a calculation');
    assert.equal(await PerformanceImport.countDocuments({ kind: 'COMPASS' }), 1);
    assert.equal((await ensureCompassPerformance(cycle._id, user)).revision, view.revision, 'reopening does not contact the API');
  });
  await t.test('removes only the covered upload and preserves supplemental requirements', async () => {
    const replacement = await compassDatasetReplacement(cycle, division, view);
    assert.equal(replacement.datasetType, 'DIV6_TRAPEZE');
    let readiness = await divisionSourceReadiness({ cycle, division, compassView: view });
    assert.equal(readiness.datasets.DIV6_TRAPEZE.satisfiedBy, 'COMPASS');
    assert.equal(readiness.requiredReady, true); assert.equal(readiness.additionalReady, false);
    await PerformanceImport.create({ divisionId: division._id, cycleId: cycle._id, kind: 'DIVISION_SOURCE', datasetType: 'DIV6_RETURNED_TICKETS', originalFileName: 'tickets.csv', fileHash: 'tickets', datesDetected: dates, weeksDetected: ['2026-09-01', '2026-09-08'], stats: { adapterVersion: 'DIV6_V1' } });
    readiness = await divisionSourceReadiness({ cycle, division, compassView: view });
    assert.equal(readiness.processingSupported, true);
    await refreshDivisionDerivedImport({ cycle, division, user });
    const computed = await computeVdp(await Vdp.findById(statement._id));
    assert.equal(computed.performance.weeks[0].actualHours, '56');
    assert.equal(computed.performance.weeks[0].trips, '70');
    assert.equal(computed.calculation.gross, '2240.00');
    assert.equal(computed.status, 'READY');
    plan.versions[0].fuelMethod = 'SERVICE_MILE_ALLOWANCE'; plan.versions[0].fuelMpg = '20'; await plan.save();
    assert.equal(await compassDatasetReplacement(cycle, division, view), null, 'mileage requirement retains the raw upload');
    plan.versions[0].fuelMethod = 'NONE'; plan.versions[0].performanceHourMetric = 'TOTAL_HOURS'; await plan.save();
    assert.equal(await compassDatasetReplacement(cycle, division, view), null, 'service hours do not substitute for total hours');
    plan.versions[0].performanceHourMetric = 'SERVICE_HOURS'; await plan.save();
    const div3 = await Division.create({ divisionNumber: '3GL', name: 'GoLink', source: { system: 'COMPASS', externalId: 'external-3' } });
    assert.equal(await compassDatasetReplacement(cycle, div3, view), null, 'DIV 3 duty/TUI uploads remain required');
  });
  await t.test('requires reasons and validates values, with revision-based concurrent edits', async () => {
    const rowKey = view.rows[0].rowKey;
    const input = { expectedRevision: view.revision, rowKey, values: { serviceHours: '9.5' }, reason: 'Approved duty correction' };
    await assert.rejects(correctCompassPerformance(cycle._id, { ...input, reason: ' ' }, user), /reason/);
    await assert.rejects(correctCompassPerformance(cycle._id, { ...input, values: { trips: '2.5' } }, user), /Invalid trips/);
    const results = await Promise.allSettled([correctCompassPerformance(cycle._id, input, user), correctCompassPerformance(cycle._id, input, user)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 1);
    view = await compassPerformanceView(cycle._id);
    assert.equal(view.rows[0].serviceHours, '9.5'); assert.equal(view.rows[0].original.serviceHours, '8');
    assert.equal(view.correctionHistory[0].by.name, user.name); assert.equal(view.correctionHistory[0].reason, input.reason);
    const recalculated = await recalculate(statement._id, user);
    assert.equal(recalculated.performance.weeks[0].actualHours, '57.5');
    assert.equal(recalculated.provenance.compass.revision, view.revision);
  });
  await t.test('failed refresh keeps snapshot; changed source preserves correction and requires review', async () => {
    const priorId = String(view.importId), priorRevision = view.revision;
    await assert.rejects(syncCompassPerformance(cycle._id, { expectedRevision: view.revision, user, request: async () => { throw new Error('Fixture connection failed'); } }), /connection failed/);
    view = await compassPerformanceView(cycle._id);
    assert.equal(String(view.importId), priorId); assert.equal(view.revision, priorRevision); assert.match(view.lastError, /connection failed/);
    view = await syncCompassPerformance(cycle._id, { expectedRevision: view.revision, user, request: fixtureRequest(compassFixture({ dates, hours: 9 })) });
    assert.equal(view.rows[0].serviceHours, '9.5'); assert.equal(view.rows[0].original.serviceHours, '9'); assert.equal(view.conflictCount, 1);
    const computed = await computeVdp(await Vdp.findById(statement._id));
    assert.ok(computed.exceptions.some((e) => e.code === 'COMPASS_CORRECTION_CONFLICT'));
    view = await correctCompassPerformance(cycle._id, { expectedRevision: view.revision, rowKey: view.rows[0].rowKey, action: 'RETAIN', reason: 'Reviewed new source; correction remains valid' }, user);
    assert.equal(view.conflictCount, 0); assert.equal(view.correctionHistory.length, 2);
    view = await correctCompassPerformance(cycle._id, { expectedRevision: view.revision, rowKey: view.rows[0].rowKey, action: 'REVERT', reason: 'Accept the corrected Compass source' }, user);
    assert.equal(view.rows[0].serviceHours, '9'); assert.equal(view.correctionHistory.length, 3);
  });
  await t.test('missing corrected records remain reviewable and can be explicitly retained or reverted', async () => {
    const rowKey = view.rows[0].rowKey;
    view = await correctCompassPerformance(cycle._id, { expectedRevision: view.revision, rowKey, values: { trips: '12' }, reason: 'Missing completed trips' }, user);
    view = await syncCompassPerformance(cycle._id, { expectedRevision: view.revision, user, request: fixtureRequest(compassFixture({ dates: dates.slice(1), hours: 9 })) });
    assert.equal(view.rows.find((r) => r.rowKey === rowKey).missingFromSource, true); assert.equal(view.conflictCount, 1);
    view = await correctCompassPerformance(cycle._id, { expectedRevision: view.revision, rowKey, action: 'RETAIN', reason: 'Verified work despite upstream removal' }, user);
    assert.equal(view.conflictCount, 0);
    view = await correctCompassPerformance(cycle._id, { expectedRevision: view.revision, rowKey, action: 'REVERT', reason: 'Remove local retained work' }, user);
    assert.ok(!view.rows.some((r) => r.rowKey === rowKey));
    assert.equal(await compassDatasetReplacement(cycle, division, view), null, 'partial date coverage retains uploads');
    const computed = await computeVdp(await Vdp.findById(statement._id));
    assert.equal(computed.performance.days.length, 13, 'old materialized Compass data cannot reappear as fallback');
    assert.ok(computed.exceptions.some((e) => e.code === 'COMPASS_INPUTS_REQUIRED'));
  });
  await t.test('HTTP mutation permissions match existing Accounting access', async () => {
    const nsm = await User.create({ name: 'Test NSM', email: 'compass-nsm@example.test', passwordHash: 'unused', role: 'NSM', active: true });
    const cookie = (u) => `vdp_session=${jwt.sign({ sub: String(u._id), ver: 1 }, jwtSecret())}`;
    const endpoint = `${base}/api/cycles/${cycle._id}/compass-performance`;
    for (const suffix of ['/sync', '/corrections']) {
      const response = await fetch(endpoint + suffix, { method: 'POST', headers: { cookie: cookie(nsm), 'X-VDP-CSRF': '1', 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 403);
    }
    const read = await fetch(endpoint, { headers: { cookie: cookie(nsm) } }); assert.equal(read.status, 200);
    const response = await fetch(endpoint + '/corrections', { method: 'POST', headers: { cookie: cookie(user), 'X-VDP-CSRF': '1', 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: view.revision, rowKey: view.rows[0].rowKey, values: { trips: '11' }, reason: 'Accounting validation' }) });
    assert.equal(response.status, 200); view = await response.json();
  });
  await t.test('missing hours cannot silently become zero and approval serializes with corrections', async () => {
    const fixture = compassFixture({ dates, hours: 9 });
    fixture.entries[0].metrics.reportedServiceHours = null;
    fixture.analysis.daily[0].serviceHours = 0;
    fixture.analysis.summary.serviceHours -= 9;
    view = await syncCompassPerformance(cycle._id, { expectedRevision: view.revision, user, request: fixtureRequest(fixture) });
    const computed = await computeVdp(await Vdp.findById(statement._id), { importDoc: null });
    assert.ok(computed.exceptions.some((e) => e.code === 'PERFORMANCE_HOURS_MISSING'));
    assert.equal(computed.calculation, null);
    assert.equal(await compassDatasetReplacement(cycle, division, view), null);
    await withCompassApprovalLock(cycle._id, view.revision, async () => {
      await assert.rejects(correctCompassPerformance(cycle._id, { expectedRevision: view.revision, rowKey: view.rows[0].rowKey, values: { trips: '14' }, reason: 'Concurrent approval' }, user), (e) => e.status === 409);
    });
    assert.equal((await CompassPerformanceState.findOne({ cycleId: cycle._id })).lock, null);
  });
  await t.test('locked provider statements and closed periods reject corrections', async () => {
    await Vdp.updateOne({ _id: statement._id }, { $set: { status: 'APPROVED', snapshot: { gross: '2240.00' } } });
    await assert.rejects(correctCompassPerformance(cycle._id, { expectedRevision: view.revision, rowKey: view.rows[0].rowKey, values: { trips: '13' }, reason: 'Locked correction' }, user), /Reopen this provider/);
    await VdpCycle.updateOne({ _id: cycle._id }, { $set: { status: 'CLOSED' } });
    await assert.rejects(syncCompassPerformance(cycle._id, { expectedRevision: view.revision, user, request }), /Reopen this pay period/);
    assert.deepEqual((await Vdp.findById(frozen._id)).snapshot, frozen.snapshot);
    assert.equal((await CompassPerformanceState.findOne({ cycleId: cycle._id })).lock, null);
  });
});
