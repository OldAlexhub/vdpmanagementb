import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calculateVdp, serializeResult, calculateLease, CalculationError } from '../src/services/calculationEngine.js';
import { validateTiers, selectTier } from '../src/services/tiers.js';

const DIV10_TIERS = [
  { minimumPercentage: '0', maximumPercentage: '79.99', rate: '25.97' },
  { minimumPercentage: '80', maximumPercentage: '86.99', rate: '26.55' },
  { minimumPercentage: '87', maximumPercentage: '94.99', rate: '27.41' },
  { minimumPercentage: '95', maximumPercentage: '99.99', rate: '28.13' },
  { minimumPercentage: '100', maximumPercentage: null, rate: '28.86' },
];

const NIGHT = {
  paymentType: 'HOURLY',
  basePay: '25.97',
  contractedHours: '40',
  tuiEligible: true,
  incentiveTiers: DIV10_TIERS,
  bonusEnabled: true,
  bonusRate: '34.62',
};

const LEASE = { amount: '197.50', frequency: 'WEEKLY' };

const week = (n, hours, trips = 0) => ({ weekNumber: n, trips: String(trips), actualHours: String(hours) });

const run = (hours1, hours2 = hours1, extra = {}) =>
  serializeResult(
    calculateVdp({
      settings: { ...NIGHT, ...(extra.settings || {}) },
      weeks: [week(1, hours1), week(2, hours2)],
      lease: extra.lease ?? LEASE,
      adjustments: extra.adjustments ?? [],
    }),
  );

describe('incentive tiers', () => {
  test('below 80% pays base', () => {
    const r = run('30');
    assert.equal(r.weeks[0].incentiveRate, '25.97');
    assert.equal(r.weeks[0].performancePercentage, '75');
    assert.equal(r.weeks[0].coreEarnings, '779.10');
  });
  test('79.995% stays in the lowest tier (no rounding before selection)', () => {
    assert.equal(selectTier(DIV10_TIERS, '79.995').rate, '25.97');
  });
  test('exactly 80% threshold', () => {
    const r = run('32');
    assert.equal(r.weeks[0].incentiveRate, '26.55');
    assert.equal(r.weeks[0].coreEarnings, '849.60');
  });
  test('exactly 87% threshold', () => {
    assert.equal(run('34.8').weeks[0].incentiveRate, '27.41');
  });
  test('exactly 95% threshold', () => {
    assert.equal(run('38').weeks[0].incentiveRate, '28.13');
  });
  test('exactly 100% — top tier, no bonus', () => {
    const w = run('40').weeks[0];
    assert.equal(w.incentiveRate, '28.86');
    assert.equal(w.bonusHours, '0');
    assert.equal(w.weeklyEarnings, '1154.40');
  });
  test('above 100% — top tier plus bonus hours', () => {
    const w = run('49.27').weeks[0];
    assert.equal(w.performancePercentage, '123.175');
    assert.equal(w.incentiveRate, '28.86');
    assert.equal(w.corePaidHours, '40');
    assert.equal(w.bonusHours, '9.27');
    assert.equal(w.coreEarnings, '1154.40');
    assert.equal(w.bonusEarnings, '320.93');
    assert.equal(w.weeklyEarnings, '1475.33');
  });
  test('tier validation catches overlap, gaps, order and missing rate', () => {
    assert.deepEqual(validateTiers(DIV10_TIERS), []);
    assert.match(validateTiers([{ minimumPercentage: '0', maximumPercentage: '85', rate: '1' },
      { minimumPercentage: '80', maximumPercentage: null, rate: '2' }]).join(), /overlaps/);
    assert.match(validateTiers([{ minimumPercentage: '0', maximumPercentage: '79.99', rate: '1' },
      { minimumPercentage: '85', maximumPercentage: null, rate: '2' }]).join(), /Gap/);
    assert.match(validateTiers([{ minimumPercentage: '0', maximumPercentage: null, rate: '1' },
      { minimumPercentage: '85', maximumPercentage: null, rate: '2' }]).join(), /only the last tier/);
    assert.match(validateTiers([{ minimumPercentage: '0', maximumPercentage: null, rate: '' }]).join(), /rate is required/);
    assert.match(validateTiers([{ minimumPercentage: '10', maximumPercentage: null, rate: '1' }]).join(), /start at 0%/);
  });
});

describe('hours and bonus', () => {
  test('no bonus when at or below contract', () => {
    const w = run('38.5').weeks[0];
    assert.equal(w.bonusHours, '0');
    assert.equal(w.bonusEarnings, '0.00');
    assert.equal(w.corePaidHours, '38.5');
  });
  test('zero hours', () => {
    const r = run('0', '0');
    assert.equal(r.weeks[0].incentiveRate, '25.97');
    assert.equal(r.gross, '0.00');
    assert.equal(r.net, '-395.00');
  });
  test('bonus disabled pays all hours at the tier rate', () => {
    const w = run('45', '45', { settings: { bonusEnabled: false } }).weeks[0];
    assert.equal(w.bonusHours, '0');
    assert.equal(w.corePaidHours, '45');
    assert.equal(w.coreEarnings, '1298.70'); // 45 × 28.86
  });
  test('provider override of contracted hours changes attainment and bonus', () => {
    const w = run('40', '40', { settings: { contractedHours: '35' } }).weeks[0];
    assert.equal(w.contractedHours, '35');
    assert.equal(w.incentiveRate, '28.86');
    assert.equal(w.bonusHours, '5');
    assert.equal(w.coreEarnings, '1010.10'); // 35 × 28.86
    assert.equal(w.bonusEarnings, '173.10'); // 5 × 34.62
  });
  test('TUI switched off pays base rate even at 100%+', () => {
    const w = run('49.27', '40', { settings: { tuiEligible: false } }).weeks[0];
    assert.equal(w.incentiveRate, '25.97');
    assert.equal(w.coreEarnings, '1038.80');
    assert.equal(w.bonusEarnings, '320.93');
  });
  test('zero contracted hours is rejected for hourly plans', () => {
    assert.throws(() => run('10', '10', { settings: { contractedHours: '0' } }), CalculationError);
  });
});

describe('per-trip plans (DIV 10 AM routes)', () => {
  test('trips × $21.50, no TUI, no bonus', () => {
    const r = serializeResult(calculateVdp({
      settings: { paymentType: 'PER_TRIP', basePay: '21.50', contractedHours: '50', tuiEligible: false,
        incentiveTiers: [], bonusEnabled: false, bonusRate: null },
      weeks: [{ weekNumber: 1, trips: '64', actualHours: '52' }, { weekNumber: 2, trips: '64', actualHours: '51' }],
      lease: LEASE,
    }));
    assert.equal(r.weeks[0].weeklyEarnings, '1376.00');
    assert.equal(r.gross, '2752.00'); // AL Care accounting example: 128 trips → $2,752
    assert.equal(r.net, '2357.00');
  });
});

describe('lease', () => {
  test('weekly lease × 2 weeks', () => {
    assert.equal(run('40').lease, '395.00');
  });
  test('weekly lease with fewer weeks charged', () => {
    assert.equal(calculateLease({ ...LEASE, weeksCharged: '0.6' }, 2).amount.toFixed(2), '118.50');
    assert.equal(calculateLease({ ...LEASE, weeksCharged: '1' }, 2).amount.toFixed(2), '197.50');
  });
  test('per-cycle lease charged once', () => {
    assert.equal(run('40', '40', { lease: { amount: '300', frequency: 'PER_VDP_CYCLE' } }).lease, '300.00');
  });
  test('no lease', () => {
    assert.equal(run('40', '40', { lease: { amount: '197.50', frequency: 'NONE' } }).lease, '0.00');
  });
});

describe('adjustments and net', () => {
  const adjustments = [
    { type: 'FARES', amount: '25.20' },
    { type: 'FUEL', amount: '10' },
    { type: 'VIOLATION', amount: '50' },
    { type: 'REIMBURSEMENT', amount: '12.34' },
    { type: 'OTHER_INCOME', amount: '100' },
  ];
  test('deductions and additions', () => {
    const r = run('40', '40', { adjustments });
    assert.equal(r.gross, '2308.80');
    assert.equal(r.fares, '25.20');
    assert.equal(r.otherDeductions, '60.00');
    assert.equal(r.totalDeductions, '480.20'); // 395 + 25.20 + 60
    assert.equal(r.totalAdditions, '112.34');
    assert.equal(r.net, '1940.94'); // 2308.80 − 480.20 + 112.34
  });
  test('negative amounts and unknown types are rejected', () => {
    assert.throws(() => run('40', '40', { adjustments: [{ type: 'FARES', amount: '-1' }] }), CalculationError);
    assert.throws(() => run('40', '40', { adjustments: [{ type: 'BOGUS', amount: '1' }] }), CalculationError);
  });
});

describe('two-week aggregation', () => {
  test('weeks are independent — not one 80-hour block', () => {
    // 60 + 20 = 80h. As one block it would be 100% with no bonus.
    const r = run('60', '20');
    assert.equal(r.weeks[0].bonusHours, '20');
    assert.equal(r.weeks[0].weeklyEarnings, '1846.80'); // 40×28.86 + 20×34.62
    assert.equal(r.weeks[1].incentiveRate, '25.97'); // 50%
    assert.equal(r.weeks[1].weeklyEarnings, '519.40');
    assert.equal(r.gross, '2366.20');
  });
});

describe('DIV 10 regression — RIMO / Lisa Moore / route 918 / 08/24–09/06/2026', () => {
  test('Performance Report Total Hours with configured plan rates', () => {
    const r = serializeResult(calculateVdp({
      settings: NIGHT,
      weeks: [
        { weekNumber: 1, trips: '46', actualHours: '49.27' },
        { weekNumber: 2, trips: '37', actualHours: '40.23' },
      ],
      lease: LEASE,
      adjustments: [{ type: 'FARES', amount: '25.20' }],
    }));
    const [w1, w2] = r.weeks;
    assert.equal(w1.actualHours, '49.27');
    assert.equal(w2.actualHours, '40.23');
    assert.equal(w1.bonusHours, '9.27');
    assert.equal(w2.bonusHours, '0.23');
    assert.equal(w1.weeklyEarnings, '1475.33');
    assert.equal(w2.weeklyEarnings, '1162.36');
    assert.equal(r.gross, '2637.69'); // analysis.R: 2637.69
    assert.equal(r.lease, '395.00');
    assert.equal(r.net, '2217.49');
  });

  test('engine reproduces Accounting exactly given Accounting inputs (manifest hours, exact tier rate)', () => {
    const accountingTiers = DIV10_TIERS.map((t) => ({ ...t }));
    accountingTiers[4].rate = '28.8556'; // 25.97 + 2.8856
    const r = calculateVdp({
      settings: { ...NIGHT, incentiveTiers: accountingTiers },
      weeks: [
        { weekNumber: 1, trips: '46', actualHours: '49.283333333333324' },
        { weekNumber: 2, trips: '37', actualHours: '40.216666666666654' },
      ],
      lease: LEASE,
      adjustments: [{ type: 'FARES', amount: '25.20' }],
    });
    // Accounting keeps lines unrounded: 1475.613 + 1161.725 = 2637.338 (→ 2637.34), net 2217.138.
    // The app rounds each earnings line to cents so the statement adds up line by line:
    // W1 1154.22 + 321.39 = 1475.61, W2 1154.22 + 7.50 = 1161.72 → 2637.33 (1¢ rounding boundary).
    const [w1, w2] = r.weeks;
    assert.equal(w1.coreEarnings.plus(w1.bonusEarnings).toFixed(2), '1475.61');
    assert.equal(w2.weeklyEarnings.toFixed(2), '1161.72');
    assert.equal(r.gross.toFixed(2), '2637.33');
    assert.equal(r.net.toFixed(2), '2217.13');
    // Same inputs without line rounding equal Accounting to the tenth of a cent.
    const unrounded = [w1, w2].reduce((acc, w) => acc + Number(w.corePaidHours.times(w.incentiveRate)
      .plus(w.bonusHours.times(w.bonusRate)).toFixed(3)), 0);
    assert.equal(unrounded.toFixed(3), '2637.338');
  });
});
