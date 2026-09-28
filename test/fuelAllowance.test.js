// Service mile fuel allowance (engine only): service miles ÷ X (the plan's divisor, e.g. 19)
// = maximum allowed fuel; only the actual expense above it is deducted.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calculateVdp, serializeResult, calculateFuelAllowance, CalculationError } from '../src/services/calculationEngine.js';

const PER_TRIP = { paymentType: 'PER_TRIP', basePay: '21.50', tuiEligible: false, incentiveTiers: [], bonusEnabled: false };
const ALLOWANCE = { ...PER_TRIP, fuelMethod: 'SERVICE_MILE_ALLOWANCE', fuelMpg: '19' };
const LEASE = { amount: '197.50', frequency: 'WEEKLY' };
const week = (n, trips) => ({ weekNumber: n, trips: String(trips), actualHours: '40' });

const run = ({ settings = ALLOWANCE, days, actualExpense = null, adjustments = [] }) =>
  serializeResult(calculateVdp({
    settings,
    weeks: [week(1, 10), week(2, 10)],
    lease: LEASE,
    adjustments,
    fuel: settings.fuelMethod === 'SERVICE_MILE_ALLOWANCE' ? { days, actualExpense } : undefined,
  }));

// 1,432.50 service miles ÷ 19 = 75.3947… → $75.39
const CYCLE = [
  { date: '2026-08-24', week: 1, serviceMiles: '700' },
  { date: '2026-08-31', week: 2, serviceMiles: '732.5' },
];

describe('service mile fuel allowance', () => {
  test('one day: 137.51 service miles ÷ 19 = $7.24', () => {
    const a = calculateFuelAllowance({ mpg: '19', days: [{ date: '2026-08-24', week: 1, serviceMiles: '137.51' }], actualExpense: null });
    assert.equal(a.days[0].allowed.toFixed(6), '7.237368');
    assert.equal(a.maxAllowed.toFixed(2), '7.24');
    assert.equal(a.entered, false);
    assert.equal(a.overspend.toFixed(2), '0.00');
  });

  test('actual above the allowance: only the difference is deducted, once', () => {
    const base = run({ settings: PER_TRIP });
    const r = run({ days: CYCLE, actualExpense: '100.00' });
    assert.equal(r.fuelAllowance.serviceMiles, '1432.5');
    assert.deepEqual(r.fuelAllowance.weekMiles, ['700', '732.5']);
    assert.equal(r.fuelAllowance.maxAllowed, '75.39');
    assert.equal(r.fuelAllowance.actualExpense, '100.00');
    assert.equal(r.fuelOverspend, '24.61');
    assert.equal(r.totalDeductions, (Number(base.totalDeductions) + 24.61).toFixed(2), 'the actual expense itself is not deducted');
    assert.equal(r.net, (Number(base.net) - 24.61).toFixed(2));
    assert.equal(r.gross, base.gross, 'fuel is not earnings');
    const s = r.steps.find((x) => x.label === 'Fuel overspend');
    assert.equal(s.value, '−$24.61');
    assert.equal(s.tone, 'minus');
  });

  test('actual equal to the allowance: no deduction', () => {
    const r = run({ days: CYCLE, actualExpense: '75.39' });
    assert.equal(r.fuelOverspend, '0.00');
    assert.equal(r.fuelAllowance.unused, '0.00');
  });

  test('actual below the allowance: no deduction and the unused allowance is not income', () => {
    const base = run({ settings: PER_TRIP });
    const r = run({ days: CYCLE, actualExpense: '60.00' });
    assert.equal(r.fuelOverspend, '0.00');
    assert.equal(r.fuelAllowance.unused, '15.39');
    assert.equal(r.net, base.net);
    assert.equal(r.totalAdditions, base.totalAdditions);
    assert.equal(r.steps.find((x) => x.label === 'Fuel overspend').value, '$0.00', 'shown as $0.00, never a negative deduction');
  });

  test('not entered yet: allowance shown, nothing deducted', () => {
    const r = run({ days: CYCLE });
    assert.equal(r.fuelAllowance.maxAllowed, '75.39');
    assert.equal(r.fuelAllowance.actualExpense, null);
    assert.equal(r.fuelOverspend, '0.00');
  });

  test('zero service miles: allowance is $0 and the whole expense is overspend', () => {
    const r = run({ days: [{ date: '2026-08-24', week: 1, serviceMiles: '0' }], actualExpense: '25.00' });
    assert.equal(r.fuelAllowance.maxAllowed, '0.00');
    assert.equal(r.fuelOverspend, '25.00');
  });

  test('missing service miles is an error, never treated as zero', () => {
    assert.throws(() => run({ days: [{ date: '2026-08-24', week: 1, serviceMiles: null }], actualExpense: '10' }), /Service Miles are missing/);
  });

  test('missing MPG is an error', () => {
    assert.throws(() => run({ settings: { ...ALLOWANCE, fuelMpg: null }, days: CYCLE }), CalculationError);
  });

  test('daily amounts are not rounded before they are summed', () => {
    // Three days of 0.0333 miles ÷ 19 = $0.00175… each: rounding daily gives $0.00; the true total is $0.01.
    const days = ['2026-08-24', '2026-08-25', '2026-08-26'].map((date) => ({ date, week: 1, serviceMiles: '0.0333' }));
    const a = calculateFuelAllowance({ mpg: '19', days, actualExpense: null });
    assert.ok(a.days.every((d) => d.allowed.toDecimalPlaces(2).isZero()));
    assert.equal(a.maxAllowed.toFixed(2), '0.01');
  });

  test('the divisor comes from the plan: different plans, different allowances', () => {
    const at19 = run({ days: CYCLE, actualExpense: '90' });
    const at15 = run({ settings: { ...ALLOWANCE, fuelMpg: '15' }, days: CYCLE, actualExpense: '90' });
    assert.equal(at19.fuelAllowance.maxAllowed, '75.39');
    assert.equal(at15.fuelAllowance.maxAllowed, '95.50');
    assert.equal(at19.fuelOverspend, '14.61');
    assert.equal(at15.fuelOverspend, '0.00');
  });

  test('per-trip fuel reimbursement still works and has no allowance', () => {
    const r = run({ settings: { ...PER_TRIP, fuelMethod: 'PER_TRIP', fuelReimbursementEnabled: true, fuelReimbursementRate: '1.25' } });
    assert.equal(r.fuelReimbursement, '25.00');
    assert.equal(r.fuelAllowance, null);
    assert.equal(r.fuelOverspend, '0.00');
  });

  test('no fuel method: no reimbursement, no allowance', () => {
    const r = run({ settings: { ...PER_TRIP, fuelMethod: 'NONE' } });
    assert.equal(r.fuelReimbursement, '0.00');
    assert.equal(r.fuelAllowance, null);
    assert.ok(!r.steps.some((s) => /Fuel/.test(s.label)));
  });
});
