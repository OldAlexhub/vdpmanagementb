// Idempotent seed: DIV 10 – Portland, its two VDP plans, and the current DIV 10 roster.
// Values come from the artifacts study (see BUSINESS_RULES.md). Re-running never duplicates
// and never overwrites records a user has since edited (existing records are left alone).
//
//   npm run seed              division + plans + roster
//   npm run seed -- --no-roster   division + plans only
import 'dotenv/config';
import { connectDb, disconnectDb } from '../src/config/db.js';
import Division from '../src/models/Division.js';
import VdpPlan from '../src/models/VdpPlan.js';
import Provider from '../src/models/Provider.js';

const NIGHT_V1 = {
  versionNumber: 1,
  effectiveFrom: new Date('2026-05-25T00:00:00Z'),
  effectiveTo: null,
  paymentType: 'HOURLY',
  basePay: '25.97',
  contractedHours: '40',
  incentiveEnabled: true,
  incentiveTiers: [
    { minimumPercentage: '0', maximumPercentage: '79.99', rate: '25.97' },
    { minimumPercentage: '80', maximumPercentage: '86.99', rate: '26.55' },
    { minimumPercentage: '87', maximumPercentage: '94.99', rate: '27.41' },
    { minimumPercentage: '95', maximumPercentage: '99.99', rate: '28.13' },
    { minimumPercentage: '100', maximumPercentage: null, rate: '28.86' },
  ],
  bonusEnabled: true,
  bonusRate: '34.62',
  performanceHourMetric: 'TOTAL_HOURS',
  notes: 'Rates as used by analysis.R. Accounting uses unrounded tier rates (26.5472 / 27.4128 / 28.1342 / 28.8556) — confirm which is contractual.',
  createdBy: { name: 'seed' },
};

const DAY_V1 = {
  versionNumber: 1,
  effectiveFrom: new Date('2026-05-25T00:00:00Z'),
  effectiveTo: null,
  paymentType: 'PER_TRIP',
  basePay: '21.50',
  contractedHours: '50',
  incentiveEnabled: false, // AM routes: no TUI
  incentiveTiers: [],
  bonusEnabled: false,
  bonusRate: null,
  performanceHourMetric: 'TOTAL_HOURS',
  notes: 'AM / Day routes are paid per trip at $21.50 with no TUI.',
  createdBy: { name: 'seed' },
};

// TriMet run cut "As of Now" joined to the provider list by operator (as analysis.R does).
// Open runs (902, 912, 913, 914-STBY, 915, 919) have no provider and are not seeded.
const ROSTER = [
  ['1083', 'AL Care Clean Transitions LLC', 'Damaso Alcaire', '901', 'DAY'],
  ['10123', 'Dire LLC', 'Kemal Mubarak', '903', 'DAY'],
  ['10116', 'Precious Cargo Transportation LLC', 'Lola Hilliard', '904', 'DAY'],
  ['10102', "CeeGee's LLC", 'Chad Gouland', '905', 'DAY'],
  ['10086', 'Kings Trans LLC', 'Michael Jones', '906', 'DAY'],
  ['10117', 'Ardey King LLC', 'Adeola Sunday', '907', 'DAY'],
  ['10042', 'BillysTransportation LLC', 'Billy Collins', '908', 'DAY'],
  ['10101', 'Shared Rides Transportation', 'Shalomnesh Israelyosef', '909', 'DAY'],
  ['10081', 'Hoang Comfort Ride, LLC', 'Hien Hoang', '910', 'DAY'],
  ['10085', 'Oregon Driving LLC', 'Jonathan Work', '911', 'DAY'],
  ['10100', 'G1Business LLC', 'Gwaun Dudley', '916', 'NIGHT'],
  ['10115', 'VeriCare Tansport LLC', 'Verite Nitunga', '917', 'NIGHT'],
  ['10063', 'Rimo Transit LLC', 'Lisa Moore', '918', 'NIGHT'],
];

export async function seed({ roster = true, log = console.log } = {}) {
  let division = await Division.findOne({ divisionNumber: '10' });
  if (!division) {
    division = await Division.create({
      divisionNumber: '10',
      name: 'Portland',
      location: 'Portland, OR (TriMet)',
      timezone: 'America/Los_Angeles',
      notes: 'TriMet paratransit. Night Service hourly with TUI; Day/AM Service per trip.',
      cycleSettings: { anchorDate: new Date('2026-08-24T00:00:00Z'), lengthDays: 14, submissionOffsetDays: 15, paymentOffsetDays: 4 },
    });
    log('Created division DIV 10 – Portland');
  }

  const plan = async (name, version, notes) => {
    let p = await VdpPlan.findOne({ divisionId: division._id, name });
    if (!p) {
      p = await VdpPlan.create({ divisionId: division._id, name, notes, versions: [version] });
      log(`Created plan ${name}`);
    }
    return p;
  };
  const night = await plan('Night Service', NIGHT_V1, 'Transdev/TriMet Night Service — hourly, TUI tiers, bonus above contracted hours.');
  const day = await plan('Day Service', DAY_V1, 'Transdev/TriMet Day (AM) Service — per trip.');

  if (roster) {
    for (const [number, name, operator, route, shift] of ROSTER) {
      if (await Provider.exists({ divisionId: division._id, providerNumber: number })) continue;
      await Provider.create({
        divisionId: division._id,
        providerNumber: number,
        name,
        operatorName: operator,
        routes: [route],
        serviceType: shift === 'NIGHT' ? 'TDEV Night' : 'TDEV',
        planId: shift === 'NIGHT' ? night._id : day._id,
        liftLease: { amount: '197.50', frequency: 'WEEKLY' },
        notes: 'Seeded from the TriMet run cut (as of 09/26/2026). Verify route assignment.',
      });
      log(`Created provider ${name} (route ${route})`);
    }
  }
  return { division, night, day };
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  await connectDb();
  await seed({ roster: !process.argv.includes('--no-roster') });
  await disconnectDb();
  console.log('Seed complete.');
}
