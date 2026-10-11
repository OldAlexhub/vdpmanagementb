import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { calculateVdp, serializeResult } from '../src/services/calculationEngine.js';
import { calculateUberVdp, serializeUberResult } from '../src/services/uberCalculationEngine.js';
import { planTemplates } from '../src/services/planTemplates.js';
import { validateVersion } from '../src/services/planService.js';
import { versionInput } from '../src/controllers/planController.js';
import VdpPlan from '../src/models/VdpPlan.js';

const templates = planTemplates();
const template = (id) => templates.find((item) => item.id === id);
const standardSettings = (id, overrides = {}) => {
  const version = template(id).version;
  return {
    ...version,
    tuiEligible: version.incentiveEnabled,
    fuelReimbursementEnabled: version.fuelMethod === 'PER_TRIP',
    ...overrides,
  };
};
const week = (overrides = {}) => ({ weekNumber: 1, trips: '0', actualHours: '0', ...overrides });

describe('audited VDP document templates', () => {
  test('has editable starters for every plan document and partner-rate variant', async () => {
    assert.equal(templates.length, 30);
    assert.equal(new Set(templates.map((item) => item.id)).size, templates.length);
    assert.equal(templates.every((item) => item.sourceDocument), true);
    for (const item of templates) {
      assert.deepEqual(validateVersion({ ...item.version, effectiveFrom: new Date('2026-01-01') }), [], item.id);
      const parsed = versionInput({ ...item.version, effectiveFrom: '2026-01-01' });
      const document = new VdpPlan({
        divisionId: new mongoose.Types.ObjectId(), name: item.name,
        versions: [{ ...parsed, versionNumber: 1 }],
      });
      await assert.doesNotReject(document.validate(), `${item.id} persists in the plan schema`);
    }
    const copy = planTemplates();
    copy[0].name = 'Edited by user';
    assert.notEqual(planTemplates()[0].name, 'Edited by user', 'template selections are independent editable copies');
  });

  test('DIV 10 day uses incentive-window attainment and sixth-day trip bonus', () => {
    const result = serializeResult(calculateVdp({
      settings: standardSettings('div10-day'),
      operators: [{ name: 'Day operator', contractedHours: '50', weeks: [week({ trips: '100', actualHours: '50', attainmentHours: '49', workedDays: '6', bonusTrips: '10' })] }],
    }));
    assert.equal(result.weeks[0].performancePercentage, '98');
    assert.equal(result.weeks[0].incentiveRate, '24.75');
    assert.equal(result.weeks[0].bonusHours, '10');
    assert.equal(result.weeks[0].weeklyEarnings, '2487.40');
    assert.equal(result.weeks[0].regularTrips, '90');
    assert.equal(result.weeks[0].coreEarnings, '2227.50');
    assert.equal(result.weeks[0].bonusEarnings, '259.90');
  });

  test('DIV 10 day derives sixth-day trips from dated performance rows', () => {
    const result = serializeResult(calculateVdp({
      settings: standardSettings('div10-day'),
      operators: [{ name: 'Day operator', contractedHours: '50', weeks: [week({
        trips: '60', actualHours: '50', attainmentHours: '50', workedDays: '6',
        tripDays: [1, 2, 3, 4, 5, 6].map((day) => ({ date: `2026-09-${day + 6}`, trips: '10' })),
      })] }],
    }));
    assert.equal(result.weeks[0].bonusHours, '10');
    assert.equal(result.weeks[0].weeklyEarnings, '1497.40');
  });

  test('DIV 10 night pays actual hours but selects its tier from incentive-window hours', () => {
    const result = serializeResult(calculateVdp({
      settings: standardSettings('div10-night'),
      operators: [{ name: 'Night operator', contractedHours: '56', weeks: [week({ actualHours: '60', attainmentHours: '44.8' })] }],
    }));
    assert.equal(result.weeks[0].performancePercentage, '80');
    assert.equal(result.weeks[0].incentiveRate, '27');
    assert.equal(result.weeks[0].bonusHours, '4');
    assert.equal(result.weeks[0].weeklyEarnings, '1635.24');
  });

  test('DIV 11 withholds above-contract bonus until full incentive-hour qualification', () => {
    const result = serializeResult(calculateVdp({
      settings: standardSettings('div11-standard'),
      weeks: [week({ contractedHours: '49.5', actualHours: '55', attainmentHours: '48' })],
    }));
    assert.equal(result.weeks[0].bonusQualified, false);
    assert.equal(result.weeks[0].bonusHours, '0');
    assert.equal(result.weeks[0].corePaidHours, '49.5');
  });

  test('a week-specific contracted-hours input overrides the plan default', () => {
    const result = serializeResult(calculateVdp({
      settings: standardSettings('div8-standard'),
      weeks: [week({ contractedHours: '40', actualHours: '40', attainmentHours: '40' })],
    }));
    assert.equal(result.weeks[0].contractedHours, '40');
    assert.equal(result.weeks[0].performancePercentage, '100');
  });

  test('DIV 3 DART chooses one tier across all active provider operators', () => {
    const settings = standardSettings('div3-dart');
    const result = serializeResult(calculateVdp({ settings, operators: [
      { name: 'A', contractedHours: '100', weeks: [week({ actualHours: '90', attainmentHours: '90' })] },
      { name: 'B', contractedHours: '100', weeks: [week({ actualHours: '100', attainmentHours: '100' })] },
    ] }));
    assert.deepEqual(result.operators.map((operator) => operator.weeks[0].performancePercentage), ['95', '95']);
    assert.deepEqual(result.operators.map((operator) => operator.weeks[0].incentiveRate), ['27.2', '27.2']);
    assert.equal(result.gross, '5168.00');
  });

  test('DIV 3 $32 schedule reconciles the Azalea accounting workbook example', () => {
    const result = serializeResult(calculateVdp({
      settings: standardSettings('div3-dart'),
      operators: [{ name: 'Iralyn Houston', contractedHours: '41.5', weeks: [
        week({ weekNumber: 1, actualHours: '40.87', attainmentHours: '44.98' }),
        week({ weekNumber: 2, actualHours: '38.32', attainmentHours: '43.93' }),
      ] }],
    }));

    assert.deepEqual(result.weeks.map((entry) => entry.performancePercentage), ['100', '100']);
    assert.deepEqual(result.weeks.map((entry) => entry.incentiveRate), ['32', '32']);
    assert.deepEqual(result.weeks.map((entry) => entry.baseEarnings), ['1046.27', '980.99']);
    assert.deepEqual(result.weeks.map((entry) => entry.contractHoursIncentive), ['261.57', '245.25']);
    assert.deepEqual(result.weeks.map((entry) => entry.weeklyEarnings), ['1307.84', '1226.24']);
    assert.equal(result.gross, '2534.08');
  });

  test('DIV 3 $34 schedule remains available for the workbook partners assigned that rate', () => {
    const result = serializeResult(calculateVdp({
      settings: standardSettings('div3-dart-34'),
      weeks: [week({ actualHours: '10', contractedHours: '10', attainmentHours: '10' })],
    }));
    assert.equal(result.weeks[0].incentiveRate, '34');
    assert.equal(result.gross, '340.00');
  });

  test('DIV 5 rate card adds vehicle/service pricing and weekend differential', () => {
    const result = serializeResult(calculateVdp({
      settings: standardSettings('div5-service-rate-card', { fuelMethod: 'NONE' }),
      weeks: [week({ actualHours: '15', trips: '2', serviceMiles: '12', lineItems: [
        { hours: '10', serviceType: 'CCCTA', vehicleType: 'WAV', dayType: 'WEEKDAY' },
        { hours: '5', serviceType: 'County Connection', vehicleType: 'WAV', dayType: 'WEEKEND' },
        { trips: '2', miles: '12', serviceType: 'OS', vehicleType: 'WC', dayType: 'WEEKDAY' },
      ] })],
    }));
    assert.equal(result.gross, '534.50');
    assert.deepEqual(result.weeks[0].rateCardBreakdown.map((line) => line.name), [
      'CCCTA Link wheelchair hours', 'CCCTA Link wheelchair hours', 'Weekend differential',
      'One Seat wheelchair load', 'One Seat wheelchair miles',
    ]);
  });

  test('DIV 13 selects an attainment card and applies distance bands plus excess miles', () => {
    const result = serializeResult(calculateVdp({
      settings: standardSettings('div13-distance'),
      weeks: [week({ contractedHours: '57.5', actualHours: '57.5', attainmentHours: '56.35', trips: '3', serviceMiles: '20', lineItems: [
        { trips: '1', miles: '4', distance: '4' }, { trips: '1', miles: '6', distance: '6' }, { trips: '1', miles: '10', distance: '10' },
      ] })],
    }));
    assert.equal(result.weeks[0].performancePercentage, '98');
    assert.equal(result.weeks[0].tierLabel, '98%+ incentive rate');
    assert.equal(result.gross, '71.68');
  });

  test('partner-rate presets retain the documented exceptional schedules', () => {
    const div6 = serializeResult(calculateVdp({
      settings: standardSettings('div6-door-to-door-125-fuel'),
      weeks: [week({ trips: '2' })],
    }));
    assert.equal(div6.gross, '44.00');
    assert.equal(div6.fuelReimbursement, '2.50');
    assert.equal(div6.net, '46.50');

    const div7 = serializeResult(calculateVdp({
      settings: standardSettings('div7-legacy-hourly'),
      weeks: [week({ contractedHours: '40', actualHours: '45' })],
    }));
    assert.equal(div7.weeks[0].coreEarnings, '1112.40');
    assert.equal(div7.weeks[0].bonusEarnings, '190.55');

    const div10 = serializeResult(calculateVdp({
      settings: standardSettings('div10-night-operational'),
      operators: [{ name: 'Night operator', contractedHours: '40', weeks: [week({ actualHours: '40', attainmentHours: '40' })] }],
    }));
    assert.equal(div10.weeks[0].incentiveRate, '28.8556');

    assert.equal(template('div11-bonus-2730').version.bonusRate, '27.30');
    assert.equal(template('div8-no-bonus').version.bonusEnabled, false);
    assert.equal(template('div2-uber-wav-qtell').version.uberConfig.hourlyRateBands[0].hourlyRate, '31.50');
  });

  test('standby supports a weekly guarantee amount and force-majeure proration', () => {
    const result = serializeResult(calculateVdp({
      settings: standardSettings('div7-xpress', { contractedHours: '50', fuelMethod: 'NONE' }),
      weeks: [week({ standbyStatus: 'FORCE_MAJEURE', standbyGuaranteeAmount: '2500', standbyProration: '0.8' })],
    }));
    assert.equal(result.weeks[0].standby.guaranteedEarnings, '2000.00');
    assert.equal(result.gross, '2000.00');
  });

  test('actual fuel reimbursement and fuel-price threshold surcharge are additions after Gross', () => {
    const actual = serializeResult(calculateVdp({
      settings: standardSettings('div7-xpress', { contractedHours: '1' }),
      weeks: [week({ actualHours: '1' })],
      fuel: { actualExpense: '75.25' },
    }));
    assert.equal(actual.fuelActualReimbursement, '75.25');
    assert.equal(actual.gross, '50.00');
    assert.equal(actual.net, '125.25');

    const surcharge = serializeResult(calculateVdp({
      settings: standardSettings('div5-service-rate-card'),
      weeks: [week({ lineItems: [] })],
      fuel: { days: [{ date: '2026-10-01', week: 1, serviceMiles: '120', mpg: '12', pricePerGallon: '5.00' }] },
    }));
    assert.equal(surcharge.fuelSurcharge.amount, '4.00');
    assert.equal(surcharge.net, '4.00');
  });
});

describe('documented Uber provider-wide rules', () => {
  test('provider scope aggregates active units before selecting every incentive tier', () => {
    const settings = template('div12-uber-wav').version.uberConfig;
    const row = (driverUuid, supply) => ({
      week: '2026-09-07', driverUuid, calculationUnitId: `vehicle:${driverUuid}`, incentiveGroup: 'div12-plan',
      settings: { baseHourlyRate: '32.50', contractedWeeklyHours: '50' },
      totalSupplyHours: supply, pausedHours: '0', coreHoursTotalSupplyHours: '30', utilizedHours: '40',
      totalAccepts: '100', totalRejects: '0', totalExpiredOffers: '0', totalCancels: '0',
      driverEarningsExclTips: '0', driverTips: '0',
    });
    const result = serializeUberResult(calculateUberVdp({ settings, rows: [row('a', '40'), row('b', '60')] }));
    assert.deepEqual(result.uberRows.map((entry) => entry.fulfillment), ['1', '1']);
    assert.deepEqual(result.uberRows.map((entry) => entry.hourIncentivePct), ['0.2', '0.2']);
    assert.deepEqual(result.uberRows.map((entry) => entry.incentiveScope), ['PROVIDER', 'PROVIDER']);
  });

  test('core-hour failure can be configured to remove otherwise earned incentives', () => {
    const settings = { ...template('div3-uber-d2d').version.uberConfig, coreHoursFailureBehavior: 'INELIGIBLE' };
    const result = serializeUberResult(calculateUberVdp({ settings, rows: [{
      week: '2026-09-07', driverUuid: 'driver', settings: { baseHourlyRate: '28.50', contractedWeeklyHours: '50' },
      totalSupplyHours: '50', pausedHours: '0', coreHoursTotalSupplyHours: '40',
      totalAccepts: '100', totalRejects: '0', totalExpiredOffers: '0', totalCancels: '0',
      driverEarningsExclTips: '0', driverTips: '0',
    }] }));
    assert.equal(result.uberRows[0].qualifiedByFulfillment, true);
    assert.equal(result.uberRows[0].coreHoursPassed, false);
    assert.equal(result.uberRows[0].qualifiedForIncentives, false);
    assert.equal(result.uberRows[0].hourIncentivePct, '0');
  });
});

