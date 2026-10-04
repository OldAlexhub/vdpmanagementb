import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionInput } from '../src/controllers/planController.js';

const uberVersion = (uberConfig) => ({
  calculationType: 'UBER',
  effectiveFrom: '2026-10-01',
  uberConfig,
});

test('flat Uber plans ignore hidden hourly-rate band rows', () => {
  const version = versionInput(uberVersion({
    rateStructureType: 'FLAT',
    hourlyRateBands: [{ fromHour: '', toHour: '', hourlyRate: '' }],
  }));

  assert.equal(version.uberConfig.rateStructureType, 'FLAT');
  assert.deepEqual(version.uberConfig.hourlyRateBands, []);
});

test('hourly-band Uber plans still require complete band rows', () => {
  assert.throws(
    () => versionInput(uberVersion({
      rateStructureType: 'HOURLY_BANDS',
      hourlyRateBands: [{ fromHour: '', toHour: '', hourlyRate: '' }],
    })),
    /Hourly rate band 1 from hour is required/,
  );
});
