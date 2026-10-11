// One-time, idempotent reconciliation of the live Division 3 ADA/GoLink plans
// to artifacts/VPDs/DIV3/VDP AUTOMATION/DIV3 Partner Rates.xlsx.
//
// Most partners use the $32 revenue-hour schedule. The six workbook partners
// listed at $34 retain that schedule. Orion Transit is intentionally skipped
// until it exists in Compass/the application roster.
import 'dotenv/config';
import { connectDb, disconnectDb } from '../src/config/db.js';
import Division from '../src/models/Division.js';
import Provider from '../src/models/Provider.js';
import Vdp from '../src/models/Vdp.js';
import VdpPlan from '../src/models/VdpPlan.js';
import { validateVersion } from '../src/services/planService.js';
import { recalculate } from '../src/services/vdpService.js';

const APPLY = process.argv.includes('--apply');
const EDITABLE = ['DRAFT', 'NEEDS_REVIEW', 'READY'];
const LOCKED = ['APPROVED', 'DISPUTED', 'PROCESSED', 'PAID'];

const SCHEDULES = {
  '32': {
    basePay: '25.60',
    tiers: [
      ['0', '93.99', '25.60'],
      ['94', '95.99', '27.20'],
      ['96', '97.99', '28.80'],
      ['98', null, '32.00'],
    ],
  },
  '34': {
    basePay: '27.20',
    tiers: [
      ['0', '93.99', '27.20'],
      ['94', '95.99', '28.90'],
      ['96', '97.99', '30.60'],
      ['98', null, '34.00'],
    ],
  },
};

const planNames = {
  ada32: 'DIV 3 DART MMS — $32 revenue rate',
  ada34: 'DIV 3 DART MMS — $34 revenue rate',
  gl32: 'DIV 3 DART GLINK — $32 revenue rate',
  gl34: 'DIV 3 DART GLINK — $34 revenue rate',
};

function configureVersion(version, revenueRate) {
  const schedule = SCHEDULES[revenueRate];
  version.calculationType = 'STANDARD';
  version.paymentType = 'HOURLY';
  version.rateStructureType = 'SIMPLE';
  version.basePay = schedule.basePay;
  version.contractedHours = null;
  version.contractedHoursMode = 'OPERATOR_PROFILE';
  version.incentiveEnabled = true;
  version.incentiveTiers = schedule.tiers.map(([minimumPercentage, maximumPercentage, rate]) => ({
    minimumPercentage,
    maximumPercentage,
    rate,
  }));
  version.attainmentHourMetric = 'OTHER';
  version.attainmentHourColumn = 'Incentive Hours';
  version.attainmentScope = 'PROVIDER';
  version.attainmentPercentageCap = '100';
  version.bonusEnabled = false;
  version.bonusRate = null;
  version.notes = `Reconciled to the Accounting partner-rate workbook: $${revenueRate} full revenue-hour rate, 80% core revenue, 94/96/98% fulfillment tiers, and fulfillment capped at 100%.`;
  const errors = validateVersion(version);
  if (errors.length) throw new Error(`Invalid $${revenueRate} Division 3 version: ${errors.join(' ')}`);
}

function newPlan(divisionId, name, revenueRate) {
  const version = {
    versionNumber: 1,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    performanceHourMetric: 'TOTAL_HOURS',
    performanceHourColumn: null,
    standbyGuaranteeEnabled: false,
    fuelMethod: 'NONE',
  };
  configureVersion(version, revenueRate);
  return new VdpPlan({
    divisionId,
    name,
    status: 'ACTIVE',
    notes: 'Created from the Division 3 Accounting partner-rate workbook reconciliation.',
    versions: [version],
  });
}

async function oneDivision(number) {
  const matches = await Division.find({ divisionNumber: number });
  if (matches.length !== 1) throw new Error(`Expected exactly one DIV ${number}; found ${matches.length}.`);
  return matches[0];
}

async function onePlan(names) {
  const matches = await VdpPlan.find({ name: { $in: names } });
  if (matches.length !== 1) throw new Error(`Expected one plan named ${names.join(' or ')}; found ${matches.length}.`);
  return matches[0];
}

async function exactProviders(divisionId, names) {
  const providers = await Provider.find({ divisionId, name: { $in: names } });
  const found = new Set(providers.map((provider) => provider.name));
  const missing = names.filter((name) => !found.has(name));
  if (missing.length) throw new Error(`Missing expected provider(s): ${missing.join(', ')}.`);
  const duplicates = names.filter((name) => providers.filter((provider) => provider.name === name).length !== 1);
  if (duplicates.length) throw new Error(`Expected one provider for: ${duplicates.join(', ')}.`);
  const customOperators = providers.flatMap((provider) => provider.operators
    .filter((operator) => operator.planId)
    .map((operator) => `${provider.name} / ${operator.name}`));
  if (customOperators.length) throw new Error(`Provider(s) have operator-specific plans that need manual review: ${customOperators.join(', ')}.`);
  return providers;
}

await connectDb();
try {
  const [ada, goLink] = await Promise.all([oneDivision('3'), oneDivision('3GL')]);
  const [ada32, goLink32, bts, melinio] = await Promise.all([
    onePlan(['DIV 3 DART MMS', planNames.ada32]),
    onePlan(['DIV 3 DART GLINK', planNames.gl32]),
    onePlan(['DIV 3 DART MMS — BTS']),
    onePlan(['DIV 3 DART MMS — Melinio']),
  ]);

  const versionsToChange = [ada32, goLink32, bts, melinio].flatMap((plan) => plan.versions.map((version) => version._id));
  const lockedUses = await Vdp.countDocuments({ planVersionId: { $in: versionsToChange }, status: { $in: LOCKED } });
  if (lockedUses) throw new Error(`${lockedUses} approved/locked VDP(s) use a plan version that would change; migration stopped.`);

  const ada34Names = ['BM3 Transportation LLC', 'Grand Tour Transportation LLC', 'RoyaL T Kare LLC'];
  const goLink34Names = [
    'BM3 Transportation LLC',
    'BTS Investors Group LLC',
    'Grand Tour Transportation LLC',
    'MELINIO TRANSIT (TX)',
    'RoyaL T Kare LLC',
  ];
  const [ada34Providers, goLink34Providers] = await Promise.all([
    exactProviders(ada._id, ada34Names),
    exactProviders(goLink._id, goLink34Names),
  ]);

  const preview = {
    mode: APPLY ? 'apply' : 'dry-run',
    defaults: [
      { plan: ada32.name, becomes: planNames.ada32, division: '3', schedule: '$32' },
      { plan: goLink32.name, becomes: planNames.gl32, division: '3GL', schedule: '$32' },
      { plan: bts.name, division: '3', schedule: '$34 + 100% cap' },
      { plan: melinio.name, division: '3', schedule: '$34 + 100% cap' },
    ],
    assignments: {
      ada34: ada34Providers.map((provider) => provider.name),
      goLink34: goLink34Providers.map((provider) => provider.name),
      absentFromRoster: ['Orion Transit LLC'],
    },
  };
  if (!APPLY) {
    console.log(JSON.stringify(preview, null, 2));
    process.exitCode = 2;
  } else {
    ada32.name = planNames.ada32;
    ada32.divisionId = ada._id;
    configureVersion(ada32.versions[ada32.versions.length - 1], '32');

    goLink32.name = planNames.gl32;
    goLink32.divisionId = goLink._id;
    configureVersion(goLink32.versions[goLink32.versions.length - 1], '32');

    configureVersion(bts.versions[bts.versions.length - 1], '34');
    configureVersion(melinio.versions[melinio.versions.length - 1], '34');

    let ada34 = await VdpPlan.findOne({ divisionId: ada._id, name: planNames.ada34 });
    if (!ada34) ada34 = newPlan(ada._id, planNames.ada34, '34');
    else configureVersion(ada34.versions[ada34.versions.length - 1], '34');

    let goLink34 = await VdpPlan.findOne({ divisionId: goLink._id, name: planNames.gl34 });
    if (!goLink34) goLink34 = newPlan(goLink._id, planNames.gl34, '34');
    else configureVersion(goLink34.versions[goLink34.versions.length - 1], '34');

    await Promise.all([ada32.save(), goLink32.save(), bts.save(), melinio.save(), ada34.save(), goLink34.save()]);
    await Promise.all([
      Provider.updateMany({ _id: { $in: ada34Providers.map((provider) => provider._id) } }, { $set: { planId: ada34._id } }),
      Provider.updateMany({ _id: { $in: goLink34Providers.map((provider) => provider._id) } }, { $set: { planId: goLink34._id } }),
    ]);

    const vdpFilter = { divisionId: { $in: [ada._id, goLink._id] }, status: { $in: EDITABLE } };
    await Vdp.updateMany(vdpFilter, { $set: { stale: true } });
    const vdps = await Vdp.find(vdpFilter).sort({ divisionId: 1, providerId: 1 });
    let recalculated = 0;
    for (const vdp of vdps) {
      await recalculate(vdp._id, null);
      recalculated += 1;
    }

    const azalea = await Provider.findOne({ divisionId: ada._id, name: 'Azalea City Way LLC' });
    const azaleaVdp = azalea && await Vdp.findOne({ providerId: azalea._id }).sort({ calculatedAt: -1 });
    console.log(JSON.stringify({
      ...preview,
      createdOrUpdatedPlans: [ada32.name, ada34.name, goLink32.name, goLink34.name, bts.name, melinio.name],
      recalculated,
      azalea: azaleaVdp && {
        vdpId: azaleaVdp._id,
        status: azaleaVdp.status,
        stale: azaleaVdp.stale,
        gross: String(azaleaVdp.gross ?? ''),
        weekEarnings: azaleaVdp.calculation?.weeks?.map((week) => week.weeklyEarnings),
        coreRevenue: azaleaVdp.calculation?.weeks?.map((week) => week.baseEarnings),
        contractHoursIncentive: azaleaVdp.calculation?.weeks?.map((week) => week.contractHoursIncentive),
      },
    }, null, 2));
  }
} finally {
  await disconnectDb();
}
