import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import XLSX from 'xlsx';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { createApp } from '../src/app.js';

const TEST_DB = 'bigstar_vdp_test';
const skip = !process.env.MONGO_URI && 'MONGO_URI not set';
let server;
let base;
let cookie = '';

async function call(method, url, body, form) {
  const headers = { cookie };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const response = await fetch(`${base}/api${url}`, { method, headers, body: payload });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: response.status, data: (response.headers.get('content-type') || '').includes('json') ? await response.json() : null };
}

const workbook = (rows) => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Uber');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
};

const WITT = {
  Week: '2026-09-07', Driver_UUID: '68f0b1e8-da78-4d64-b477-0f1b68333483', First_Name: 'MARY', Last_Name: 'WITT',
  'Total Supply Hours': 52.86, 'Paused Hours': 0.46, 'Core Hours_Total Supply Hours': 36.58, 'Utilized Hours': 45.6,
  Total_Accepts: 110, Total_Rejects: 0, Total_Expired_Offers: 0, Total_Cancels: 5,
  Driver_Earnings_Excl_Tips: 1121, Driver_Tips: 57,
};

before(async () => {
  if (skip) return;
  await connectDb(TEST_DB);
  assert.equal(mongoose.connection.name, TEST_DB);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call('POST', '/auth/setup', { name: 'Uber Admin', email: 'uber@test.local', password: 'correct-horse-1' })).status, 201);
});

after(async () => {
  if (skip) return;
  server?.close();
  await disconnectDb();
});

test('Uber plan, upload, processing, weekly adjustment, and audit snapshot', { skip }, async () => {
  let response = await call('POST', '/divisions', { divisionNumber: 'UB', name: 'Uber Services', timezone: 'America/Los_Angeles' });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const division = response.data;

  response = await call('POST', '/vdp-plans', {
    divisionId: division._id,
    name: 'Uber Provider Plan',
    version: { calculationType: 'UBER', effectiveFrom: '2026-09-07' },
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const plan = response.data;
  assert.equal(plan.versions[0].calculationType, 'UBER');
  assert.equal(plan.versions[0].basePay, null);
  assert.equal(plan.versions[0].contractedHours, null);
  assert.equal(plan.versions[0].uberConfig.coreRatePct, '0.65');

  response = await call('POST', '/providers', {
    divisionId: division._id, name: 'Mary Witt LLC', planId: plan._id,
    overrides: { basePay: '32.50' },
    operators: [{ name: 'Mary Witt', contractedHours: '50', routes: [], liftLease: { frequency: 'NONE' } }],
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.equal(response.data.operators[0].uberDriverUuid, undefined);
  assert.equal(response.data.operators[0].basePay, null);
  assert.equal(response.data.paymentSettings.basePay.value, '32.5');
  assert.equal(response.data.paymentSettings.basePay.source, 'PROVIDER_PROFILE');
  const operator = response.data.operators[0];

  response = await call('POST', '/cycles/generate', { fromDate: '2026-09-07', count: 1 });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const cycle = response.data.created.find((item) => String(item.divisionId) === String(division._id));
  assert.ok(cycle);

  const validForm = new FormData();
  validForm.append('cycleId', cycle._id);
  validForm.append('files', new Blob([workbook([WITT])]), '9.07.26 - 9.14.26.xlsx');
  response = await call('POST', '/uber-performance-imports', undefined, validForm);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.equal(response.data.files[0].validationStatus, 'VALID');
  assert.equal(response.data.files[0].rowCount, 1);

  const malformed = { ...WITT, Week: '2026-09-14', 'Utilized Hours': 'not-a-number' };
  const invalidForm = new FormData();
  invalidForm.append('cycleId', cycle._id);
  invalidForm.append('files', new Blob([workbook([malformed])]), 'bad.xlsx');
  response = await call('POST', '/uber-performance-imports', undefined, invalidForm);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.equal(response.data.files[0].validationStatus, 'INVALID');
  assert.match(response.data.files[0].processingErrors.join(' '), /Utilized Hours/);
  const invalidUploadId = response.data.files[0]._id;

  response = await call('DELETE', `/uber-performance-imports/${invalidUploadId}`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.deleted, true);
  assert.equal(response.data.status, 'DELETED');
  response = await call('GET', `/uber-performance-imports?cycleId=${cycle._id}`);
  assert.equal(response.data.some((file) => file._id === invalidUploadId), false);

  const retryInvalidForm = new FormData();
  retryInvalidForm.append('cycleId', cycle._id);
  retryInvalidForm.append('files', new Blob([workbook([malformed])]), 'bad-again.xlsx');
  response = await call('POST', '/uber-performance-imports', undefined, retryInvalidForm);
  assert.equal(response.data.files[0].validationStatus, 'INVALID');
  response = await call('DELETE', `/uber-performance-imports/invalid?cycleId=${cycle._id}`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.deletedCount, 1);
  response = await call('GET', `/uber-performance-imports?cycleId=${cycle._id}`);
  assert.equal(response.data.every((file) => file.validationStatus === 'VALID'), true);

  response = await call('GET', `/cycles/${cycle._id}`);
  assert.equal(response.data.uberPerformance.activeFileCount, 1);
  assert.equal(response.data.uberPerformance.unresolvedCount, 0);
  assert.equal(response.data.uberPerformance.driverMatches[0].status, 'MATCHED');
  assert.equal(response.data.uberPerformance.driverMatches[0].matchMethod, 'AUTO_EXACT_NAME');

  response = await call('POST', '/vdps/process', { cycleId: cycle._id });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.ready, 1);
  const list = (await call('GET', `/vdps?cycleId=${cycle._id}`)).data;
  let vdp = (await call('GET', `/vdps/${list[0]._id}`)).data;
  assert.equal(vdp.status, 'READY', JSON.stringify(vdp.exceptions));
  assert.equal(vdp.view.calculation.calculationType, 'UBER');
  assert.equal(vdp.view.calculation.gross, '1600.75');
  assert.equal(vdp.view.calculation.uberRows[0].grossVdp, '1600.75');
  assert.equal(vdp.view.calculation.uberRows[0].settingsUsed.baseHourlyRate, '32.5');
  assert.equal(vdp.view.calculation.uberRows[0].settingsUsed.baseHourlyRateSource, 'PROVIDER_PROFILE');
  assert.equal(vdp.view.calculation.uberRows[0].settingsUsed.contractedWeeklyHours, '50');
  assert.equal(vdp.view.calculation.uberRows[0].settingsUsed.contractedWeeklyHoursSource, 'OPERATOR_PROFILE');

  response = await call('PUT', `/vdps/${vdp._id}/uber-weekly-adjustment`, {
    driverUuid: vdp.view.calculation.uberRows[0].driverUuid,
    week: '2026-09-07',
    approvedExtraHours: '',
    passThroughs: [{ type: 'TOLL', amount: '21' }],
  });
  assert.equal(response.status, 400);
  assert.match(response.data.error, /Enter Uber tolls in Adjustments/);

  response = await call('POST', `/vdps/${vdp._id}/adjustments`, {
    type: 'TOLL', amount: '21', operatorId: operator.id, week: '2026-09-07', description: 'Uber toll pass-through',
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  vdp = response.data;
  assert.equal(vdp.view.calculation.gross, '1621.75');
  assert.equal(vdp.view.calculation.adjustmentTolls, '21.00');
  assert.equal(vdp.view.adjustments[0].operatorName, 'Mary Witt');
  assert.equal(vdp.view.adjustments[0].tollDirection, 'CREDIT');

  response = await call('POST', `/vdps/${vdp._id}/adjustments`, {
    type: 'TOLL', amount: '5', operatorId: operator.id, week: '2026-09-07',
    tollDirection: 'DEDUCTION', description: 'Provider toll bill',
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  vdp = response.data;
  assert.equal(vdp.view.calculation.gross, '1621.75');
  assert.equal(vdp.view.calculation.adjustmentTollDeductions, '5.00');
  assert.equal(vdp.view.calculation.totalDeductions, '5.00');
  assert.equal(vdp.view.calculation.net, '1616.75');
  assert.equal(vdp.view.adjustments[1].tollDirection, 'DEDUCTION');

  response = await call('POST', `/vdps/${vdp._id}/approve`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  vdp = response.data;
  assert.equal(vdp.view.source, 'SNAPSHOT');
  assert.equal(vdp.view.settings.uberConfig.value.coreRatePct, '0.65');
  assert.equal(vdp.view.uberPerformanceImports.length, 1);
  assert.equal(vdp.view.calculation.uberRows[0].raw.totalSupplyHours, '52.86');
  assert.equal(vdp.view.calculation.uberRows[0].grossVdp, '1600.75');
  assert.equal(vdp.view.calculation.gross, '1621.75');
  assert.equal(vdp.view.calculation.net, '1616.75');
  assert.equal(vdp.view.adjustments[1].operatorName, 'Mary Witt');
  assert.equal(vdp.view.adjustments[1].week, '2026-09-07');
  assert.equal(vdp.view.adjustments[1].tollDirection, 'DEDUCTION');
});
