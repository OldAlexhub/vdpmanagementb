import test from 'node:test';
import assert from 'node:assert/strict';
import { DIV10_ADAPTER_VERSION, division10ImportForProvider, division10ProviderSourceData } from '../src/services/division10Adapter.js';

const provider = {
  _id: 'provider-1',
  operators: [{
    _id: 'operator-1', name: 'Lisa Moore', routes: ['918'], status: 'ACTIVE',
    tuiWindows: [{ route: '918', daysOfWeek: ['MON'], startTime: '17:00', endTime: '01:00', weekdayTimes: [] }],
    liftLease: { frequency: 'NONE' },
  }],
};

const imported = {
  stats: { sourceAdapter: 'DIV10_V2' },
  rows: [{
    date: '2026-08-24', route: '918', trips: '3', totalHours: '8.033333333333333',
    serviceHours: '2.233', revenueHours: '2.233', serviceMiles: '33.081', otherHours: {},
  }],
  division10ManifestRows: [{
    date: '2026-08-24', route: '918', operatorName: 'Lisa Moore',
    actualStartMinutes: 1018, actualEndMinutes: 1500, actualHours: '8.033333333333333', lunchHours: '0.45',
  }],
  division10FareRows: [{ date: '2026-08-24', route: '918', operatorName: 'Moore, Lisa', cashFares: '5.60' }],
  division10FuelRows: [{ date: '2026-08-24', operatorName: 'Moore, Lisa', amount: '60.00' }],
};

test('DIV 10 manifest hours are clipped to the matching Compass run-cut window', () => {
  const result = division10ImportForProvider(imported, provider);
  assert.equal(result.rows[0].totalHours, '8.033333333333333');
  assert.equal(result.rows[0].otherHours['Incentive Hours'], '8');
});

test('an exact manifest operator can use their Compass window after a route-code change', () => {
  const renamedRoute = {
    ...provider,
    operators: [{
      ...provider.operators[0], routes: ['902A'],
      tuiWindows: [{ route: '902A', daysOfWeek: ['MON'], startTime: '17:00', endTime: '01:00', weekdayTimes: [] }],
    }],
  };
  const result = division10ImportForProvider(imported, renamedRoute);
  assert.equal(result.rows[0].otherHours['Incentive Hours'], '8');
});

test('a worked day outside the Compass run-cut weekdays contributes zero TUI hours', () => {
  const tuesday = {
    ...imported,
    rows: [{ ...imported.rows[0], date: '2026-08-25' }],
    division10ManifestRows: [{ ...imported.division10ManifestRows[0], date: '2026-08-25' }],
  };
  const result = division10ImportForProvider(tuesday, provider);
  assert.equal(result.rows[0].otherHours['Incentive Hours'], '0');
});

test('TUI overlap uses the division timezone across daylight-saving boundaries', () => {
  const dstProvider = {
    _id: 'provider-1', name: 'Provider One', routes: ['918'],
    operators: [{
      id: 'operator-1', name: 'Lisa Moore', status: 'ACTIVE', routes: ['918'],
      tuiWindows: [{ route: '918', daysOfWeek: ['SUN'], startTime: '00:30', endTime: '03:30', weekdayTimes: [] }],
    }],
  };
  const source = (date) => ({
    stats: { sourceAdapter: DIV10_ADAPTER_VERSION, windowSource: true },
    rows: [{ date, route: '918', trips: '1', otherHours: {} }],
    division10ManifestRows: [{ date, route: '918', operatorName: 'Lisa Moore', actualStartMinutes: 30, actualEndMinutes: 210 }],
  });
  const spring = division10ImportForProvider(source('2026-03-08'), dstProvider, 'America/Los_Angeles');
  const fall = division10ImportForProvider(source('2026-11-01'), dstProvider, 'America/Los_Angeles');
  assert.equal(spring.rows[0].otherHours['Incentive Hours'], '2');
  assert.equal(fall.rows[0].otherHours['Incentive Hours'], '4');
  assert.equal(fall.rows[0].tui.timezone, 'America/Los_Angeles');
});

test('DIV 10 Jasper fares and Coast fuel are assigned without storing raw source rows', () => {
  const cycle = { cycleStart: new Date('2026-08-24T00:00:00Z'), cycleEnd: new Date('2026-09-06T00:00:00Z') };
  const result = division10ProviderSourceData({
    importDoc: imported,
    provider,
    cycle,
    matches: [{ route: '918', status: 'MATCHED', providerId: 'provider-1' }],
  });
  assert.equal(result.cashFares, '5.6');
  assert.equal(result.fuelExpense, '60');
  assert.equal(result.fareRows, 1);
  assert.equal(result.fuelRows, 1);
});
