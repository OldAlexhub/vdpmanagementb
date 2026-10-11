import 'dotenv/config';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db.js';
import Division from '../src/models/Division.js';
import VdpCycle from '../src/models/VdpCycle.js';
import { importReport } from '../src/services/performanceService.js';

const TEST_DB = 'bigstar_vdp_test';
const skip = !process.env.MONGO_URI && 'MONGO_URI not set';

before(async () => {
  if (skip) return;
  await connectDb(TEST_DB);
  assert.equal(mongoose.connection.name, TEST_DB);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
});

after(async () => {
  if (!skip) await disconnectDb();
});

const dates = (start, end) => ({
  cycleStart: new Date(`${start}T00:00:00.000Z`),
  cycleEnd: new Date(`${end}T00:00:00.000Z`),
  week1Start: new Date(`${start}T00:00:00.000Z`),
  week1End: new Date('2026-08-30T00:00:00.000Z'),
  week2Start: new Date('2026-08-31T00:00:00.000Z'),
  week2End: new Date(`${end}T00:00:00.000Z`),
});

const csvFile = (rows, name = 'performance.csv') => {
  const buffer = Buffer.from(`Date,Run/Route,Total Prov,Total Hours\n${rows.join('\n')}\n`);
  return { buffer, originalname: name, size: buffer.length };
};

test('performance upload identifies its division pay period from source dates', { skip }, async () => {
  const division = await Division.create({ divisionNumber: '10', name: 'Portland' });
  const cycle = await VdpCycle.create({ divisionId: division._id, ...dates('2026-08-24', '2026-09-06') });
  const doc = await importReport({
    divisionId: division._id,
    file: csvFile(['08/24/2026,918,4,8', '09/06/2026,918,5,9']),
    user: { _id: new mongoose.Types.ObjectId(), name: 'Test Admin' },
  });
  assert.equal(String(doc.cycleId), String(cycle._id));
  assert.equal(doc.dataRange.from, '2026-08-24');
  assert.equal(doc.dataRange.to, '2026-09-06');
});

test('dates spanning more than one period are rejected instead of guessed', { skip }, async () => {
  const division = await Division.findOne({ divisionNumber: '10' });
  await VdpCycle.create({
    divisionId: division._id,
    cycleStart: new Date('2026-09-07T00:00:00.000Z'),
    cycleEnd: new Date('2026-09-20T00:00:00.000Z'),
    week1Start: new Date('2026-09-07T00:00:00.000Z'),
    week1End: new Date('2026-09-13T00:00:00.000Z'),
    week2Start: new Date('2026-09-14T00:00:00.000Z'),
    week2End: new Date('2026-09-20T00:00:00.000Z'),
  });
  await assert.rejects(() => importReport({
    divisionId: division._id,
    file: csvFile(['09/06/2026,918,4,8', '09/07/2026,918,5,9'], 'two-periods.csv'),
    user: { _id: new mongoose.Types.ObjectId(), name: 'Test Admin' },
  }), /do not fit one generated VDP period/i);
});
