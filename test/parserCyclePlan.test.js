import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePerformanceGrid, parsePerformanceFile, hoursForMetric, ReportFormatError } from '../src/services/performanceParser.js';
import { cycleDates, generateCycles, cycleStartFor, isoDate, weekOf, endOfDayIn } from '../src/services/cycleService.js';
import { resolveSettings, resolveVersion, validateVersion } from '../src/services/planService.js';
import { sum } from '../src/services/money.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Minimal grid shaped like the Trapeze report (group row, header, sub-header, banners, totals).
const GRID = [
  [null, null, 'Paratransit Operation Report'],
  [null, null, 'From: 08/24/2026 To: 09/06/2026'],
  [null, '', null, '', '', 'Trips ', null, 'Miles', null, 'Hours'],
  [null, 'Date', null, 'Run/Route', 'Rt', 'Total Prov', 'Total Req ', 'Service', 'Rev', 'Service', 'Reven', 'Slk Time (mins)', 'Total Hours'],
  [null, '', null, '', '', '', '#'],
  [null, '08/24/2026', null, '', ''],
  [null, '08/24/2026', null, '918', 1, '5', 5, '182.9', '150', '7.54', '5.56', '9.28', '8.03'],
  [null, '08/24/2026', null, '918', 2, '1', 1, '10', '9', '0.50', '0.40', '0', '0.52'],
  [null, '08/24/2026', null, '901', 1, 16, 16, '139.7', '120', '10.9', '9.1', '2', '11.4'],
  [null, 'Sub Total', null, '', '', 22, 22, '', '', '', '', '', '19.95'],
  [null, '08/31/2026', null, '918', 1, '6', 6, '100', '90', '7.54', '4.13', '16.4', '8.05'],
  [null, '09/07/2026', null, '918', 1, '9', 9, '100', '90', '7', '6', '1', '9'],
  [null, 'Grand Total', null, '', '', 999, 999, '', '', '', '', '', '999'],
];

describe('performance report parser', () => {
  const parsed = parsePerformanceGrid(GRID, { from: '2026-08-24', to: '2026-09-06' });

  test('detects columns by name within the Hours group', () => {
    assert.equal(parsed.detectedColumns.TOTAL_HOURS, true);
    assert.equal(parsed.detectedColumns.SERVICE_HOURS, true);
    assert.deepEqual(parsed.detectedColumns.otherHourColumns, ['Slk Time (mins)']);
    assert.deepEqual(parsed.reportRange, { from: '2026-08-24', to: '2026-09-06' });
  });
  test('drops banners, subtotals, grand totals and dates outside the cycle', () => {
    assert.equal(parsed.stats.skippedTotals, 2);
    assert.equal(parsed.stats.skippedBanners, 1);
    assert.equal(parsed.stats.outsideCycle, 1);
  });
  test('sums rows by date + route and keeps the Hours→Service column separate from Miles→Service', () => {
    const r = parsed.rows.find((x) => x.date === '2026-08-24' && x.route === '918');
    assert.equal(r.trips, '6');
    assert.equal(r.totalHours, '8.55');
    assert.equal(r.serviceHours, '8.04');
    assert.equal(r.revenueHours, '5.96');
    assert.equal(hoursForMetric(r, 'OTHER', 'Slk Time (mins)'), '9.28');
    assert.equal(parsed.rows.length, 3);
  });
  test('rejects files without the required header', () => {
    assert.throws(() => parsePerformanceGrid([['Name', 'Hours'], ['x', 1]]), ReportFormatError);
  });
  test('real DIV 10 report: route 918 Total Hours = 89.50, Total Prov = 83', async () => {
    const file = path.join(here, 'fixtures', 'performance-report-2026-08-01_to_09-09.xlsx');
    const cycle = cycleDates('2026-08-24');
    const r = await parsePerformanceFile(fs.readFileSync(file), file, { from: '2026-08-24', to: '2026-09-06' });
    const rows = r.rows.filter((x) => x.route === '918');
    const wk = (n) => rows.filter((x) => weekOf(x.date, cycle) === n);
    assert.equal(sum(wk(1).map((x) => x.totalHours)).toString(), '49.27');
    assert.equal(sum(wk(2).map((x) => x.totalHours)).toString(), '40.23');
    assert.equal(sum(rows.map((x) => x.totalHours)).toFixed(2), '89.50');
    assert.equal(sum(wk(1).map((x) => x.trips)).toString(), '46');
    assert.equal(sum(wk(2).map((x) => x.trips)).toString(), '37');
    // Service hours differ — confirms the metric choice matters.
    assert.equal(sum(wk(1).map((x) => x.serviceHours)).toString(), '46.38');
  });
});

describe('cycle generation', () => {
  test('14-day cycle, weeks, submission and payment dates', () => {
    const c = cycleDates('2026-08-24');
    assert.equal(isoDate(c.cycleEnd), '2026-09-06');
    assert.equal(isoDate(c.week1End), '2026-08-30');
    assert.equal(isoDate(c.week2Start), '2026-08-31');
    assert.equal(isoDate(c.submissionDate), '2026-09-21');
    assert.equal(isoDate(c.paymentDate), '2026-09-25');
  });
  test('aligns any date to its cycle, forwards and backwards from the anchor', () => {
    assert.equal(isoDate(cycleStartFor('2026-09-06')), '2026-08-24');
    assert.equal(isoDate(cycleStartFor('2026-09-07')), '2026-09-07');
    assert.equal(isoDate(cycleStartFor('2026-08-23')), '2026-08-10');
    // 2026 contract schedule: cycle ending 12/28/2025 → submission 1/12/2026, pay 1/16/2026.
    const c = generateCycles('2025-12-20', 1)[0];
    assert.equal(isoDate(c.cycleStart), '2025-12-15');
    assert.equal(isoDate(c.submissionDate), '2026-01-12');
    assert.equal(isoDate(c.paymentDate), '2026-01-16');
  });
});

describe('provider approval deadline', () => {
  test('ends at local midnight after the Closed for Submission date', () => {
    // 09/21/2026 is daylight time: Portland UTC-7, Detroit UTC-4.
    assert.equal(endOfDayIn('2026-09-21', 'America/Los_Angeles').toISOString(), '2026-09-22T07:00:00.000Z');
    assert.equal(endOfDayIn('2026-09-21', 'America/Detroit').toISOString(), '2026-09-22T04:00:00.000Z');
    // Standard time, and the DST change weekend.
    assert.equal(endOfDayIn('2026-01-12', 'America/Los_Angeles').toISOString(), '2026-01-13T08:00:00.000Z');
    assert.equal(endOfDayIn('2026-11-01', 'America/Los_Angeles').toISOString(), '2026-11-02T08:00:00.000Z');
  });
});

describe('plan inheritance and versions', () => {
  const version = {
    _id: 'v1', versionNumber: 1, effectiveFrom: new Date('2026-05-25'), effectiveTo: new Date('2026-12-31'),
    paymentType: 'HOURLY', basePay: '25.97', contractedHours: '40', incentiveEnabled: true,
    incentiveTiers: [{ minimumPercentage: '0', maximumPercentage: null, rate: '25.97' }],
    bonusEnabled: true, bonusRate: '34.62', performanceHourMetric: 'TOTAL_HOURS',
  };
  const v2 = { ...version, _id: 'v2', versionNumber: 2, effectiveFrom: new Date('2027-01-01'), effectiveTo: null, basePay: '26.50' };
  const plan = { _id: 'p', name: 'Night Service', versions: [version, v2] };

  test('provider inherits plan values unless overridden', () => {
    const s = resolveSettings({ overrides: { contractedHours: '35', tuiEligibility: 'INHERIT' } }, plan, version);
    assert.deepEqual(s.contractedHours, { value: '35', source: 'PROVIDER_OVERRIDE' });
    assert.deepEqual(s.basePay, { value: '25.97', source: 'PLAN' });
    assert.deepEqual(s.tuiEligible, { value: true, source: 'PLAN' });
    const off = resolveSettings({ overrides: { tuiEligibility: 'OFF' } }, plan, version);
    assert.deepEqual(off.tuiEligible, { value: false, source: 'PROVIDER_OVERRIDE' });
  });
  test('cycle resolves the version effective on its start date', () => {
    assert.equal(resolveVersion(plan, cycleDates('2026-08-24')).version._id, 'v1');
    assert.equal(resolveVersion(plan, cycleDates('2027-01-04')).version._id, 'v2');
    const straddle = resolveVersion(plan, cycleDates('2026-12-28'));
    assert.equal(straddle.version._id, 'v1');
    assert.equal(straddle.changesMidCycle, true);
  });
  test('version validation', () => {
    assert.deepEqual(validateVersion(version), []);
    assert.ok(validateVersion({ ...version, contractedHours: null }).length);
    assert.ok(validateVersion({ ...version, bonusRate: null }).length);
    assert.ok(validateVersion({ ...version, paymentType: 'PER_TRIP', bonusEnabled: true }).length);
  });
});
