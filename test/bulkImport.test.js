// Bulk import (divisions / VDP plans / providers) through the REST API against a real MongoDB.
// Uses bigstar_vdp_test, dropped at the start of the run.
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../scripts/seed.js';
import Provider from '../src/models/Provider.js';
import VdpPlan from '../src/models/VdpPlan.js';
import Division from '../src/models/Division.js';

const TEST_DB = 'bigstar_vdp_test';
const skip = !process.env.MONGO_URI && 'MONGO_URI not set';
let server;
let base;
let cookie = '';

async function call(method, url, { json, form } = {}) {
  const headers = { cookie };
  let body;
  if (form) body = form;
  else if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(`${base}/api${url}`, { method, headers, body });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

async function template(kind) {
  const r = await call('GET', `/imports/${kind}/template`);
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.data);
  return wb;
}

// Writes rows under the template headers (matched by header text, "*" ignored).
function fill(wb, sheet, rows) {
  const ws = wb.getWorksheet(sheet);
  const cols = {};
  ws.getRow(1).eachCell((c, n) => { cols[String(c.value).replace(' *', '')] = n; });
  rows.forEach((row, i) => {
    for (const [header, value] of Object.entries(row)) {
      assert.ok(cols[header], `template column "${header}" on ${sheet}`);
      ws.getRow(i + 2).getCell(cols[header]).value = value;
    }
  });
  return ws;
}

async function upload(kind, step, wb) {
  const form = new FormData();
  form.append('file', new Blob([await wb.xlsx.writeBuffer()]), `${kind}.xlsx`);
  return call('POST', `/imports/${kind}/${step}`, { form });
}

const byRow = (data) => Object.fromEntries(data.rows.map((r) => [r.row, r]));

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
  const r = await call('POST', '/auth/setup', { json: { name: 'Import Admin', email: 'import@test.local', password: 'correct-horse-1' } });
  assert.equal(r.status, 201);
});

after(async () => {
  if (skip) return;
  server?.close();
  await disconnectDb();
});

test('bulk import', { skip }, async (t) => {
  await t.test('template has drop-downs, instructions and the existing records', async () => {
    const wb = await template('providers');
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Instructions', 'Providers', 'Existing providers', 'Lists']);
    const ws = wb.getWorksheet('Providers');
    assert.equal(ws.getCell('A1').value, 'Division *');
    assert.equal(ws.getCell('A2').dataValidation.type, 'list');
    const lists = wb.getWorksheet('Lists');
    assert.equal(lists.state, 'veryHidden');
    assert.equal(lists.getCell('A2').value, 'DIV 10 – Portland');
    assert.ok(wb.getWorksheet('Existing providers').getColumn(2).values.includes('Rimo Transit LLC'));
    const unknown = await call('GET', '/imports/widgets/template');
    assert.equal(unknown.status, 404);
  });

  await t.test('divisions: new, existing and invalid rows', async () => {
    const wb = await template('divisions');
    fill(wb, 'Divisions', [
      { 'Division number': '20', 'Division name': 'Salem', 'Time zone': 'America/Los_Angeles' },
      { 'Division number': '10', 'Division name': 'Portland Metro' },
      { 'Division number': '30', 'Division name': 'Eugene', 'Time zone': 'Mars/Olympus' },
    ]);
    const r = await upload('divisions', 'commit', wb);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const rows = byRow(r.data);
    assert.equal(rows[2].status, 'CREATED');
    assert.equal(rows[3].status, 'EXISTS');
    assert.deepEqual(rows[3].differences, [{ field: 'Name', file: 'Portland Metro', system: 'Portland' }]);
    assert.equal(rows[4].status, 'ERROR');
    assert.match(rows[4].errors[0], /Time zone/);
    assert.equal((await Division.findOne({ divisionNumber: '10' })).name, 'Portland', 'existing division untouched');
    assert.ok(await Division.exists({ divisionNumber: '20' }));
  });

  await t.test('plans: tiers from the TUI sheet, existing plan skipped', async () => {
    const wb = await template('plans');
    fill(wb, 'VDP Plans', [
      { Division: 'DIV 20 – Salem', 'Plan name': 'Salem Hourly', 'Payment type': 'Hourly', 'Base pay ($)': 25.97, 'Contracted hours per week': 40, 'Effective from': new Date(Date.UTC(2026, 7, 24)), 'TUI eligible': 'Yes', 'Fuel reimbursement': 'Yes', 'Fuel reimbursement ($/trip)': 2.5 },
      { Division: 'DIV 20 – Salem', 'Plan name': 'Salem fuel no rate', 'Payment type': 'Per trip', 'Base pay ($)': 21.5, 'Effective from': '2026-08-24', 'Fuel reimbursement': 'Yes' },
      { Division: 'DIV 10 – Portland', 'Plan name': 'Night Service', 'Payment type': 'Hourly', 'Base pay ($)': 26, 'Effective from': '2026-08-24' },
      { Division: 'DIV 20 – Salem', 'Plan name': 'Salem TUI no tiers', 'Payment type': 'Hourly', 'Base pay ($)': 25, 'Contracted hours per week': 40, 'Effective from': '2026-08-24', 'TUI eligible': 'Yes' },
    ]);
    const tiers = fill(wb, 'TUI Tiers', [
      { Division: 'DIV 20 – Salem', 'Plan name': 'Salem Hourly', 'From %': 0, 'To %': 79.99, 'Rate ($)': 25.97 },
      { Division: 'DIV 20 – Salem', 'Plan name': 'Salem Hourly', 'From %': 0.8, 'Rate ($)': 28.8556 },
      { Division: 'DIV 20 – Salem', 'Plan name': 'Nope', 'From %': 0, 'Rate ($)': 1 },
    ]);
    tiers.getCell('C3').numFmt = '0%'; // typed as a percentage: 0.8 → 80

    let r = await upload('plans', 'preview', wb);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.summary.new, 1);
    assert.equal(await VdpPlan.countDocuments({ name: 'Salem Hourly' }), 0, 'preview saves nothing');

    r = await upload('plans', 'commit', wb);
    const rows = byRow(r.data);
    assert.equal(rows[2].status, 'CREATED');
    assert.equal(rows[3].status, 'ERROR');
    assert.match(rows[3].errors.join(' '), /Fuel reimbursement rate/);
    assert.equal(rows[4].status, 'EXISTS');
    assert.deepEqual(rows[4].differences.map((d) => d.field), ['Base pay']);
    assert.equal(rows[5].status, 'ERROR');
    assert.match(rows[5].errors.join(' '), /TUI Tiers/);
    assert.match(r.data.notes.join(' '), /Nope/);
    const plan = await VdpPlan.findOne({ name: 'Salem Hourly' });
    assert.deepEqual([plan.versions[0].fuelReimbursementEnabled, plan.toJSON().versions[0].fuelReimbursementRate], [true, '2.5']);
    assert.deepEqual(plan.toJSON().versions[0].incentiveTiers.map((x) => [x.minimumPercentage, x.maximumPercentage, x.rate]), [['0', '79.99', '25.97'], ['80', null, '28.8556']]);
    assert.equal((await VdpPlan.findOne({ name: 'Night Service' })).toJSON().versions[0].basePay, '25.97', 'existing plan untouched');
  });

  await t.test('providers: new, existing (not replaced), duplicate, invalid, shared route', async () => {
    const wb = await template('providers');
    const planList = wb.getWorksheet('Lists').getColumn(2).values;
    assert.ok(planList.includes('DIV 20 | Salem Hourly'), 'plans imported earlier appear in a fresh template');
    fill(wb, 'Providers', [
      { Division: 'DIV 10 – Portland', 'Provider name': 'New Co LLC', 'Provider number': '20001', 'Route / run': '950', 'VDP plan': 'DIV 10 | Night Service', 'Base pay override ($)': 29.75, 'Lift lease frequency': 'Weekly', 'Lift lease amount ($)': 197.5 },
      { Division: 'DIV 10 – Portland', 'Provider name': 'Rimo Transit LLC', 'Provider number': '10063', 'Route / run': '999' },
      { Division: 'DIV 10 – Portland', 'Provider name': 'New Co LLC', 'Provider number': '20001' },
      { Division: 'DIV 10 – Portland', 'Provider name': 'Wrong Plan LLC', 'VDP plan': 'DIV 20 | Salem Hourly' },
      { Division: 'DIV 10 – Portland', 'Provider name': 'Shares 918 LLC', 'Route / run': '918', 'VDP plan': 'DIV 10 | Night Service', 'TUI eligibility': 'Not eligible' },
      { Division: 'DIV 10 – Portland', 'Provider name': 'Lease No Freq LLC', 'Lift lease amount ($)': 50 },
    ]);
    const before = await Provider.countDocuments();
    let r = await upload('providers', 'preview', wb);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(
      { new: r.data.summary.new, exists: r.data.summary.exists, duplicate: r.data.summary.duplicate, error: r.data.summary.error },
      { new: 2, exists: 1, duplicate: 1, error: 2 },
    );
    assert.equal(await Provider.countDocuments(), before);

    r = await upload('providers', 'commit', wb);
    const rows = byRow(r.data);
    assert.equal(rows[2].status, 'CREATED');
    assert.equal(rows[3].status, 'EXISTS');
    assert.match(rows[3].existing, /matched on provider number/);
    assert.deepEqual(rows[3].differences, [{ field: 'Route / run', file: '999', system: '918' }]);
    assert.equal(rows[4].status, 'DUPLICATE');
    assert.match(rows[5].errors.join(' '), /another division/);
    assert.equal(rows[6].status, 'CREATED');
    assert.match(rows[6].warnings.join(' '), /Route 918 is also assigned to Lisa Moore \(Rimo Transit LLC\)/);
    assert.match(rows[7].errors.join(' '), /frequency is None/);
    assert.equal(await Provider.countDocuments(), before + 2);

    const rimo = await Provider.findOne({ providerNumber: '10063' });
    assert.deepEqual(rimo.routes, ['918'], 'existing provider untouched');
    const created = (await Provider.findOne({ providerNumber: '20001' })).toJSON();
    assert.deepEqual([created.routes, created.operators[0].liftLease.frequency, created.operators[0].liftLease.amount], [['950'], 'WEEKLY', '197.5']);
    assert.equal(created.overrides.basePay, '29.75');
    assert.equal((await Provider.findOne({ name: 'Shares 918 LLC' })).overrides.tuiEligibility, 'OFF');

    r = await upload('providers', 'commit', wb);
    assert.equal(r.data.summary.created, 0, 'uploading the same file twice creates nothing');
    assert.equal(r.data.summary.exists, 4); // every row now matches a provider in the system
  });

  await t.test('providers: several operators on one provider become one provider', async () => {
    const wb = await template('providers');
    const almonte = { Division: 'DIV 10 – Portland', 'Provider name': 'Almonte Logistics LLC', 'Provider number': '30001' };
    fill(wb, 'Providers', [
      { ...almonte, Operator: 'Ana Almonte', 'Route / run': '960', 'Lift lease frequency': 'Weekly', 'Lift lease amount ($)': 197.5, 'VDP plan': 'DIV 10 | Night Service' },
      { ...almonte, Operator: 'Ben Cruz', 'Route / run': '961', 'Lift lease frequency': 'Weekly', 'Lift lease amount ($)': 150, 'Operator contracted hours': 30 },
      { ...almonte, Operator: 'Ben Cruz', 'Route / run': '961' },
      { ...almonte, Operator: 'Cy Bad Lease', 'Lift lease amount ($)': 10 },
      { Division: 'DIV 10 – Portland', 'Provider name': 'Rimo Transit LLC', 'Provider number': '10063', Operator: 'New Driver', 'Route / run': '962' },
    ]);
    const r = await upload('providers', 'commit', wb);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const rows = byRow(r.data);
    assert.equal(rows[2].status, 'CREATED');
    assert.equal(rows[3].status, 'CREATED');
    assert.match(rows[3].warnings[0], /Another operator of the provider on row 2/);
    assert.equal(rows[4].status, 'DUPLICATE');
    assert.equal(rows[5].status, 'ERROR');
    assert.equal(rows[6].status, 'EXISTS');
    assert.equal(rows[6].differences[0].field, 'Operator');
    assert.match(rows[6].existing, /New Driver is not on this provider/);

    const p = (await Provider.findOne({ providerNumber: '30001' })).toJSON();
    assert.equal(await Provider.countDocuments({ name: 'Almonte Logistics LLC' }), 1);
    assert.deepEqual(p.operators.map((o) => [o.name, o.routes, o.liftLease.amount, o.contractedHours]), [
      ['Ana Almonte', ['960'], '197.5', null],
      ['Ben Cruz', ['961'], '150', '30'],
    ]);
    assert.deepEqual(p.routes, ['960', '961']);
    assert.equal(p.operatorName, 'Ana Almonte, Ben Cruz');
    assert.deepEqual((await Provider.findOne({ providerNumber: '10063' })).routes, ['918'], 'existing provider untouched');
  });
});
