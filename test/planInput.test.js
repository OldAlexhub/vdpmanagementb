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

const tuiVersion = (overrides = {}) => ({
  calculationType: 'STANDARD', paymentType: 'HOURLY', basePay: '25', contractedHours: '40',
  incentiveEnabled: true,
  incentiveTiers: [{ minimumPercentage: '0', maximumPercentage: '', rate: '25' }],
  effectiveFrom: '2026-10-01',
  ...overrides,
});

test('new TUI plans use an explicit in-window hours column', () => {
  const version = versionInput(tuiVersion());
  assert.equal(version.attainmentHourMetric, 'OTHER');
  assert.equal(version.attainmentHourColumn, 'Incentive Hours');
  assert.throws(
    () => versionInput(tuiVersion({ attainmentHourMetric: 'SAME_AS_PAID' })),
    /hours worked inside the Compass start\/end window/i,
  );
});
