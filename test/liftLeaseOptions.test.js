import 'dotenv/config';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db.js';
import Division from '../src/models/Division.js';
import Provider from '../src/models/Provider.js';
import LiftLeaseOption from '../src/models/LiftLeaseOption.js';
import * as liftLeases from '../src/controllers/liftLeaseController.js';
import { applyInput as applyProviderInput } from '../src/controllers/providerController.js';

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

const response = () => {
  const state = { code: 200, value: null };
  return {
    state,
    res: {
      status(code) { state.code = code; return this; },
      json(value) { state.value = value; },
    },
  };
};

test('saved lift lease options are division-scoped, explicitly assigned, and editable', { skip }, async () => {
  const [division, otherDivision] = await Division.create([
    { divisionNumber: '10', name: 'Portland', source: { system: 'COMPASS', externalId: 'd10' } },
    { divisionNumber: '12', name: 'Pennsylvania' },
  ]);
  let provider = await Provider.create({
    divisionId: division._id,
    name: 'Option Test Provider',
    source: { system: 'COMPASS', externalId: 'p10' },
    operators: [
      { name: 'Default Driver', routes: ['100'], liftLease: { frequency: 'NONE' } },
      { name: 'Option Driver', routes: ['101'], liftLease: { frequency: 'NONE' } },
    ],
  });

  let out = response();
  await liftLeases.createOption({ body: {
    divisionId: division._id,
    name: 'Premium weekly',
    frequency: 'WEEKLY',
    amount: '225.50',
  } }, out.res);
  assert.equal(out.state.code, 201);
  assert.equal(out.state.value.division.divisionNumber, '10');
  const option = await LiftLeaseOption.findById(out.state.value._id);

  // Merely creating the option must not assign or alter anyone.
  provider = await Provider.findById(provider._id);
  assert.ok(provider.operators.every((operator) => !operator.liftLease.optionId));
  assert.ok(provider.operators.every((operator) => operator.liftLease.frequency === 'NONE'));

  await applyProviderInput(provider, { operators: provider.operators.map((operator, index) => ({
    _id: operator._id,
    name: operator.name,
    routes: operator.routes,
    status: operator.status,
    liftLease: index === 1
      ? { optionId: option._id, frequency: 'NONE', amount: null }
      : { frequency: 'NONE', amount: null },
  })) });
  await provider.save();
  provider = await Provider.findById(provider._id);
  assert.equal(String(provider.operators[1].liftLease.optionId), String(option._id));
  assert.equal(provider.operators[1].liftLease.optionName, 'Premium weekly');
  assert.equal(provider.operators[1].liftLease.frequency, 'WEEKLY');
  assert.equal(provider.operators[1].liftLease.amount.toString(), '225.50');

  // Changing the Compass default updates only operators without an explicit option.
  out = response();
  await liftLeases.update({ params: { divisionId: division._id }, body: {
    frequency: 'PER_VDP_CYCLE', amount: '300.00',
  } }, out.res);
  assert.equal(out.state.value.preservedOptionCount, 1);
  assert.equal(out.state.value.applied.operators, 1);
  provider = await Provider.findById(provider._id);
  assert.equal(provider.operators[0].liftLease.frequency, 'PER_VDP_CYCLE');
  assert.equal(provider.operators[0].liftLease.amount.toString(), '300.00');
  assert.equal(provider.operators[1].liftLease.amount.toString(), '225.50');

  // Editing a saved option updates its explicit assignments, but cannot silently
  // move an in-use option to a different division.
  out = response();
  await liftLeases.updateOption({ params: { optionId: option._id }, body: {
    divisionId: division._id,
    name: 'Premium weekly',
    frequency: 'WEEKLY',
    amount: '240.00',
    status: 'ACTIVE',
  } }, out.res);
  assert.deepEqual(out.state.value.applied, { providers: 1, operators: 1 });
  provider = await Provider.findById(provider._id);
  assert.equal(provider.operators[1].liftLease.amount.toString(), '240.00');
  await assert.rejects(() => liftLeases.updateOption({ params: { optionId: option._id }, body: {
    divisionId: otherDivision._id,
    name: 'Premium weekly',
    frequency: 'WEEKLY',
    amount: '240.00',
  } }, response().res), /assigned to operators/i);

  out = response();
  await liftLeases.list({ query: { divisionId: division._id } }, out.res);
  assert.equal(out.state.value.options.length, 1);
  assert.equal(out.state.value.options[0].assignedOperatorCount, 1);
  assert.equal(out.state.value.defaults.length, 1);
});
