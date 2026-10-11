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

const book = (rows) => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Data');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

const duty = (date, id, driverName = 'Future Driver') => ({
  'Driver Name': driverName, Provider: 'Big Star', 'Duty ID': id,
  'Duty Scheduled Start Time': `${date} 08:00:00`, 'Duty Actual Started Time': `${date} 08:00:00`,
  'Duty Scheduled End Time': `${date} 17:00:00`, 'Duty Status': 'completed',
  'First Seen In Service Area Time': `${date} 08:00:00`, 'Last Seen In Service Area Time': `${date} 17:00:00`,
  'Total Duty Duration (hours)': 9, 'Total Scheduled Duty Duration (hours)': 9,
  'Total Revenue Hours': 8, 'Pause Duration while In Progress (min)': 0, 'Total Actual Break (hours)': 0,
});

before(async () => {
  if (skip) return;
  await connectDb(TEST_DB);
  assert.equal(mongoose.connection.name, TEST_DB);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call('POST', '/auth/setup', { name: 'DIV 3 Admin', email: 'div3@test.local', password: 'correct-horse-1' })).status, 201);
});

after(async () => {
  if (skip) return;
  server?.close();
  await disconnectDb();
});

test('DIV 3 stages ADA, GoLink, Uber, fares, and an incomplete NSM return before providers exist', { skip }, async () => {
  let response = await call('POST', '/divisions', { divisionNumber: '3', name: 'Future DIV 3', timezone: 'America/Chicago' });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const division = response.data;
  response = await call('POST', '/divisions', { divisionNumber: '3GL', name: 'Future DIV 3 GoLink', timezone: 'America/Chicago' });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const goLinkDivision = response.data;
  response = await call('PUT', '/settings/processing-groups', {
    groups: [{ name: 'Invalid one-division group', divisionIds: [division._id] }],
  });
  assert.equal(response.status, 400, JSON.stringify(response.data));
  response = await call('PUT', '/settings/processing-groups', {
    groups: [{ name: 'Division 3 – ADA + GoLink', divisionIds: [division._id, goLinkDivision._id] }],
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(response.data[0].divisionIds, [division._id, goLinkDivision._id]);
  response = await call('POST', '/cycles/generate', { fromDate: '2026-09-07', count: 1 });
  assert.equal(response.status, 201, JSON.stringify(response.data));

  const upload = async (kind, files, cycleId = null) => {
    const form = new FormData();
    form.append(cycleId ? 'cycleId' : 'divisionId', cycleId || division._id);
    form.append('kind', kind);
    files.forEach(([name, buffer]) => form.append('files', new Blob([buffer]), name));
    return call('POST', '/division3-imports', undefined, form);
  };

  response = await upload('DIV3_ADA', [
    ['ada-week-1.xlsx', book([duty('2026-09-08', 'ada-1'), duty('2026-09-08', 'ada-deferred-1', 'Deferred Driver')])],
    ['ada-week-2.xlsx', book([duty('2026-09-15', 'ada-2'), duty('2026-09-15', 'ada-deferred-2', 'Deferred Driver')])],
  ]);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const cycleId = response.data.cycleId;
  assert.ok(cycleId);

  response = await upload('DIV3_GOLINK', [
    ['golink-week-1.xlsx', book([duty('2026-09-09', 'go-1', 'Future GoLink')])],
    ['golink-week-2.xlsx', book([duty('2026-09-16', 'go-2', 'Future GoLink')])],
  ], cycleId);
  assert.equal(response.status, 201, JSON.stringify(response.data));

  const uberHeader = 'week_start,week_end,driver_uuid,driver_name,supply_hours,online_hours,trips_accepted,trips_rejected,trips_expired,trips_canceled,hours_7am_9pm,earnings_excl_tips,tips';
  const uber = (week, end) => Buffer.from(`${uberHeader}\n${week},${end},future-uuid,Future Uber,50,48,100,1,1,2,47,1200,40\n`);
  const uberForm = new FormData();
  uberForm.append('cycleId', cycleId);
  uberForm.append('files', new Blob([uber('2026-09-07', '2026-09-13')]), 'uber-week-1.csv');
  uberForm.append('files', new Blob([uber('2026-09-14', '2026-09-20')]), 'uber-week-2.csv');
  response = await call('POST', '/uber-performance-imports', undefined, uberForm);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.equal(response.data.files.every((file) => file.validationStatus === 'VALID'), true);
  const uberFileIds = response.data.files.map((file) => file._id);

  const fareRow = (date) => ({ 'Trip Status': 'completed', 'Pickup Arrived At': `${date} 10:00:00`, 'Driver Name': 'Future Driver', Provider: 'Big Star', 'Number of Riders (Adult)': 1 });
  response = await upload('DIV3_ADA_FARE', [
    ['fare-week-1.xlsx', book([fareRow('2026-09-10')])],
    ['fare-week-2.xlsx', book([fareRow('2026-09-17')])],
  ], cycleId);
  assert.equal(response.status, 201, JSON.stringify(response.data));

  response = await upload('DIV3_RETURNED_FARE', [[
    'accounting-return.xlsx',
    book([
      { 'PARTNER NAME': 'Future Provider', DriverName: 'Future Driver', Date: '2026-09-10', 'Fare To Collect': 3.5 },
      { 'PARTNER NAME': 'Future Provider', DriverName: 'Future Driver', Date: '2026-09-17', 'Fare To Collect': 3.5 },
    ]),
  ]], cycleId);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.equal(response.data.files[0].schemaComplete, false);

  response = await call('GET', `/cycles/${cycleId}`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.providersExpected, 0);
  assert.equal(response.data.inputRequirements.division3Required, true);
  assert.deepEqual(response.data.processingDivisions.map((item) => item.divisionNumber), ['3', '3GL']);
  assert.equal(response.data.division3Data.requiredReady, true);
  assert.equal(response.data.division3Data.sources.DIV3_ADA.ready, true);
  assert.equal(response.data.division3Data.sources.DIV3_GOLINK.ready, true);
  assert.equal(response.data.division3Data.sources.DIV3_ADA_FARE.ready, true);
  assert.equal(response.data.inputRequirements.uberRequired, false);
  assert.equal(response.data.inputRequirements.uberOptional, true);
  assert.equal(response.data.uberPerformance.ready, true);
  assert.equal(response.data.division3Data.fareReconciliation.pendingCount, 2);
  assert.equal(response.data.division3Data.fareReconciliation.cashToDeduct, '7.00');

  response = await call('POST', '/vdp-plans', {
    divisionId: division._id,
    name: 'DIV 3 DART test',
    version: {
      calculationType: 'STANDARD', paymentType: 'HOURLY', effectiveFrom: '2026-09-07',
      basePay: '27.20', contractedHoursMode: 'OPERATOR_PROFILE', incentiveEnabled: true,
      attainmentHourMetric: 'OTHER', attainmentHourColumn: 'Incentive Hours', attainmentScope: 'PROVIDER',
      performanceHourMetric: 'TOTAL_HOURS',
      incentiveTiers: [
        { minimumPercentage: '0', maximumPercentage: '93.99', rate: '27.20' },
        { minimumPercentage: '94', maximumPercentage: '95.99', rate: '28.90' },
        { minimumPercentage: '96', maximumPercentage: '97.99', rate: '30.60' },
        { minimumPercentage: '98', maximumPercentage: '', rate: '34.00' },
      ],
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const dartPlan = response.data;

  response = await call('POST', '/vdp-plans', {
    divisionId: goLinkDivision._id,
    name: 'DIV 3 GoLink test',
    version: {
      calculationType: 'STANDARD', paymentType: 'HOURLY', effectiveFrom: '2026-09-07',
      basePay: '27.20', contractedHoursMode: 'OPERATOR_PROFILE', incentiveEnabled: true,
      attainmentHourMetric: 'OTHER', attainmentHourColumn: 'Incentive Hours', attainmentScope: 'PROVIDER',
      performanceHourMetric: 'TOTAL_HOURS',
      incentiveTiers: [
        { minimumPercentage: '0', maximumPercentage: '93.99', rate: '27.20' },
        { minimumPercentage: '94', maximumPercentage: '95.99', rate: '28.90' },
        { minimumPercentage: '96', maximumPercentage: '97.99', rate: '30.60' },
        { minimumPercentage: '98', maximumPercentage: '', rate: '34.00' },
      ],
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const goLinkPlan = response.data;

  response = await call('POST', '/vdp-plans', {
    divisionId: division._id,
    name: 'DIV 3 Uber test',
    version: {
      calculationType: 'UBER', effectiveFrom: '2026-09-07',
      uberConfig: {
        coreRatePct: '0.80', minimumFulfillmentForIncentives: '0.90', belowThresholdBehavior: 'CORE_ONLY',
        contractHoursIncentiveTiers: [{ minimum: '0.90', rate: '0.05' }, { minimum: '0.96', rate: '0.10' }, { minimum: '0.98', rate: '0.15' }],
        acceptanceIncentiveTiers: [{ minimum: '0.95', rate: '0.05' }],
        cancellationIncentiveTiers: [{ maximum: '0.04', rate: '0.05' }],
        utilizationEnabled: false, coreHoursRuleType: 'PERCENTAGE', coreHoursRequirement: '1.00',
        incentiveScope: 'PROVIDER', coreHoursFailureBehavior: 'STATUS_ONLY',
      },
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const uberPlan = response.data;

  response = await call('POST', '/providers', {
    divisionId: division._id, name: 'Future DART Provider', planId: dartPlan._id,
    operators: [{ name: 'Future Driver', contractedHours: '8', routes: [], liftLease: { frequency: 'NONE' } }],
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const dartProvider = response.data;
  response = await call('POST', '/providers', {
    divisionId: goLinkDivision._id, name: 'Future GoLink Provider', planId: goLinkPlan._id,
    operators: [{ name: 'Future GoLink', contractedHours: '8', routes: [], liftLease: { frequency: 'NONE' } }],
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const goLinkProvider = response.data;
  response = await call('POST', '/providers', {
    divisionId: division._id, name: 'Future Uber Provider', planId: uberPlan._id,
    operators: [{ name: 'Future Uber', basePay: '28.50', contractedHours: '50', routes: [], liftLease: { frequency: 'NONE' } }],
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const uberProvider = response.data;

  // Reproduce a wrong manual occupant, verify the useful conflict message,
  // then set it aside so the correct exact-name source can auto-match.
  response = await call('POST', '/division3-driver-matches', {
    cycleId, sourceName: 'Deferred Driver', service: 'ADA', providerId: dartProvider._id, operatorId: dartProvider.operators[0].id,
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  response = await call('POST', '/division3-driver-matches', {
    cycleId, sourceName: 'Future Driver', service: 'ADA', providerId: dartProvider._id, operatorId: dartProvider.operators[0].id,
  });
  assert.equal(response.status, 400, JSON.stringify(response.data));
  assert.match(response.data.error, /already matched to Deferred Driver \(ADA\)/);
  response = await call('POST', '/division3-driver-exclusions', {
    cycleId, sourceName: 'Deferred Driver', service: 'ADA',
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  response = await call('GET', `/cycles/${cycleId}`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const deferred = response.data.division3Data.driverMatches.find((match) => match.sourceName === 'Deferred Driver' && match.service === 'ADA');
  const future = response.data.division3Data.driverMatches.find((match) => match.sourceName === 'Future Driver' && match.service === 'ADA');
  assert.equal(deferred.status, 'SET_ASIDE');
  assert.equal(future.status, 'MATCHED');
  assert.equal(future.matchMethod, 'AUTO_EXACT_NAME');
  assert.equal(response.data.division3Data.unresolvedCount, 0);
  response = await call('POST', '/division3-driver-matches', {
    cycleId, sourceName: 'Future GoLink', service: 'GOLINK', providerId: goLinkProvider._id, operatorId: goLinkProvider.operators[0].id,
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  response = await call('POST', '/uber-driver-matches', {
    cycleId, driverUuid: 'future-uuid', providerId: uberProvider._id, operatorId: uberProvider.operators[0].id,
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));

  response = await call('POST', '/vdps/process', { cycleId });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.processed, 3);
  assert.equal(response.data.needsReview, 1);
  assert.equal(response.data.ready, 2);
  const vdps = (await call('GET', `/vdps?cycleId=${cycleId}`)).data;
  const dartVdp = vdps.find((vdp) => vdp.provider.name === 'Future DART Provider');
  const goLinkVdp = vdps.find((vdp) => vdp.provider.name === 'Future GoLink Provider');
  const uberVdp = vdps.find((vdp) => vdp.provider.name === 'Future Uber Provider');
  assert.equal(dartVdp.gross, '544.00', JSON.stringify(dartVdp));
  assert.equal(dartVdp.totalDeductions, '7.00');
  assert.equal(dartVdp.net, '537.00');
  assert.equal(dartVdp.status, 'NEEDS_REVIEW');
  assert.match(dartVdp.exceptions.map((item) => item.code).join(','), /DIV3_FARE_RECON_PENDING/);
  assert.equal(goLinkVdp.gross, '612.00');
  assert.equal(goLinkVdp.status, 'READY');
  assert.equal(uberVdp.gross, '2679.20');
  assert.equal(uberVdp.status, 'READY');

  response = await upload('DIV3_RETURNED_FARE', [[
    'nsm-return.xlsx',
    book([
      { 'PARTNER NAME': 'Future DART Provider', DriverName: 'Future Driver', Date: '2026-09-10', 'Fare To Collect': 3.5, 1029: 1, '# Orange Coupon': 0, '# Green Coupon': 0, '$ Stripe': 0, '$ Wallet': 0 },
      { 'PARTNER NAME': 'Future DART Provider', DriverName: 'Future Driver', Date: '2026-09-17', 'Fare To Collect': 3.5, 1029: 1, '# Orange Coupon': 0, '# Green Coupon': 0, '$ Stripe': 0, '$ Wallet': 0 },
    ]),
  ]], cycleId);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  assert.equal(response.data.files[0].schemaComplete, true);
  response = await call('POST', '/vdps/process', { cycleId });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.ready, 3);
  const refreshed = (await call('GET', `/vdps?cycleId=${cycleId}`)).data;
  const completedDart = refreshed.find((vdp) => vdp.provider.name === 'Future DART Provider');
  assert.equal(completedDart.totalDeductions, '5.00');
  assert.equal(completedDart.net, '539.00');
  assert.equal(completedDart.status, 'READY');

  for (const fileId of uberFileIds) {
    response = await call('DELETE', `/uber-performance-imports/${fileId}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
  }
  response = await call('GET', `/cycles/${cycleId}`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.uberPerformance.loaded, false);
  assert.equal(response.data.uberPerformance.ready, true);
  assert.equal(response.data.inputRequirements.uberRequired, false);

  response = await call('POST', '/vdps/process', { cycleId });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const withoutUber = (await call('GET', `/vdps?cycleId=${cycleId}`)).data;
  const incompleteUber = withoutUber.find((vdp) => vdp.provider.name === 'Future Uber Provider');
  assert.equal(incompleteUber.status, 'NEEDS_REVIEW');
  assert.match(incompleteUber.exceptions.map((item) => item.code).join(','), /NO_UBER_PERFORMANCE_IMPORT/);
});
