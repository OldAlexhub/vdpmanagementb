// Service mile fuel allowance (engine only), checked against Accounting's workbook (artifacts/billy.xlsx):
// per service date, service miles ÷ MPG = allowed gallons × that day's fuel price = allowed fuel.
// Maximum Allowed Fuel is the sum; only the actual expense above it is deducted.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calculateVdp, serializeResult, calculateFuelAllowance, CalculationError } from '../src/services/calculationEngine.js';

const PER_TRIP = { paymentType: 'PER_TRIP', basePay: '21.50', tuiEligible: false, incentiveTiers: [], bonusEnabled: false };
const ALLOWANCE = { ...PER_TRIP, fuelMethod: 'SERVICE_MILE_ALLOWANCE', fuelMpg: '19' };
const LEASE = { amount: '197.50', frequency: 'WEEKLY' };
const week = (n, trips) => ({ weekNumber: n, trips: String(trips), actualHours: '40' });

// BILLYSTRANSPORTATION LLC, route 908, cycle 08/24–09/06/2026 (billy.xlsx "Reimbursable Fuel Spending").
const AUG = '4.794';
const SEP = '4.9249';
const BILLY = [
  ['2026-08-24', 1, '137.51', AUG], ['2026-08-25', 1, '131.243', AUG], ['2026-08-26', 1, '146.533', AUG],
  ['2026-08-27', 1, '149.249', AUG], ['2026-08-28', 1, '143.04', AUG], ['2026-08-31', 2, '163.603', AUG],
  ['2026-09-01', 2, '123.61', SEP], ['2026-09-02', 2, '135.496', SEP], ['2026-09-03', 2, '132.727', SEP],
  ['2026-09-04', 2, '155.527', SEP],
].map(([date, wk, serviceMiles, pricePerGallon]) => ({ date, week: wk, serviceMiles, pricePerGallon }));

const run = ({ settings = ALLOWANCE, days = BILLY, actualExpense = null, adjustments = [] } = {}) =>
  serializeResult(calculateVdp({
    settings,
    weeks: [week(1, 79), week(2, 82)],
    lease: LEASE,
    adjustments,
    fuel: settings.fuelMethod === 'SERVICE_MILE_ALLOWANCE' ? { days, actualExpense } : undefined,
  }));

describe('service mile fuel allowance (billy.xlsx)', () => {
  test('one day: 137.51 miles ÷ 19 = 7.237368 gal × $4.794 = $34.6959', () => {
    const a = calculateFuelAllowance({ mpg: '19', days: [BILLY[0]], actualExpense: null });
    assert.equal(a.days[0].gallons.toFixed(6), '7.237368');
    assert.equal(a.days[0].allowed.toFixed(4), '34.6959');
    assert.equal(a.maxAllowed.toFixed(2), '34.70');
  });

  test('Billy’s cycle: reimbursable $361.69; $507.89 spent → $146.20 overspending deducted', () => {
    const base = run({ settings: PER_TRIP });
    const r = run({ actualExpense: '507.89' });
    const a = r.fuelAllowance;
    assert.equal(a.serviceMiles, '1418.538');
    assert.deepEqual(a.weekMiles, ['707.575', '710.963']);
    assert.equal(a.maxAllowed, '361.69'); // workbook: 361.6906
    assert.deepEqual(a.pricesUsed, [AUG, SEP], 'the cycle crosses from the August into the September price');
    assert.deepEqual(a.days.map((d) => Number(d.allowed).toFixed(4)),
      ['34.6959', '33.1147', '36.9726', '37.6579', '36.0913', '41.2796', '32.0404', '35.1213', '34.4035', '40.3134']);
    assert.equal(r.fuelOverspend, '146.20'); // workbook: 507.89 − 361.6906 = 146.1994
    assert.equal(r.totalDeductions, (Number(base.totalDeductions) + 146.2).toFixed(2), 'the actual expense itself is not deducted');
    assert.equal(r.net, (Number(base.net) - 146.2).toFixed(2));
    assert.equal(r.gross, base.gross, 'fuel is not earnings');
    const s = r.steps.find((x) => x.label === 'Fuel overspend');
    assert.equal(s.value, '−$146.20');
    assert.equal(s.tone, 'minus');
  });

  test('actual equal to the allowance: no deduction', () => {
    const r = run({ actualExpense: '361.69' });
    assert.equal(r.fuelOverspend, '0.00');
    assert.equal(r.fuelAllowance.unused, '0.00');
  });

  test('actual below the allowance: no deduction and the unused allowance is not income', () => {
    const base = run({ settings: PER_TRIP });
    const r = run({ actualExpense: '340.00' });
    assert.equal(r.fuelOverspend, '0.00');
    assert.equal(r.fuelAllowance.unused, '21.69');
    assert.equal(r.net, base.net);
    assert.equal(r.totalAdditions, base.totalAdditions);
    assert.equal(r.steps.find((x) => x.label === 'Fuel overspend').value, '$0.00', 'shown as $0.00, never a negative deduction');
  });

  test('not entered yet: allowance shown, nothing deducted', () => {
    const r = run();
    assert.equal(r.fuelAllowance.maxAllowed, '361.69');
    assert.equal(r.fuelAllowance.actualExpense, null);
    assert.equal(r.fuelOverspend, '0.00');
  });

  test('zero service miles: allowance is $0 and the whole expense is overspend', () => {
    const r = run({ days: [{ ...BILLY[0], serviceMiles: '0' }], actualExpense: '25.00' });
    assert.equal(r.fuelAllowance.maxAllowed, '0.00');
    assert.equal(r.fuelOverspend, '25.00');
  });

  test('missing service miles is an error, never treated as zero', () => {
    assert.throws(() => run({ days: [{ ...BILLY[0], serviceMiles: null }], actualExpense: '10' }), /Service Miles are missing/);
  });

  test('missing fuel price for a service date is an error', () => {
    assert.throws(() => run({ days: [{ ...BILLY[0], pricePerGallon: null }] }), /No fuel price configured for 2026-08-24/);
  });

  test('missing MPG is an error', () => {
    assert.throws(() => run({ settings: { ...ALLOWANCE, fuelMpg: null } }), CalculationError);
  });

  test('daily amounts are not rounded before they are summed', () => {
    // Three days worth $0.0026 each: rounding daily gives $0.00; the true total rounds to $0.01.
    const days = ['2026-08-24', '2026-08-25', '2026-08-26'].map((date) => ({ date, week: 1, serviceMiles: '0.0103', pricePerGallon: AUG }));
    const a = calculateFuelAllowance({ mpg: '19', days, actualExpense: null });
    assert.ok(a.days.every((d) => d.allowed.toDecimalPlaces(2).isZero()));
    assert.equal(a.maxAllowed.toFixed(2), '0.01');
  });

  test('MPG comes from the plan: a different MPG, a different allowance', () => {
    const at19 = run({ actualExpense: '400' });
    const at15 = run({ settings: { ...ALLOWANCE, fuelMpg: '15' }, actualExpense: '400' });
    assert.equal(at19.fuelAllowance.maxAllowed, '361.69');
    assert.equal(at15.fuelAllowance.maxAllowed, '458.14'); // 361.6905577 × 19 / 15
    assert.equal(at19.fuelOverspend, '38.31');
    assert.equal(at15.fuelOverspend, '0.00');
  });

  test('per-trip fuel reimbursement still works and has no allowance', () => {
    const r = run({ settings: { ...PER_TRIP, fuelMethod: 'PER_TRIP', fuelReimbursementEnabled: true, fuelReimbursementRate: '1.25' } });
    assert.equal(r.fuelReimbursement, '201.25'); // 161 trips × $1.25
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
