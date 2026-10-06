import 'dotenv/config';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db.js';
import Division from '../src/models/Division.js';
import Provider from '../src/models/Provider.js';
import VdpPlan from '../src/models/VdpPlan.js';
import { syncCompassRoster } from '../src/services/compassRosterService.js';
import * as liftLeases from '../src/controllers/liftLeaseController.js';
import { applyInput as applyProviderInput, assignDivisionPlan } from '../src/controllers/providerController.js';

const TEST_DB = 'bigstar_vdp_test';
const skip = !process.env.MONGO_URI && 'MONGO_URI not set';

before(async () => {
  if (skip) return;
  assert.ok(TEST_DB.endsWith('_test'));
  await connectDb(TEST_DB);
  assert.equal(mongoose.connection.name, TEST_DB);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
});

after(async () => {
  if (!skip) await disconnectDb();
});

test('Compass takeover preserves VDP settings and leaves absent divisions untouched', { skip }, async () => {
  const div10 = await Division.create({ divisionNumber: '10', name: 'Old Portland' });
  const div12 = await Division.create({ divisionNumber: '12', name: 'Pennsylvania', notes: 'MongoDB only' });
  const kept = await Provider.create({
    divisionId: div10._id,
    name: 'Example Transit LLC',
    providerNumber: 'LOCAL-10',
    overrides: { basePay: '32.50' },
    contact: { email: 'billing@example.test' },
    operators: [{
      name: 'One Driver', routes: ['OLD'], contractedHours: '40',
      liftLease: { amount: '197.50', frequency: 'WEEKLY' },
    }],
  });
  const removed = await Provider.create({ divisionId: div10._id, name: 'Not In Compass', status: 'ACTIVE' });
  const div12Provider = await Provider.create({ divisionId: div12._id, name: 'DIV 12 Local Provider', status: 'ACTIVE' });

  const snapshot = {
    retrievedAt: new Date('2026-10-06T12:00:00Z'),
    divisions: [
      { _id: 'd10', code: 'DIV_10', name: 'Portland', timezone: 'America/Los_Angeles', active: true },
      { _id: 'd6', code: 'DIV_6', name: 'Seattle', timezone: 'America/Los_Angeles', active: true },
    ],
    providers: [
      { _id: 'p1', name: 'Example Transit LLC', active: true },
      { _id: 'p2', name: 'New Seattle Provider', active: true },
    ],
    operators: [
      { _id: 'o1', employeeId: '100', name: 'One Driver', active: true, division: { _id: 'd10' }, provider: { _id: 'p1' } },
      { _id: 'o2', employeeId: '200', name: 'Two Driver', active: true, division: { _id: 'd6' }, provider: { _id: 'p2' } },
    ],
    runCuts: [
      { status: 'active', operator: { _id: 'o1' }, route: { code: '918' }, vehicle: { code: 'V1' }, serviceHours: 8, daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI'] },
      { status: 'active', operator: { _id: 'o2' }, route: { code: '700' }, vehicle: { code: 'V2' }, serviceHours: 10, daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI'] },
    ],
  };
  const result = await syncCompassRoster({ snapshot });

  const refreshed = await Provider.findById(kept._id);
  assert.equal(refreshed.source.system, 'COMPASS');
  assert.equal(refreshed.source.externalId, 'p1');
  assert.equal(refreshed.providerNumber, 'LOCAL-10');
  assert.equal(refreshed.overrides.basePay.toString(), '32.50');
  assert.equal(refreshed.contact.email, 'billing@example.test');
  assert.deepEqual(refreshed.operators[0].routes, ['918']);
  assert.equal(refreshed.operators[0].contractedHours.toString(), '40');
  assert.equal(refreshed.operators[0].liftLease.amount.toString(), '197.50');
  assert.equal(refreshed.operators[0].source.externalId, 'o1');
  assert.equal((await Provider.findById(removed._id)).status, 'INACTIVE');
  assert.equal((await Provider.findById(div12Provider._id)).status, 'ACTIVE');
  assert.equal((await Division.findById(div12._id)).source.system, 'MANUAL');
  assert.ok(await Division.exists({ divisionNumber: '6', 'source.system': 'COMPASS' }));
  assert.equal(result.summary.divisions.created, 1);
  assert.equal(result.summary.untouchedMongoDivisions, 1);

  const before = await Provider.countDocuments();
  await assert.rejects(() => syncCompassRoster({ snapshot: {
    retrievedAt: new Date(), divisions: [{ _id: 'd10', code: 'DIV_10', name: 'Portland' }],
    providers: [], operators: [], runCuts: [],
  } }), /incomplete roster/i);
  assert.equal(await Provider.countDocuments(), before);
  assert.equal((await Provider.findById(div12Provider._id)).status, 'ACTIVE');

  let response;
  await liftLeases.update(
    { params: { divisionId: div10._id }, body: { frequency: 'PER_VDP_CYCLE', amount: '300.00' } },
    { json: (value) => { response = value; } },
  );
  assert.deepEqual(response.applied, { providers: 2, operators: 1 });
  let assigned = await Provider.findById(kept._id);
  assert.equal(assigned.operators[0].liftLease.frequency, 'PER_VDP_CYCLE');
  assert.equal(assigned.operators[0].liftLease.amount.toString(), '300.00');

  await syncCompassRoster({ snapshot: {
    ...snapshot,
    operators: [...snapshot.operators,
      { _id: 'o3', employeeId: '300', name: 'New Driver', active: true, division: { _id: 'd10' }, provider: { _id: 'p1' } }],
    runCuts: [...snapshot.runCuts,
      { status: 'active', operator: { _id: 'o3' }, route: { code: '919' }, vehicle: { code: 'V3' }, serviceHours: 9.5, daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI'] }],
  } });
  assigned = await Provider.findById(kept._id);
  assert.equal(assigned.operators.length, 2);
  assert.ok(assigned.operators.every((operator) => operator.liftLease.frequency === 'PER_VDP_CYCLE'));
  assert.ok(assigned.operators.every((operator) => operator.liftLease.amount.toString() === '300.00'));
  assert.equal(assigned.operators.find((operator) => operator.source.externalId === 'o3').contractedHours.toString(), '47.5');

  const [divisionPlan, exceptionPlan] = await VdpPlan.create([
    { divisionId: div12._id, name: 'Reusable Division Standard' },
    { divisionId: div10._id, name: 'Provider Exception' },
  ]);
  await assignDivisionPlan(
    { params: { divisionId: div10._id }, body: { planId: divisionPlan._id } },
    { json: (value) => { response = value; } },
  );
  assert.deepEqual(response.applied, { providers: 2 });
  assigned = await Provider.findById(kept._id);
  assert.equal(String(assigned.planId), String(divisionPlan._id));

  await applyProviderInput(assigned, { planId: exceptionPlan._id });
  await assigned.save();

  await syncCompassRoster({ snapshot: {
    ...snapshot,
    providers: [...snapshot.providers, { _id: 'p3', name: 'Later Portland Provider', active: true }],
    operators: [...snapshot.operators,
      { _id: 'o3', employeeId: '300', name: 'New Driver', active: true, division: { _id: 'd10' }, provider: { _id: 'p1' } },
      { _id: 'o4', employeeId: '400', name: 'Later Driver', active: true, division: { _id: 'd10' }, provider: { _id: 'p3' } }],
    runCuts: [...snapshot.runCuts,
      { status: 'active', operator: { _id: 'o3' }, route: { code: '919' }, vehicle: { code: 'V3' }, serviceHours: 9.5, daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI'] },
      { status: 'active', operator: { _id: 'o4' }, route: { code: '920' }, vehicle: { code: 'V4' }, serviceHours: 8, daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI'] }],
  } });
  const exception = await Provider.findById(kept._id);
  assert.equal(String(exception.planId), String(exceptionPlan._id));
  const later = await Provider.findOne({ 'source.externalId': 'p3' });
  assert.equal(String(later.planId), String(divisionPlan._id));
});
