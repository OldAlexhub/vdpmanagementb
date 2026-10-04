// End-to-end regression through the REST API against a real MongoDB.
// Uses its own database (bigstar_vdp_test) which is dropped at the start of each run.
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
import VdpCycle from '../src/models/VdpCycle.js';
import { autoApproveDue } from '../src/services/vdpService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(here, 'fixtures', 'performance-report-2026-08-01_to_09-09.xlsx');
const TEST_DB = 'bigstar_vdp_test';
const skip = !process.env.MONGO_URI && 'MONGO_URI not set';

let server;
let base;
const staff = { cookie: '' };
const providerJar = { cookie: '' };

async function call(method, url, body, { form, jar = staff } = {}) {
  const headers = { cookie: jar.cookie };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}/api${url}`, { method, headers, body: payload });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jar.cookie = setCookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data };
}

const uploadForm = (cycleId, extra = {}) => {
  const form = new FormData();
  form.append('cycleId', cycleId);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append('file', new Blob([fs.readFileSync(REPORT)]), 'Report_Para_Operations1 (2).xlsx');
  return form;
};

before(async () => {
  if (skip) return;
  assert.ok(TEST_DB.endsWith('_test'));
  await connectDb(TEST_DB);
  assert.equal(mongoose.connection.name, TEST_DB); // never drop anything else
  await mongoose.connection.dropDatabase();
  await connectDb(TEST_DB).catch(() => {}); // re-sync indexes after drop
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  await seed({ log: () => {} });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (skip) return;
  server?.close();
  await disconnectDb();
});

test('DIV 10 end-to-end regression — RIMO / route 918 / 08/24–09/06/2026', { skip }, async (t) => {
  let r = await call('GET', '/auth/status');
  assert.equal(r.data.needsSetup, true);
  r = await call('POST', '/auth/setup', { name: 'Test Admin', email: 'admin@test.local', password: 'correct-horse-1' });
  assert.equal(r.status, 201);

  const { data: divisions } = await call('GET', '/divisions');
  const div10 = divisions.find((d) => d.divisionNumber === '10');
  assert.ok(div10);

  let cycleId;
  await t.test('cycle generation', async () => {
    r = await call('POST', '/cycles/generate', { divisionId: div10._id, fromDate: '2026-08-27', count: 1 });
    assert.equal(r.status, 201);
    const c = r.data.created[0];
    cycleId = c._id;
    assert.equal(c.cycleStart.slice(0, 10), '2026-08-24');
    assert.equal(c.cycleEnd.slice(0, 10), '2026-09-06');
    assert.equal(c.week1End.slice(0, 10), '2026-08-30');
    assert.equal(c.week2Start.slice(0, 10), '2026-08-31');
    assert.equal(c.submissionDate.slice(0, 10), '2026-09-21'); // contract 2026 schedule
    assert.equal(c.paymentDate.slice(0, 10), '2026-09-25');
    r = await call('POST', '/cycles/generate', { divisionId: div10._id, fromDate: '2026-08-24', count: 1 });
    assert.equal(r.data.created.length, 0);
    assert.equal(r.data.existing, 1);
  });

  await t.test('processing is blocked until the report is uploaded', async () => {
    r = await call('POST', '/vdps/process', { cycleId });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Upload the Performance Report/);
  });

  let importId;
  await t.test('upload, duplicate detection, replacement confirmation', async () => {
    r = await call('POST', '/performance-imports', undefined, { form: uploadForm(cycleId) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    importId = r.data._id;
    assert.equal(r.data.rowCount, 187);
    assert.equal(r.data.dataRange.from, '2026-08-24');
    assert.equal(r.data.dataRange.to, '2026-09-06');
    assert.equal(r.data.detectedColumns.TOTAL_HOURS, true);

    r = await call('POST', '/performance-imports', undefined, { form: uploadForm(cycleId) });
    assert.equal(r.status, 409);
    assert.equal(r.data.details.code, 'DUPLICATE_UPLOAD');
    r = await call('POST', '/performance-imports', undefined, { form: uploadForm(cycleId, { replace: 'true', replaceReason: 'x' }) });
    assert.equal(r.status, 409, 'same file is still a duplicate even when replacing');
    const { data: imports } = await call('GET', `/performance-imports?cycleId=${cycleId}`);
    assert.equal(imports.length, 1);
  });

  await t.test('unknown routes must be resolved before processing (no guessing)', async () => {
    r = await call('POST', '/vdps/process', { cycleId });
    assert.equal(r.status, 409);
    assert.equal(r.data.details.code, 'UNRESOLVED_ROUTES');
    const unknown = r.data.details.routes.map((x) => x.route).sort();
    assert.deepEqual(unknown, ['900', '902', '912', '913', '914', '915', '919']);
    for (const route of unknown) {
      r = await call('POST', `/performance-imports/${importId}/routes`, { route, action: 'IGNORE', note: 'Open run in regression' });
      assert.equal(r.status, 200);
    }
    r = await call('POST', '/vdps/process', { cycleId });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.processed, 13);
  });

  const { data: list } = await call('GET', `/vdps?cycleId=${cycleId}`);
  const rimoRow = list.find((v) => v.provider.name === 'Rimo Transit LLC');
  assert.deepEqual(rimoRow.weeks.map((week) => [week.weekNumber, week.weeklyEarnings]), [[1, '1475.33'], [2, '1162.36']]);
  let rimo;

  await t.test('RIMO calculation matches the verified regression', async () => {
    rimo = (await call('GET', `/vdps/${rimoRow._id}`)).data;
    assert.equal(rimo.status, 'READY', JSON.stringify(rimo.exceptions));
    const [w1, w2] = rimo.view.calculation.weeks;
    assert.equal(rimo.view.settings.performanceHourMetric.value, 'TOTAL_HOURS');
    assert.equal(w1.trips, '46');
    assert.equal(w2.trips, '37');
    assert.equal(w1.actualHours, '49.27');
    assert.equal(w2.actualHours, '40.23');
    assert.equal((Number(w1.actualHours) * 100 + Number(w2.actualHours) * 100) / 100, 89.5);
    assert.equal(w1.contractedHours, '40');
    assert.equal(w1.performancePercentage, '123.175');
    assert.equal(w1.incentiveRate, '28.86');
    assert.equal(w1.bonusHours, '9.27');
    assert.equal(w1.coreEarnings, '1154.40');
    assert.equal(w1.bonusEarnings, '320.93');
    assert.equal(w1.weeklyEarnings, '1475.33');
    assert.equal(w2.bonusHours, '0.23');
    assert.equal(w2.weeklyEarnings, '1162.36');
    assert.equal(rimo.view.calculation.gross, '2637.69');
    assert.equal(rimo.view.calculation.lease, '395.00');
    assert.equal(rimo.view.calculation.net, '2242.69');
    assert.ok(rimo.view.calculation.weeks[0].explanation.some((l) => l.includes('9.27 × $34.62 = $320.93')));
  });

  await t.test('AM route is per trip at $21.50 with no TUI', async () => {
    const al = list.find((v) => v.provider.name === 'AL Care Clean Transitions LLC');
    const d = (await call('GET', `/vdps/${al._id}`)).data;
    const trips = d.view.calculation.weeks.reduce((s, w) => s + Number(w.trips), 0);
    assert.equal(d.view.settings.tuiEligible.value, false);
    assert.equal(d.view.calculation.gross, (trips * 21.5).toFixed(2));
  });

  await t.test('manual adjustments', async () => {
    r = await call('POST', `/vdps/${rimo._id}/adjustments`, { type: 'FARES', amount: '25.20', description: '9 cash fares' });
    assert.equal(r.status, 200);
    assert.equal(r.data.view.calculation.net, '2217.49');
    r = await call('POST', `/vdps/${rimo._id}/adjustments`, { type: 'REIMBURSEMENT', amount: '-5' });
    assert.equal(r.status, 400);

    // Removing an adjustment takes it off the VDP (and it stays off on reload).
    r = await call('POST', `/vdps/${rimo._id}/adjustments`, { type: 'TOLL', amount: '10.00' });
    const toll = r.data.view.adjustments.find((a) => a.type === 'TOLL');
    assert.ok(toll?._id);
    r = await call('DELETE', `/vdps/${rimo._id}/adjustments/${toll._id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.view.adjustments.some((a) => a.type === 'TOLL'), false);
    r = await call('GET', `/vdps/${rimo._id}`);
    assert.equal(r.data.view.adjustments.some((a) => a.type === 'TOLL'), false);
    assert.equal(r.data.view.calculation.net, '2217.49');
  });

  await t.test('TUI can be switched off for a provider and back on', async () => {
    const provider = (await call('GET', `/providers?search=Rimo`)).data[0];
    await call('PUT', `/providers/${provider._id}`, { overrides: { tuiEligibility: 'OFF' } });
    r = await call('POST', `/vdps/${rimo._id}/recalculate`);
    assert.equal(r.data.view.calculation.weeks[0].incentiveRate, '25.97');
    assert.equal(r.data.view.settings.tuiEligible.source, 'PROVIDER_OVERRIDE');
    await call('PUT', `/providers/${provider._id}`, { overrides: { tuiEligibility: 'INHERIT' } });
    r = await call('POST', `/vdps/${rimo._id}/recalculate`);
    assert.equal(r.data.view.calculation.weeks[0].incentiveRate, '28.86');
  });

  await t.test('Big Star approval freezes a snapshot and sends the VDP to the provider', async () => {
    // Keep the provider window open for this test (the real 08/24 cycle closed on 09/21/2026).
    await VdpCycle.updateOne({ _id: cycleId }, { submissionDate: new Date('2099-01-05T00:00:00Z') });
    r = await call('POST', `/vdps/${rimo._id}/approve`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, 'APPROVED');
    assert.equal(r.data.view.source, 'SNAPSHOT');
    assert.equal(r.data.view.net, '2217.49');
    assert.equal(r.data.providerDeadline, '2099-01-06T08:00:00.000Z'); // end of 01/05 in Portland (PST)

    const provider = (await call('GET', `/providers?search=Rimo`)).data[0];
    await call('PUT', `/providers/${provider._id}`, { overrides: { contractedHours: '35' } });
    const plan = (await call('GET', `/vdp-plans?divisionId=${div10._id}`)).data.find((p) => p.name === 'Night Service');
    const version = plan.versions[0];
    assert.equal(version.locked, true);
    r = await call('PUT', `/vdp-plans/${plan._id}/versions/${version._id}`, { ...version, basePay: '30' });
    assert.equal(r.status, 409, 'approved VDP locks its plan version');
    r = await call('POST', `/vdp-plans/${plan._id}/versions`, { ...version, effectiveFrom: '2027-01-01', basePay: '26.50',
      incentiveTiers: version.incentiveTiers.map((t2, i) => ({ ...t2, rate: i === 0 ? '26.50' : t2.rate })) });
    assert.equal(r.status, 201, JSON.stringify(r.data));

    const after = (await call('GET', `/vdps/${rimo._id}`)).data;
    assert.equal(after.view.settings.contractedHours.value, '40');
    assert.equal(after.view.calculation.gross, '2637.69');
    r = await call('POST', `/vdps/${rimo._id}/adjustments`, { type: 'FUEL', amount: '1' });
    assert.equal(r.status, 409, 'approved VDPs are read-only');
    r = await call('POST', `/vdps/${rimo._id}/mark-paid`);
    assert.equal(r.status, 409, 'cannot pay before the provider approves');
  });

  await t.test('reopen requires a reason and keeps history', async () => {
    r = await call('POST', `/vdps/${rimo._id}/reopen`, {});
    assert.equal(r.status, 400);
    r = await call('POST', `/vdps/${rimo._id}/reopen`, { reason: 'Contract hours corrected to 35' });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'READY');
    assert.equal(r.data.providerDeadline, null);
    assert.equal(r.data.view.settings.contractedHours.value, '35');
    assert.equal(r.data.view.settings.contractedHours.source, 'PROVIDER_OVERRIDE');
    const reopened = r.data.history.find((h) => h.action === 'REOPENED');
    assert.equal(reopened.reason, 'Contract hours corrected to 35');
    assert.equal(reopened.previousSnapshot.net, '2217.49');
    // Back to the contract, re-approve and send to the provider again.
    const provider = (await call('GET', `/providers?search=Rimo`)).data[0];
    await call('PUT', `/providers/${provider._id}`, { overrides: { contractedHours: '' } });
    r = await call('POST', `/vdps/${rimo._id}/approve`);
    assert.equal(r.data.status, 'APPROVED');
    assert.equal(r.data.view.net, '2217.49');
  });

  await t.test('provider portal: sees only their own approved statement and approves it', async () => {
    const provider = (await call('GET', `/providers?search=Rimo`)).data[0];
    r = await call('POST', '/users', { name: 'Rimo Transit', email: 'rimo@portal.test', password: 'rimo-portal-1', role: 'PROVIDER', providerId: provider._id });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const staffList = (await call('GET', '/users')).data;
    assert.ok(!staffList.some((u) => u.role === 'PROVIDER'), 'provider logins are not listed as staff');

    r = await call('POST', '/auth/login', { email: 'rimo@portal.test', password: 'rimo-portal-1' }, { jar: providerJar });
    assert.equal(r.status, 200);
    r = await call('GET', '/auth/me', undefined, { jar: providerJar });
    assert.equal(r.data.role, 'PROVIDER');
    assert.equal(r.data.providerName, 'Rimo Transit LLC');

    // Staff API is closed to provider logins.
    for (const url of ['/vdps', '/providers', `/vdps/${rimo._id}`, '/divisions', '/users']) {
      assert.equal((await call('GET', url, undefined, { jar: providerJar })).status, 403, url);
    }
    // Another provider's VDP is invisible, even by id.
    const other = list.find((v) => v.provider.name === 'G1Business LLC');
    assert.equal((await call('GET', `/portal/vdps/${other._id}`, undefined, { jar: providerJar })).status, 404);
    assert.equal((await call('POST', `/portal/vdps/${other._id}/approve`, undefined, { jar: providerJar })).status, 404);
    // Staff logins cannot use the portal API.
    assert.equal((await call('GET', '/portal/vdps')).status, 403);

    r = await call('GET', '/portal/vdps', undefined, { jar: providerJar });
    assert.equal(r.data.length, 1);
    assert.equal(r.data[0].status, 'APPROVED');
    r = await call('GET', `/portal/vdps/${rimo._id}`, undefined, { jar: providerJar });
    assert.equal(r.data.view.net, '2217.49');
    assert.equal(r.data.view.calculation.weeks[0].weeklyEarnings, '1475.33');
    assert.equal(r.data.view.performanceImport, undefined, 'internal file details are not exposed');
    assert.equal(r.data.view.adjustments[0].createdBy, undefined, 'staff names are not exposed');

    r = await call('POST', `/portal/vdps/${rimo._id}/approve`, undefined, { jar: providerJar });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'PROCESSED');
    assert.equal(r.data.providerApproval.method, 'PROVIDER');
    r = await call('POST', `/portal/vdps/${rimo._id}/approve`, undefined, { jar: providerJar });
    assert.equal(r.status, 409, 'cannot approve twice');

    // Back in the admin portal: processed, waiting only to be marked paid.
    r = await call('GET', `/vdps/${rimo._id}`);
    assert.equal(r.data.status, 'PROCESSED');
    assert.equal(r.data.providerApproval.by.name, 'Rimo Transit');
    assert.ok(r.data.history.some((h) => h.action === 'PROVIDER_APPROVED'));
    r = await call('POST', `/vdps/${rimo._id}/mark-paid`);
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'PAID');
    r = await call('GET', `/portal/vdps/${rimo._id}`, undefined, { jar: providerJar });
    assert.equal(r.data.status, 'PAID');
  });

  await t.test('no provider response by the Closed for Submission date → auto-approved', async () => {
    const g1 = list.find((v) => v.provider.name === 'G1Business LLC');
    r = await call('POST', `/vdps/${g1._id}/approve`);
    assert.equal(r.data.status, 'APPROVED');
    assert.equal(await autoApproveDue(new Date('2099-01-06T07:59:59Z')), 0, 'still open on the last day');
    assert.equal(await autoApproveDue(new Date('2099-01-06T08:00:00Z')), 1);
    r = await call('GET', `/vdps/${g1._id}`);
    assert.equal(r.data.status, 'PROCESSED');
    assert.equal(r.data.providerApproval.method, 'AUTO');
    assert.ok(r.data.history.some((h) => h.action === 'AUTO_APPROVED'));
  });

  await t.test('provider reports an issue: exactly what is wrong and why; Big Star answers or corrects', async () => {
    const dire = list.find((v) => v.provider.name === 'Dire LLC');
    const direProvider = (await call('GET', '/providers?search=Dire')).data[0];
    const jar = { cookie: '' };
    await call('POST', '/users', { name: 'Kemal (Dire LLC)', email: 'dire@portal.test', password: 'dire-portal-1', role: 'PROVIDER', providerId: direProvider._id });
    await call('POST', '/auth/login', { email: 'dire@portal.test', password: 'dire-portal-1' }, { jar });

    r = await call('POST', `/vdps/${dire._id}/approve`);
    assert.equal(r.data.status, 'APPROVED');
    const netBefore = r.data.view.net;

    // Validation: needs a clear reason.
    r = await call('POST', `/portal/vdps/${dire._id}/issues`, { items: [{ area: 'TRIPS', week: 1, reason: '' }] }, { jar });
    assert.equal(r.status, 400);
    r = await call('POST', `/portal/vdps/${dire._id}/issues`, { items: [] }, { jar });
    assert.equal(r.status, 400);

    r = await call('POST', `/portal/vdps/${dire._id}/issues`, {
      comment: 'Please check before paying.',
      items: [
        { area: 'TRIPS', week: 1, expectedValue: '66 trips', reason: 'Two trips on 08/27 are missing from the report', shownValue: 'forged' },
        { area: 'LIFT_LEASE', expectedValue: '$197.50', reason: 'I returned the lift vehicle on 08/31' },
      ],
    }, { jar });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, 'DISPUTED');
    const [trips, lease] = r.data.issues[0].items;
    assert.match(trips.shownValue, /^\d+ trips$/, 'shown value comes from the statement, not the client');
    assert.equal(lease.shownValue, '$395.00');
    assert.equal(trips.areaLabel, 'Trips');

    // Paused: cannot approve, cannot pay, and it is not auto-approved.
    assert.equal((await call('POST', `/portal/vdps/${dire._id}/approve`, undefined, { jar })).status, 409);
    assert.equal((await call('POST', `/vdps/${dire._id}/mark-paid`)).status, 409);
    await autoApproveDue(new Date('2100-01-01T00:00:00Z'));
    r = await call('GET', `/vdps/${dire._id}`);
    assert.equal(r.data.status, 'DISPUTED');
    assert.equal(r.data.issues[0].status, 'OPEN');
    assert.ok(r.data.history.some((h) => h.action === 'ISSUE_RAISED' && h.reason.includes('Two trips on 08/27')));
    const summary = (await call('GET', `/cycles/${cycleId}`)).data;
    assert.equal(summary.vdps.DISPUTED, 1);

    // Big Star answers without change → back to the provider with a fresh review window.
    assert.equal((await call('POST', `/vdps/${dire._id}/issues/respond`, { message: '' })).status, 400);
    r = await call('POST', `/vdps/${dire._id}/issues/respond`, { message: 'Those two trips were cancelled at the door (no-shows), so they are not provided trips.' });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'APPROVED');
    assert.ok(new Date(r.data.providerDeadline) - Date.now() > 47 * 3600 * 1000, 'at least 48h to review the answer');
    r = await call('GET', `/portal/vdps/${dire._id}`, undefined, { jar });
    assert.equal(r.data.issues[0].response.action, 'NO_CHANGE');
    assert.equal(r.data.issues[0].response.by.name, 'Big Star', 'staff names are not shown to providers');

    // Provider still disagrees about the lease → Big Star reopens and corrects it.
    r = await call('POST', `/portal/vdps/${dire._id}/issues`, { items: [{ area: 'LIFT_LEASE', expectedValue: '$197.50', reason: 'Lift returned 08/31 — only one week of lease' }] }, { jar });
    assert.equal(r.data.status, 'DISPUTED');
    r = await call('POST', `/vdps/${dire._id}/reopen`, { reason: 'Lift returned 08/31 — lease corrected to one week.' });
    assert.equal(r.status, 200);
    r = await call('GET', '/portal/vdps', undefined, { jar });
    const row = r.data.find((v) => v._id === dire._id);
    assert.equal(row.status, 'IN_CORRECTION', 'provider can see it is being corrected');
    assert.equal(row.net, null);

    await call('PATCH', `/vdps/${dire._id}/lease`, { weeksCharged: '1', note: 'Lift returned 08/31 (provider issue)' });
    r = await call('POST', `/vdps/${dire._id}/approve`);
    assert.equal(r.data.status, 'APPROVED');
    assert.equal(r.data.view.calculation.lease, '197.50');
    r = await call('GET', `/portal/vdps/${dire._id}`, undefined, { jar });
    const answered = r.data.issues[1];
    assert.equal(answered.status, 'RESOLVED');
    assert.equal(answered.response.action, 'CORRECTED');
    assert.equal(answered.response.message, 'Lift returned 08/31 — lease corrected to one week.');
    assert.equal(answered.netAtRaise, netBefore);
    assert.equal(Number(answered.response.newNet) - Number(netBefore), 197.5);

    r = await call('POST', `/portal/vdps/${dire._id}/approve`, undefined, { jar });
    assert.equal(r.data.status, 'PROCESSED');
  });

  await t.test('approving after the deadline has passed processes immediately', async () => {
    await VdpCycle.updateOne({ _id: cycleId }, { submissionDate: new Date('2026-09-21T00:00:00Z') });
    const al = list.find((v) => v.provider.name === 'AL Care Clean Transitions LLC');
    r = await call('POST', `/vdps/${al._id}/approve`);
    assert.equal(r.data.status, 'PROCESSED');
    assert.equal(r.data.providerApproval.method, 'AUTO');
  });

  await t.test('PDF statement (staff + provider portal) and cycle register', async () => {
    const save = (name, buf) => process.env.PDF_OUT && fs.writeFileSync(path.join(process.env.PDF_OUT, name), Buffer.from(buf));
    const isPdf = (buf) => Buffer.from(buf).subarray(0, 5).toString() === '%PDF-';

    r = await call('GET', `/vdps/${rimo._id}/statement.pdf`);
    assert.equal(r.status, 200);
    assert.ok(isPdf(r.data));
    save('statement-rimo.pdf', r.data);

    const dire = list.find((v) => v.provider.name === 'Dire LLC');
    r = await call('GET', `/vdps/${dire._id}/statement.pdf`);
    assert.ok(isPdf(r.data));
    save('statement-dire-issues.pdf', r.data);

    const draft = list.find((v) => v.provider.name === 'Kings Trans LLC');
    r = await call('GET', `/vdps/${draft._id}/statement.pdf`);
    assert.ok(isPdf(r.data));
    save('statement-draft.pdf', r.data);

    // Provider gets their own statement from the portal, never someone else's.
    r = await call('GET', `/portal/vdps/${rimo._id}/statement.pdf`, undefined, { jar: providerJar });
    assert.equal(r.status, 200);
    assert.ok(isPdf(r.data));
    save('statement-rimo-portal.pdf', r.data);
    assert.equal((await call('GET', `/portal/vdps/${dire._id}/statement.pdf`, undefined, { jar: providerJar })).status, 404);

    r = await call('GET', `/exports/cycles/${cycleId}.pdf`);
    assert.equal(r.status, 200);
    assert.ok(isPdf(r.data));
    save('register.pdf', r.data);
  });

  await t.test('leadership report reconciles with the VDPs; provider dashboard shows only their own data', async () => {
    r = await call('GET', `/reports/leadership?divisionId=${div10._id}&cycles=6`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const rep = r.data;
    if (process.env.PDF_OUT) fs.writeFileSync(path.join(process.env.PDF_OUT, 'leadership.json'), JSON.stringify(rep, null, 2));
    assert.equal(rep.series.length, 1);
    assert.equal(rep.kpis.providers, 13);
    const summary = (await call('GET', `/cycles/${cycleId}`)).data;
    assert.equal(rep.kpis.net, summary.totals.net, 'report net equals the cycle total');
    assert.equal(rep.kpis.gross, summary.totals.gross);
    const rimoRow = rep.scorecard.find((s) => s.name === 'Rimo Transit LLC');
    assert.equal(rimoRow.net, '2217.49');
    assert.equal(rimoRow.hours, '89.5');
    assert.equal(rimoRow.weeksAt100, 2);
    assert.equal(rimoRow.bonusHours, '9.5');
    assert.ok(rep.tiers.some((x) => x.tier === '100%+' && x.weeks >= 2));
    assert.ok(rep.deductions.some((d) => d.key === 'LIFT_LEASE'));
    assert.ok(rep.issues.raised >= 2);
    assert.ok(rep.activity.approvals.some((a) => a.name === 'Test Admin'));
    // Provider logins cannot read leadership reports.
    assert.equal((await call('GET', `/reports/leadership?divisionId=${div10._id}`, undefined, { jar: providerJar })).status, 403);

    r = await call('GET', '/portal/dashboard', undefined, { jar: providerJar });
    assert.equal(r.status, 200);
    assert.equal(r.data.provider.name, 'Rimo Transit LLC');
    assert.equal(r.data.cycles.length, 1);
    assert.equal(r.data.cycles[0].net, '2217.49');
    assert.equal(r.data.weeks.length, 2);
    assert.equal(r.data.weeks[0].hours, 49.27);
    assert.equal(r.data.kpis.all.weeksAt100, 2);
    assert.equal((await call('GET', '/portal/dashboard')).status, 403, 'staff use the leadership report');
  });

  await t.test('export', async () => {
    r = await call('GET', `/exports/cycles/${cycleId}.xlsx`);
    assert.equal(r.status, 200);
    assert.ok(r.data.byteLength > 1000);
  });
});
