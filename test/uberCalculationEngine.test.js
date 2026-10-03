import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateUberVdp, serializeUberResult } from '../src/services/uberCalculationEngine.js';

const SETTINGS = {
  baseHourlyRate: '32.50',
  contractedWeeklyHours: '50',
  coreRatePct: '0.65',
  approvedExtraHours: '0',
  contractHoursIncentiveTiers: [
    { minimum: '0.94', rate: '0.05' },
    { minimum: '0.96', rate: '0.10' },
    { minimum: '0.98', rate: '0.20' },
  ],
  acceptanceIncentiveTiers: [{ minimum: '0.92', rate: '0.05' }, { minimum: '0.95', rate: '0.10' }],
  cancellationIncentiveTiers: [{ maximum: '0.04', rate: '0.10' }, { maximum: '0.05', rate: '0.05' }],
  utilizationTarget: '0.70',
  utilizationIncentivePct: '0.05',
  coreHoursRequirement: '0.60',
};

const baseRow = (overrides = {}) => ({
  week: '2026-09-07',
  driverUuid: '68f0b1e8-da78-4d64-b477-0f1b68333483',
  firstName: 'MARY',
  lastName: 'WITT',
  totalSupplyHours: '52.86',
  pausedHours: '0.46',
  coreHoursTotalSupplyHours: '36.58',
  utilizedHours: '45.60',
  totalAccepts: '110',
  totalRejects: '0',
  totalExpiredOffers: '0',
  totalCancels: '5',
  driverEarningsExclTips: '1121',
  driverTips: '57',
  ...overrides,
});

const run = (row = baseRow(), extra = {}) => serializeUberResult(calculateUberVdp({
  settings: { ...SETTINGS, ...(extra.settings || {}) },
  rows: [row],
  weeklyAdjustments: extra.weeklyAdjustments || [],
  leases: [],
  adjustments: extra.adjustments || [],
}));

describe('Uber WITT regression', () => {
  test('takes contracted hours from per-operator row settings when the plan has none', () => {
    const { contractedWeeklyHours, baseHourlyRate, ...planRules } = SETTINGS;
    const result = serializeUberResult(calculateUberVdp({
      settings: planRules,
      rows: [baseRow({ settings: {
        baseHourlyRate: '32.50',
        baseHourlyRateSource: 'OPERATOR_PROFILE',
        contractedWeeklyHours: '40',
        contractedWeeklyHoursSource: 'OPERATOR_PROFILE',
      } })],
    }));
    assert.equal(result.uberRows[0].contractedHours, '40');
    assert.equal(result.uberRows[0].payableHours, '40');
    assert.equal(result.uberRows[0].settingsUsed.baseHourlyRateSource, 'OPERATOR_PROFILE');
    assert.equal(result.uberRows[0].settingsUsed.contractedWeeklyHoursSource, 'OPERATOR_PROFILE');
  });

  test('reproduces the required accounting-style Gross VDP', () => {
    const result = run();
    const row = result.uberRows[0];
    assert.equal(row.qualifyingSupplyHours, '52.4');
    assert.equal(row.fulfillment, '1.048');
    assert.equal(row.payableHours, '50');
    assert.equal(row.hourIncentivePct, '0.2');
    assert.equal(row.baseCompensation, '1625.00');
    assert.equal(row.coreCompensation, '1056.25');
    assert.equal(row.acceptanceRate, '1');
    assert.equal(row.cancellationRate, '0.04545454545454545454545454545454545454545');
    assert.equal(row.acceptanceCancellationPct, '0.05');
    assert.equal(row.contractHoursIncentive, '325.00');
    assert.equal(row.acceptanceCancellationIncentive, '81.25');
    assert.equal(row.utilizationIncentive, '81.25');
    assert.equal(row.grossVdp, '1600.75');
    assert.equal(result.gross, '1600.75');
  });

  test('adds tolls as a per-driver/week Gross pass-through', () => {
    const result = run(baseRow(), { weeklyAdjustments: [{
      driverUuid: baseRow().driverUuid, week: '2026-09-07', approvedExtraHours: '0',
      passThroughs: [{ type: 'TOLL', amount: '21' }],
    }] });
    assert.equal(result.uberRows[0].tolls, '21.00');
    assert.equal(result.gross, '1621.75');
  });

  test('supports both toll credits and provider toll bills', () => {
    const result = run(baseRow(), { adjustments: [
      { type: 'TOLL', amount: '21', week: '2026-09-07', tollDirection: 'CREDIT' },
      { type: 'TOLL', amount: '6', week: '2026-09-07', tollDirection: 'DEDUCTION' },
    ] });
    assert.equal(result.weeks[0].adjustmentTolls, '21.00');
    assert.equal(result.weeks[0].adjustmentTollDeductions, '6.00');
    assert.equal(result.gross, '1621.75');
    assert.equal(result.adjustmentTollDeductions, '6.00');
    assert.equal(result.totalDeductions, '6.00');
    assert.equal(result.net, '1615.75');
  });
});

describe('Uber tier boundaries and safeguards', () => {
  const fulfillment = (ratio) => run(baseRow({ totalSupplyHours: String(50 * ratio), pausedHours: '0' })).uberRows[0];

  test('93.99% uses fallback earnings', () => {
    const row = fulfillment(0.9399);
    assert.equal(row.qualified, false);
    assert.equal(row.hourIncentivePct, '0');
    assert.equal(row.grossVdp, '1178.00');
  });
  test('exactly 94% qualifies for 5%', () => assert.equal(fulfillment(0.94).hourIncentivePct, '0.05'));
  test('exactly 96% qualifies for 10%', () => assert.equal(fulfillment(0.96).hourIncentivePct, '0.1'));
  test('exactly 98% qualifies for 20%', () => assert.equal(fulfillment(0.98).hourIncentivePct, '0.2'));
  test('greater than 100% is not capped for tiering but payable hours are capped', () => {
    const row = run(baseRow()).uberRows[0];
    assert.equal(row.fulfillment, '1.048');
    assert.equal(row.hourIncentivePct, '0.2');
    assert.equal(row.payableHours, '50');
  });

  test('exactly 95% acceptance qualifies for 10%', () => {
    const row = run(baseRow({ totalAccepts: '95', totalRejects: '5', totalExpiredOffers: '0', totalCancels: '0' })).uberRows[0];
    assert.equal(row.acceptanceRate, '0.95');
    assert.equal(row.acceptanceIncentivePct, '0.1');
  });
  test('exactly 92% acceptance qualifies for 5%', () => {
    const row = run(baseRow({ totalAccepts: '92', totalRejects: '8', totalExpiredOffers: '0', totalCancels: '0' })).uberRows[0];
    assert.equal(row.acceptanceIncentivePct, '0.05');
  });
  test('exactly 4% cancellation qualifies for 10%', () => {
    const row = run(baseRow({ totalAccepts: '100', totalCancels: '4' })).uberRows[0];
    assert.equal(row.cancellationRate, '0.04');
    assert.equal(row.cancellationIncentivePct, '0.1');
  });
  test('exactly 5% cancellation qualifies for 5%', () => {
    const row = run(baseRow({ totalAccepts: '100', totalCancels: '5' })).uberRows[0];
    assert.equal(row.cancellationRate, '0.05');
    assert.equal(row.cancellationIncentivePct, '0.05');
  });
  test('acceptance 10% and cancellation 5% produce one 5% incentive', () => {
    const row = run(baseRow({ totalAccepts: '100', totalRejects: '0', totalExpiredOffers: '0', totalCancels: '5' })).uberRows[0];
    assert.equal(row.acceptanceIncentivePct, '0.1');
    assert.equal(row.cancellationIncentivePct, '0.05');
    assert.equal(row.acceptanceCancellationPct, '0.05');
  });
  test('zero accepts is safe and cannot earn the combined incentive', () => {
    const row = run(baseRow({ totalAccepts: '0', totalRejects: '0', totalExpiredOffers: '0', totalCancels: '0' })).uberRows[0];
    assert.equal(row.acceptanceRate, '0');
    assert.equal(row.cancellationRate, '0');
    assert.equal(row.acceptanceCancellationPct, '0');
  });
  test('zero supply hours is safe and uses fallback earnings', () => {
    const row = run(baseRow({ totalSupplyHours: '0', pausedHours: '0', utilizedHours: '0', driverEarningsExclTips: '10', driverTips: '2' })).uberRows[0];
    assert.equal(row.fulfillment, '0');
    assert.equal(row.utilizationRate, '0');
    assert.equal(row.grossVdp, '12.00');
  });
  test('approved extra hours increase the payable-hour cap without changing fulfillment', () => {
    const result = run(baseRow(), { weeklyAdjustments: [{
      driverUuid: baseRow().driverUuid, week: '2026-09-07', approvedExtraHours: '2', passThroughs: [],
    }] });
    const row = result.uberRows[0];
    assert.equal(row.fulfillment, '1.048');
    assert.equal(row.payableHours, '52');
    assert.equal(row.baseCompensation, '1690.00');
  });
});

describe('Uber weekly aggregation', () => {
  test('weeks are calculated independently and then summed', () => {
    const second = baseRow({ week: '2026-09-14', totalSupplyHours: '46.995', pausedHours: '0', driverEarningsExclTips: '100', driverTips: '10' });
    const result = serializeUberResult(calculateUberVdp({ settings: SETTINGS, rows: [baseRow(), second] }));
    assert.equal(result.uberRows[0].grossVdp, '1600.75');
    assert.equal(result.uberRows[1].grossVdp, '110.00');
    assert.equal(result.gross, '1710.75');
  });

  test('shared-vehicle operators combine by week, charge one lease, and take assigned tolls from Adjustments', () => {
    const shared = (overrides) => ({
      calculationUnitId: 'vehicle:4548',
      calculationUnitLabel: 'Vehicle 4548',
      vehicleUnit: '4548',
      settings: { ...SETTINGS, contractedWeeklyHours: '25', contractedWeeklyHoursSource: 'OPERATOR_PROFILE' },
      ...overrides,
    });
    const rows = [
      shared({ week: '2026-09-07', driverUuid: 'driver-mohamed', operatorId: 'op-mohamed', operatorName: 'Mohamed Mohamed', totalSupplyHours: '25.34', pausedHours: '0', coreHoursTotalSupplyHours: '11.35', utilizedHours: '21.87', totalAccepts: '41', totalRejects: '0', totalExpiredOffers: '0', totalCancels: '0', driverEarningsExclTips: '531.68', driverTips: '30' }),
      shared({ week: '2026-09-07', driverUuid: 'driver-king', operatorId: 'op-king', operatorName: 'King Tshikusay', totalSupplyHours: '25.02', pausedHours: '0.01', coreHoursTotalSupplyHours: '23.63', utilizedHours: '21.77', totalAccepts: '35', totalRejects: '0', totalExpiredOffers: '0', totalCancels: '1', driverEarningsExclTips: '472.55', driverTips: '25' }),
      shared({ week: '2026-09-14', driverUuid: 'driver-mohamed', operatorId: 'op-mohamed', operatorName: 'Mohamed Mohamed', totalSupplyHours: '25.14', pausedHours: '0.02', coreHoursTotalSupplyHours: '8', utilizedHours: '22.73', totalAccepts: '47', totalRejects: '0', totalExpiredOffers: '1', totalCancels: '0', driverEarningsExclTips: '538.73', driverTips: '11' }),
      shared({ week: '2026-09-14', driverUuid: 'driver-king', operatorId: 'op-king', operatorName: 'King Tshikusay', totalSupplyHours: '25.13', pausedHours: '0.06', coreHoursTotalSupplyHours: '23.82', utilizedHours: '22.17', totalAccepts: '46', totalRejects: '2', totalExpiredOffers: '1', totalCancels: '1', driverEarningsExclTips: '468.53', driverTips: '21' }),
    ];
    const result = serializeUberResult(calculateUberVdp({
      settings: SETTINGS,
      rows,
      leases: [{ amount: '167', frequency: 'WEEKLY' }],
      adjustments: [{ type: 'TOLL', amount: '6.90', operatorId: 'op-king', operatorName: 'King Tshikusay', week: '2026-09-14' }],
    }));
    assert.equal(result.uberRows.length, 2);
    assert.deepEqual(result.uberRows.map((row) => row.grossVdp), ['1680.00', '1657.00']);
    assert.deepEqual(result.uberRows.map((row) => row.raw.sourceRows.length), [2, 2]);
    assert.equal(result.weeks[1].adjustmentTolls, '6.90');
    assert.equal(result.weeks[1].weeklyEarnings, '1663.90');
    assert.equal(result.calculatedGross, '3337.00');
    assert.equal(result.adjustmentTolls, '6.90');
    assert.equal(result.gross, '3343.90');
    assert.equal(result.lease, '334.00');
    assert.equal(result.net, '3009.90');
  });
});
