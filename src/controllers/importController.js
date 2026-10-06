// Bulk import of divisions, VDP plans and providers from an Excel template.
// Existing records are never changed: a row that matches one is reported and skipped.
// Preview and import run the same checks; import then saves only the NEW rows.
import Division from '../models/Division.js';
import VdpPlan from '../models/VdpPlan.js';
import Provider from '../models/Provider.js';
import { applyInput as applyDivision } from './divisionController.js';
import { applyInput as applyProvider } from './providerController.js';
import { versionInput } from './planController.js';
import { joinOpenPeriods } from './cycleController.js';
import { decimalInput } from './validate.js';
import { currentVersion } from '../services/planService.js';
import { operatorsOf } from '../services/operators.js';
import { isoDate } from '../services/cycleService.js';
import { str } from '../services/money.js';
import { HttpError, actor, notFound } from '../services/errors.js';
import { isCompassRosterAuthority } from '../services/compassClient.js';
import {
  MAX_ROWS, addDataSheet, addInstructionsSheet, addListsSheet, addReferenceSheet, listRanges,
  loadWorkbook, newWorkbook, parseDate, readSheet, sheetRange,
} from '../services/importWorkbook.js';

// ---------- shared vocabulary (code, label shown in Excel, other accepted spellings) ----------
const TIMEZONES = ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Detroit', 'America/Phoenix'];
const STATUS = [['ACTIVE', 'Active'], ['INACTIVE', 'Inactive']];
const YES_NO = [[true, 'Yes', 'y', 'true', '1'], [false, 'No', 'n', 'false', '0']];
const PAYMENT_TYPES = [['HOURLY', 'Hourly'], ['PER_TRIP', 'Per trip', 'per-trip', 'pertrip']];
const METRICS = [['TOTAL_HOURS', 'Total Hours'], ['SERVICE_HOURS', 'Service Hours'], ['REVENUE_HOURS', 'Revenue Hours'], ['OTHER', 'Other report column', 'other']];
const TUI = [['INHERIT', 'Inherit from plan', 'inherit'], ['ON', 'Eligible', 'on', 'yes'], ['OFF', 'Not eligible', 'off', 'no']];
const LEASE = [['NONE', 'None', 'no lease'], ['WEEKLY', 'Weekly'], ['PER_VDP_CYCLE', 'Per VDP cycle', 'per cycle']];
const labels = (options) => options.map((o) => o[1]);
const labelOf = (options, code) => options.find((o) => o[0] === code)?.[1] ?? code;

const ci = (s) => String(s ?? '').trim().toLowerCase();
const divLabel = (d) => `DIV ${d.divisionNumber} – ${d.name}`;
const planLabel = (p, d) => `DIV ${d.divisionNumber} | ${p.name}`;
// Numbers compared as exact decimals (25.970 = 25.97); anything else as typed.
const numText = (v) => {
  try {
    return str(String(v ?? '').replace(/[$,]/g, ''));
  } catch {
    return v;
  }
};
const normRoutes = (v) => [...new Set(String(v ?? '').split(/[,;\s]+/).map((r) => r.trim()).filter(Boolean))];

// ---------- row helpers ----------
const newRow = (row, sheet, label) => ({ row, sheet, label, status: null, errors: [], warnings: [], differences: [], existing: null });

function choose(r, value, options, label, fallback) {
  if (value === null || value === undefined) return fallback;
  const hit = options.find(([code, ...names]) => [String(code), ...names].some((n) => ci(n) === ci(value)));
  if (!hit) r.errors.push(`${label}: “${value}” is not allowed. Choose ${labels(options).join(' / ')}.`);
  return hit ? hit[0] : undefined;
}

function decimal(r, value, label, opts) {
  try {
    return decimalInput(value, label, opts);
  } catch (e) {
    r.errors.push(e.message);
    return null;
  }
}

function dateCell(r, value, label) {
  const d = parseDate(value);
  if (d === undefined) {
    r.errors.push(`${label}: “${value}” is not a date. Use YYYY-MM-DD.`);
    return null;
  }
  return d;
}

function findDivision(r, value, ctx) {
  if (value === null) {
    r.errors.push('Division is required.');
    return null;
  }
  const v = ci(value);
  const number = v.replace(/^div\s*/, '').split(/\s+[–|-]\s+/)[0].trim();
  const d = ctx.divisions.find((x) => ci(divLabel(x)) === v) || ctx.divisions.find((x) => ci(x.divisionNumber) === number);
  if (!d) r.errors.push(`Division “${value}” was not found. Choose one from the drop-down (import new divisions first).`);
  return d || null;
}

// A second row for the same record in one file is reported, not imported twice.
function duplicateOf(r, seen, keys) {
  const first = keys.map((k) => seen.get(k)).find(Boolean);
  if (first) {
    r.status = 'DUPLICATE';
    r.errors = [];
    r.warnings.push(`Same record as row ${first} in this file — only the first one is imported.`);
    return true;
  }
  keys.forEach((k) => seen.set(k, r.row));
  return false;
}

// Only fields the file actually fills in are compared.
function differences(pairs) {
  return pairs
    .filter(([, file, system]) => file !== null && file !== undefined && file !== '' && ci(file) !== ci(system ?? ''))
    .map(([field, file, system]) => ({ field, file: String(file), system: system === null || system === undefined || system === '' ? '—' : String(system) }));
}

function markExisting(r, description, diffs) {
  r.status = 'EXISTS';
  r.errors = [];
  r.existing = description;
  r.differences = diffs;
}

const finalise = (r) => {
  if (!r.status) r.status = r.errors.length ? 'ERROR' : 'NEW';
  return r;
};

async function loadContext() {
  const [divisions, plans, providers] = await Promise.all([
    Division.find().sort({ divisionNumber: 1 }),
    VdpPlan.find().sort({ name: 1 }),
    Provider.find().sort({ name: 1 }),
  ]);
  return { divisions, plans, providers, divById: new Map(divisions.map((d) => [String(d._id), d])) };
}

// ======================= Divisions =======================
const DIVISION_COLUMNS = [
  { key: 'divisionNumber', header: 'Division number', level: 'required', text: true, width: 16, help: 'The division number used across Big Star. Must be unique.', example: '10' },
  { key: 'name', header: 'Division name', level: 'required', width: 24, example: 'Portland' },
  { key: 'location', header: 'Location', level: 'optional', width: 22, example: 'Portland, OR' },
  { key: 'timezone', header: 'Time zone', level: 'recommended', width: 22, list: TIMEZONES, help: 'Blank = America/Los_Angeles.', example: 'America/Los_Angeles' },
  { key: 'status', header: 'Status', level: 'recommended', width: 12, list: labels(STATUS), help: 'Blank = Active.', example: 'Active' },
  { key: 'notes', header: 'Notes', level: 'optional', width: 30 },
];

const divisions = {
  admin: true,
  afterSave: (doc) => joinOpenPeriods(doc),
  title: 'Divisions',
  fileName: 'Big Star VDP - Divisions import.xlsx',
  sheets: [{ name: 'Divisions', columns: DIVISION_COLUMNS }],
  steps: [
    'Fill in one division per row on the “Divisions” sheet. Leave the header row as it is.',
    'Check the “Existing divisions” sheet — divisions already in the system are skipped, never changed.',
    'Upload the file in Divisions → Bulk import, review the check, then import.',
    'VDP cycles are company-wide: new divisions join the current and upcoming cycles automatically.',
  ],
  lists: () => ({}),
  reference: (ctx) => ({
    name: 'Existing divisions',
    headers: ['Division number', 'Division name', 'Location', 'Time zone', 'Status'],
    rows: ctx.divisions.map((d) => [d.divisionNumber, d.name, d.location || '', d.timezone, labelOf(STATUS, d.status)]),
  }),
  async analyse(wb, ctx) {
    const seen = new Map();
    const rows = [];
    for (const { row, values: v } of readSheet(wb, 'Divisions', DIVISION_COLUMNS)) {
      const r = newRow(row, 'Divisions', v.divisionNumber ? `DIV ${v.divisionNumber}${v.name ? ` – ${v.name}` : ''}` : v.name || `Row ${row}`);
      rows.push(r);
      if (!v.divisionNumber) r.errors.push('Division number is required.');
      if (!v.name) r.errors.push('Division name is required.');
      if (v.divisionNumber) {
        const key = ci(v.divisionNumber);
        if (duplicateOf(r, seen, [key])) continue;
        const existing = ctx.divisions.find((d) => ci(d.divisionNumber) === key);
        if (existing) {
          markExisting(r, divLabel(existing), differences([
            ['Name', v.name, existing.name],
            ['Location', v.location, existing.location],
            ['Time zone', v.timezone, existing.timezone],
            ['Status', v.status, labelOf(STATUS, existing.status)],
          ]));
          continue;
        }
      }
      const sameName = v.name && ctx.divisions.find((d) => ci(d.name) === ci(v.name));
      if (sameName) r.warnings.push(`${divLabel(sameName)} already uses this name.`);
      const timezone = choose(r, v.timezone, TIMEZONES.map((t) => [t, t]), 'Time zone', 'America/Los_Angeles');
      const status = choose(r, v.status, STATUS, 'Status', 'ACTIVE');
      if (!r.errors.length) {
        try {
          const doc = new Division({ status });
          applyDivision(doc, {
            divisionNumber: v.divisionNumber, name: v.name, location: v.location ?? undefined, timezone, notes: v.notes ?? undefined,
          });
          await doc.validate();
          r.doc = doc;
        } catch (e) {
          r.errors.push(e.message);
        }
      }
    }
    return { rows: rows.map(finalise), notes: [] };
  },
};

// ======================= VDP plans =======================
const PLAN_SHEET = 'VDP Plans';
const TIER_SHEET = 'TUI Tiers';
const PLAN_COLUMNS = [
  { key: 'division', header: 'Division', level: 'required', listKey: 'divisions', width: 26, help: 'Choose the division this plan belongs to.', example: 'DIV 10 – Portland' },
  { key: 'name', header: 'Plan name', level: 'required', width: 28, help: 'Unique within the division.', example: 'DIV 10 TDEV Hourly' },
  { key: 'status', header: 'Status', level: 'recommended', list: labels(STATUS), width: 12, help: 'Blank = Active.', example: 'Active' },
  { key: 'paymentType', header: 'Payment type', level: 'required', list: labels(PAYMENT_TYPES), width: 14, help: 'Hourly = paid on hours performed. Per trip = paid on trips provided.', example: 'Hourly' },
  { key: 'basePay', header: 'Base pay ($)', level: 'required', type: 'decimal', width: 14, help: '$ per hour for Hourly plans, $ per trip for Per trip plans. Paid when TUI does not apply. Up to 4 decimals, no $ sign.', example: '25.97' },
  { key: 'contractedHours', header: 'Contracted hours per week', level: 'recommended', type: 'decimal', width: 18, help: 'Required for Hourly plans and whenever TUI is on.', example: '40' },
  { key: 'performanceHourMetric', header: 'Performance hours come from', level: 'recommended', list: labels(METRICS), width: 22, help: 'Which Performance Report column counts as hours worked. Blank = Total Hours.', example: 'Total Hours' },
  { key: 'performanceHourColumn', header: 'Other report column name', level: 'optional', width: 22, help: 'Only when hours come from “Other report column”: the column name in the Hours section.' },
  { key: 'effectiveFrom', header: 'Effective from', level: 'required', type: 'date', width: 16, help: 'The date these rules start (YYYY-MM-DD).', example: '2026-08-24' },
  { key: 'effectiveTo', header: 'Effective to', level: 'optional', type: 'date', width: 16, help: 'Leave blank if open-ended.' },
  { key: 'incentiveEnabled', header: 'TUI eligible', level: 'recommended', list: labels(YES_NO), width: 12, help: 'Top-Up Incentive. Blank = No. When Yes, enter the tiers on the “TUI Tiers” sheet.', example: 'Yes' },
  { key: 'bonusEnabled', header: 'Bonus hours paid', level: 'recommended', list: labels(YES_NO), width: 14, help: 'Hourly plans only: pay a bonus rate for hours above contract. Blank = No.', example: 'No' },
  { key: 'bonusRate', header: 'Bonus rate ($/hour)', level: 'optional', type: 'decimal', width: 16, help: 'Required when Bonus hours paid = Yes.' },
  { key: 'fuelReimbursementEnabled', header: 'Fuel reimbursement', level: 'recommended', list: labels(YES_NO), width: 14, help: 'Pay fuel reimbursement per trip, added to the VDP after Gross. Blank = No.', example: 'No' },
  { key: 'fuelReimbursementRate', header: 'Fuel reimbursement ($/trip)', level: 'optional', type: 'decimal', width: 18, help: 'Required when Fuel reimbursement = Yes. Up to 4 decimals.', example: '2.50' },
  { key: 'notes', header: 'Notes', level: 'optional', width: 30 },
];
const TIER_COLUMNS = [
  { key: 'division', header: 'Division', level: 'required', listKey: 'divisions', width: 26, help: 'Same division as the plan.', example: 'DIV 10 – Portland' },
  { key: 'planName', header: 'Plan name', level: 'required', listFormula: sheetRange(PLAN_SHEET, 'B'), width: 28, help: 'Choose a plan from the “VDP Plans” sheet.', example: 'DIV 10 TDEV Hourly' },
  { key: 'minimumPercentage', header: 'From %', level: 'required', type: 'decimal', percent: true, width: 10, help: 'Performance % of contracted hours where this tier starts. Type 80 for 80%. The first tier starts at 0.', example: '80' },
  { key: 'maximumPercentage', header: 'To %', level: 'optional', type: 'decimal', percent: true, width: 10, help: 'Where this tier ends, e.g. 86.99. Leave blank on the last tier.', example: '86.99' },
  { key: 'rate', header: 'Rate ($)', level: 'required', type: 'decimal', width: 12, help: 'Pay rate for this tier. Up to 4 decimals.', example: '28.86' },
];

const plans = {
  admin: true,
  title: 'VDP plans',
  fileName: 'Big Star VDP - VDP plans import.xlsx',
  sheets: [{ name: PLAN_SHEET, columns: PLAN_COLUMNS }, { name: TIER_SHEET, columns: TIER_COLUMNS }],
  steps: [
    'Import divisions first — the Division drop-down lists the divisions that exist when you download this file.',
    'On “VDP Plans”, fill in one plan per row. This becomes version 1 of the plan.',
    'For plans with TUI eligible = Yes, add one row per tier on “TUI Tiers” (e.g. 0–79.99, 80–86.99, 87–94.99, 95–99.99, 100+).',
    'Plans that already exist (same division and name) are skipped, never changed. To change rates, add a new version on the plan page.',
    'Upload the file in VDP Plans → Bulk import, review the check, then import.',
  ],
  lists: (ctx) => ({ divisions: ctx.divisions.map(divLabel) }),
  reference: (ctx) => ({
    name: 'Existing plans',
    headers: ['Division', 'Plan name', 'Status', 'Payment type', 'Base pay', 'Contracted hours', 'TUI eligible'],
    rows: ctx.plans.map((p) => {
      const d = ctx.divById.get(String(p.divisionId));
      const v = currentVersion(p);
      return [d ? divLabel(d) : '', p.name, labelOf(STATUS, p.status), labelOf(PAYMENT_TYPES, v?.paymentType), str(v?.basePay) || '', str(v?.contractedHours) || '', v?.incentiveEnabled ? 'Yes' : 'No'];
    }),
  }),
  async analyse(wb, ctx, user) {
    const notes = [];
    // Tiers are grouped by division + plan name and attached to the matching plan row.
    const tiers = new Map();
    for (const { row, values: v } of readSheet(wb, TIER_SHEET, TIER_COLUMNS, { optional: true })) {
      const t = newRow(row, TIER_SHEET, '');
      const d = findDivision(t, v.division, ctx);
      if (!v.planName) t.errors.push('Plan name is required.');
      if (t.errors.length) {
        notes.push(`${TIER_SHEET} row ${row}: ${t.errors.join(' ')} This tier was ignored.`);
        continue;
      }
      const key = `${d._id}|${ci(v.planName)}`;
      if (!tiers.has(key)) tiers.set(key, { label: `${v.planName} (DIV ${d.divisionNumber})`, rows: [] });
      tiers.get(key).rows.push({ row, minimumPercentage: v.minimumPercentage, maximumPercentage: v.maximumPercentage, rate: v.rate });
    }

    const seen = new Map();
    const used = new Set();
    const rows = [];
    for (const { row, values: v } of readSheet(wb, PLAN_SHEET, PLAN_COLUMNS)) {
      const r = newRow(row, PLAN_SHEET, v.name || `Row ${row}`);
      rows.push(r);
      const d = findDivision(r, v.division, ctx);
      if (!v.name) r.errors.push('Plan name is required.');
      if (!d || !v.name) continue;
      r.label = `${v.name} (DIV ${d.divisionNumber})`;
      const key = `${d._id}|${ci(v.name)}`;
      used.add(key);
      if (duplicateOf(r, seen, [key])) continue;
      const existing = ctx.plans.find((p) => String(p.divisionId) === String(d._id) && ci(p.name) === ci(v.name));
      if (existing) {
        const cur = currentVersion(existing);
        markExisting(r, `${existing.name} (DIV ${d.divisionNumber}), version ${cur?.versionNumber ?? '—'}`, differences([
          ['Status', v.status, labelOf(STATUS, existing.status)],
          ['Payment type', v.paymentType, labelOf(PAYMENT_TYPES, cur?.paymentType)],
          ['Base pay', numText(v.basePay), str(cur?.basePay)],
          ['Contracted hours', numText(v.contractedHours), str(cur?.contractedHours)],
          ['TUI eligible', v.incentiveEnabled, cur ? (cur.incentiveEnabled ? 'Yes' : 'No') : null],
          ['Fuel reimbursement', v.fuelReimbursementEnabled, cur ? (cur.fuelReimbursementEnabled ? 'Yes' : 'No') : null],
          ['Fuel reimbursement ($/trip)', numText(v.fuelReimbursementRate), str(cur?.fuelReimbursementRate)],
        ]));
        continue;
      }

      if (v.paymentType === null) r.errors.push('Payment type is required.');
      if (v.effectiveFrom === null) r.errors.push('Effective from is required.');
      const status = choose(r, v.status, STATUS, 'Status', 'ACTIVE');
      const paymentType = choose(r, v.paymentType, PAYMENT_TYPES, 'Payment type', null);
      const metric = choose(r, v.performanceHourMetric, METRICS, 'Performance hours come from', 'TOTAL_HOURS');
      const incentiveEnabled = choose(r, v.incentiveEnabled, YES_NO, 'TUI eligible', false);
      const bonusEnabled = choose(r, v.bonusEnabled, YES_NO, 'Bonus hours paid', false);
      const fuelReimbursementEnabled = choose(r, v.fuelReimbursementEnabled, YES_NO, 'Fuel reimbursement', false);
      const effectiveFrom = dateCell(r, v.effectiveFrom, 'Effective from');
      const effectiveTo = dateCell(r, v.effectiveTo, 'Effective to');
      const planTiers = (tiers.get(key)?.rows || []).sort((a, b) => a.row - b.row);
      if (!incentiveEnabled && planTiers.length) r.warnings.push('TUI eligible is No, but tiers were given. They are saved so TUI can be switched on later.');
      if (r.errors.length) continue;
      try {
        const version = versionInput({
          paymentType, basePay: v.basePay, contractedHours: v.contractedHours, performanceHourMetric: metric, performanceHourColumn: v.performanceHourColumn,
          incentiveEnabled, incentiveTiers: planTiers, bonusEnabled, bonusRate: v.bonusRate,
          fuelReimbursementEnabled, fuelReimbursementRate: v.fuelReimbursementRate,
          effectiveFrom: effectiveFrom && isoDate(effectiveFrom), effectiveTo: effectiveTo && isoDate(effectiveTo),
        });
        const doc = new VdpPlan({ divisionId: d._id, name: v.name, status, notes: v.notes ?? undefined, versions: [{ ...version, versionNumber: 1, createdBy: actor(user) }] });
        await doc.validate();
        r.doc = doc;
      } catch (e) {
        const list = e.details?.errors || [e.message];
        const tierRows = planTiers.map((t) => t.row).join(', ');
        r.errors.push(...list.map((m) => (/tier/i.test(m) && tierRows ? `${m} (${TIER_SHEET} rows ${tierRows})` : /tier/i.test(m) ? `${m} Add them on the “${TIER_SHEET}” sheet.` : m)));
      }
    }
    for (const [key, t] of tiers) {
      if (!used.has(key)) notes.push(`${TIER_SHEET} rows ${t.rows.map((x) => x.row).join(', ')}: no plan “${t.label}” on the “${PLAN_SHEET}” sheet. These tiers were ignored.`);
    }
    return { rows: rows.map(finalise), notes };
  },
};

// ======================= Providers =======================
// One row per operator. The provider (who gets paid) is repeated on each of its operators' rows;
// rows with the same division + provider number (or name) become one provider with several operators.
const PROVIDER_COLUMNS = [
  { key: 'division', header: 'Division', level: 'required', listKey: 'divisions', width: 26, help: 'Choose the provider’s division.', example: 'DIV 10 – Portland' },
  { key: 'name', header: 'Provider name', level: 'required', width: 28, help: 'Legal / business name of the provider — the one who gets paid. Repeat it on each of its operators’ rows.', example: 'Rimo Transit LLC' },
  { key: 'providerNumber', header: 'Provider number', level: 'recommended', text: true, width: 16, help: 'Big Star vendor number. Used to spot providers that already exist and to group operators.', example: '10452' },
  { key: 'operatorName', header: 'Operator', level: 'recommended', width: 20, help: 'Driver / operator name. One row per operator; a provider with 3 operators has 3 rows. Blank = the provider’s name (single-operator provider).', example: 'Lisa Moore' },
  { key: 'vehicleUnit', header: 'Vehicle / pay unit', level: 'optional', text: true, width: 18, help: 'Uber: give operators sharing one vehicle the same unit. Their weekly metrics are combined and that vehicle lease is charged once.', example: '4548' },
  { key: 'routes', header: 'Route / run', level: 'recommended', text: true, width: 16, help: 'This operator’s run(s) as shown in the Performance Report “Run/Route” column. Several: separate with commas. Without a route, performance cannot be matched.', example: '918' },
  { key: 'operatorBasePay', header: 'Operator base hourly rate ($)', level: 'optional', type: 'decimal', width: 18, help: 'Uber only: fill this when this operator has a different rate from the provider base hourly rate.' },
  { key: 'contractedHours', header: 'Operator contracted hours', level: 'recommended', type: 'decimal', width: 16, help: 'Required for Uber operators. Standard operators may leave this blank to inherit from the provider or plan.' },
  { key: 'liftLeaseFrequency', header: 'Lift lease frequency', level: 'recommended', list: labels(LEASE), width: 16, help: 'This operator’s vehicle lease. Blank = None.', example: 'Weekly' },
  { key: 'liftLeaseAmount', header: 'Lift lease amount ($)', level: 'optional', type: 'decimal', width: 16, help: 'Required when the frequency is Weekly or Per VDP cycle. Weekly is charged for each week in the cycle.', example: '197.50' },
  { key: 'status', header: 'Provider status', level: 'recommended', list: labels(STATUS), width: 12, help: 'Blank = Active.', example: 'Active' },
  { key: 'serviceType', header: 'Service type', level: 'optional', listKey: 'serviceTypes', loose: true, width: 16, help: 'Pick an existing service type, or type a new one.', example: 'TDEV Night' },
  { key: 'plan', header: 'VDP plan', level: 'recommended', listKey: 'plans', width: 32, help: 'Must be a plan in the same division. Without a plan, VDPs will need review.', example: 'DIV 10 | DIV 10 TDEV Hourly' },
  { key: 'tuiEligibility', header: 'TUI eligibility', level: 'recommended', list: labels(TUI), width: 18, help: 'Blank = Inherit from plan.', example: 'Inherit from plan' },
  { key: 'basePay', header: 'Base pay override ($)', level: 'recommended', type: 'decimal', width: 18, help: 'For Uber, this is the provider-profile base hourly rate used by all operators unless an operator rate is entered. For standard plans, blank = inherit from the plan.' },
  { key: 'bonusRate', header: 'Bonus rate override ($)', level: 'optional', type: 'decimal', width: 16, help: 'Only if different from the plan. Blank = inherit.' },
  { key: 'email', header: 'Email', level: 'optional', width: 26 },
  { key: 'phone', header: 'Phone', level: 'optional', text: true, width: 16 },
  { key: 'address', header: 'Address', level: 'optional', width: 30 },
  { key: 'notes', header: 'Notes', level: 'optional', width: 30 },
];
// Filled in once per provider; on later rows of the same provider they must match (or be blank).
const PROVIDER_LEVEL = ['status', 'serviceType', 'plan', 'tuiEligibility', 'basePay', 'bonusRate', 'email', 'phone', 'address', 'notes'];

const leaseText = (l) => (!l || l.frequency === 'NONE' ? 'None' : `${labelOf(LEASE, l.frequency)} ${str(l.amount) || ''}`.trim());
const fileLeaseText = (v) => v.liftLeaseFrequency && (ci(v.liftLeaseFrequency) === 'none' ? 'None' : `${v.liftLeaseFrequency} ${numText(v.liftLeaseAmount) || ''}`.trim());

function findPlan(r, v, d, ctx) {
  if (v.plan === null) {
    r.warnings.push('No VDP plan — this provider’s VDPs will need review until a plan is assigned.');
    return null;
  }
  const wanted = ci(v.plan);
  const plan = ctx.plans.find((p) => { const pd = ctx.divById.get(String(p.divisionId)); return pd && ci(planLabel(p, pd)) === wanted; })
    || ctx.plans.find((p) => String(p.divisionId) === String(d._id) && ci(p.name) === wanted.split(' | ').pop());
  if (!plan) r.errors.push(`VDP plan “${v.plan}” was not found. Choose one from the drop-down (import new plans first).`);
  else if (String(plan.divisionId) !== String(d._id)) r.errors.push(`VDP plan “${plan.name}” belongs to another division. Choose a DIV ${d.divisionNumber} plan.`);
  else if (plan.status !== 'ACTIVE') r.warnings.push(`VDP plan “${plan.name}” is inactive.`);
  return plan || null;
}

// The operator part of a row: name, routes, own contract and own lease.
function operatorFromRow(r, v, providerName) {
  const frequency = choose(r, v.liftLeaseFrequency, LEASE, 'Lift lease frequency', 'NONE');
  const amount = decimal(r, v.liftLeaseAmount, 'Lift lease amount', { maxDp: 2 });
  if (frequency === 'NONE' && amount !== null) r.errors.push('A lift lease amount is given but the frequency is None. Choose Weekly or Per VDP cycle, or clear the amount.');
  if (frequency && frequency !== 'NONE' && amount === null) r.errors.push('Enter the lift lease amount, or set the frequency to None.');
  return {
    name: v.operatorName || providerName,
    vehicleUnit: v.vehicleUnit || null,
    routes: normRoutes(v.routes),
    basePay: decimal(r, v.operatorBasePay, 'Operator base hourly rate'),
    contractedHours: decimal(r, v.contractedHours, 'Operator contracted hours'),
    liftLease: { amount, frequency },
  };
}

const providers = {
  admin: false,
  title: 'Providers',
  fileName: 'Big Star VDP - Providers import.xlsx',
  sheets: [{ name: 'Providers', columns: PROVIDER_COLUMNS }],
  steps: [
    'Import divisions and VDP plans first — the drop-downs list what exists when you download this file.',
    'Fill in one row per operator on the “Providers” sheet. The provider is the one who gets paid: for a provider with several operators, repeat the provider (same name and number) on each operator’s row, each with that operator’s route and lift lease.',
    'Provider details (status, plan, TUI, overrides, contact) only need filling on the provider’s first row.',
    'Check the “Existing providers” sheet. Rows for a provider that already exists (same division and provider number, or name) are skipped, never changed — add new operators to an existing provider on its profile.',
    'Upload the file in Providers → Bulk import, review the check, then import.',
  ],
  lists: (ctx) => ({
    divisions: ctx.divisions.map(divLabel),
    plans: ctx.plans.filter((p) => ctx.divById.has(String(p.divisionId))).map((p) => planLabel(p, ctx.divById.get(String(p.divisionId)))),
    serviceTypes: [...new Set(ctx.providers.map((p) => p.serviceType).filter(Boolean))].sort(),
  }),
  reference: (ctx) => {
    const planName = new Map(ctx.plans.map((p) => [String(p._id), p.name]));
    return {
      name: 'Existing providers',
      headers: ['Division', 'Provider name', 'Provider number', 'Operator', 'Route / run', 'Lift lease', 'VDP plan', 'Status'],
      rows: ctx.providers.flatMap((p) => {
        const d = ctx.divById.get(String(p.divisionId));
        return operatorsOf(p).map((o) => [d ? divLabel(d) : '', p.name, p.providerNumber || '', o.name, o.routes.join(', '), leaseText(o.liftLease), planName.get(String(p.planId)) || '', labelOf(STATUS, p.status)]);
      }),
    };
  },
  async analyse(wb, ctx) {
    const routeOwners = new Map(); // "divisionId|route" → who has it (system or earlier row)
    for (const p of ctx.providers) {
      if (p.status !== 'ACTIVE') continue;
      for (const o of operatorsOf(p).filter((x) => x.status === 'ACTIVE' && !x.transferredTo)) {
        o.routes.forEach((rt) => routeOwners.set(`${p.divisionId}|${ci(rt)}`, o.name === p.name ? p.name : `${o.name} (${p.name})`));
      }
    }
    const planById = new Map(ctx.plans.map((p) => [String(p._id), p]));
    const rows = [];
    const groups = [];
    const groupByKey = new Map();

    // Pass 1: existing providers are reported; new ones are grouped by provider.
    for (const { row, values: v } of readSheet(wb, 'Providers', PROVIDER_COLUMNS)) {
      const r = newRow(row, 'Providers', v.name || `Row ${row}`);
      rows.push(r);
      const d = findDivision(r, v.division, ctx);
      if (!v.name) r.errors.push('Provider name is required.');
      if (!d || !v.name) continue;
      r.label = `${v.name} (DIV ${d.divisionNumber})${v.operatorName ? ` — ${v.operatorName}` : ''}`;

      const inDivision = ctx.providers.filter((p) => String(p.divisionId) === String(d._id));
      const byNumber = v.providerNumber && inDivision.find((p) => p.providerNumber && ci(p.providerNumber) === ci(v.providerNumber));
      const existing = byNumber || inDivision.find((p) => ci(p.name) === ci(v.name));
      if (existing) {
        const ops = operatorsOf(existing);
        const op = v.operatorName ? ops.find((o) => ci(o.name) === ci(v.operatorName)) : ops.length === 1 ? ops[0] : null;
        const diffs = differences([
          ['Provider name', v.name, existing.name],
          ['Provider number', v.providerNumber, existing.providerNumber],
          ['Status', v.status, labelOf(STATUS, existing.status)],
          ['Service type', v.serviceType, existing.serviceType],
          ['VDP plan', v.plan && String(v.plan).split(' | ').pop(), planById.get(String(existing.planId))?.name],
          ['Provider base pay', numText(v.basePay), str(existing.overrides?.basePay)],
          ...(op ? [
            ['Route / run', v.routes && normRoutes(v.routes).join(', '), op.routes.join(', ')],
            ['Operator base hourly rate', numText(v.operatorBasePay), op.basePay],
            ['Operator contracted hours', numText(v.contractedHours), op.contractedHours],
            ['Lift lease', fileLeaseText(v), leaseText(op.liftLease)],
          ] : []),
        ]);
        const missingOp = !op && v.operatorName;
        if (missingOp) diffs.unshift({ field: 'Operator', file: v.operatorName, system: ops.map((o) => o.name).join(', ') || '—' });
        markExisting(r, `${existing.name}${existing.providerNumber ? ` (#${existing.providerNumber})` : ''} — matched on ${byNumber ? 'provider number' : 'name'}${missingOp ? `. Operator ${v.operatorName} is not on this provider — add them on the provider profile` : ''}`, diffs);
        continue;
      }

      const keys = [`${d._id}|name|${ci(v.name)}`, ...(v.providerNumber ? [`${d._id}|num|${ci(v.providerNumber)}`] : [])];
      let group = keys.map((k) => groupByKey.get(k)).find(Boolean);
      if (!group) {
        group = { d, first: null, members: [] };
        groups.push(group);
      }
      keys.forEach((k) => groupByKey.set(k, group));
      const member = { r, v };
      group.first ||= member;
      group.members.push(member);
    }

    // Pass 2: one provider per group, one operator per row.
    for (const g of groups) {
      const { d, first } = g;
      const fv = first.v;
      const fr = first.r;
      const status = choose(fr, fv.status, STATUS, 'Provider status', 'ACTIVE');
      const overrides = {
        basePay: decimal(fr, fv.basePay, 'Base pay override'),
        bonusRate: decimal(fr, fv.bonusRate, 'Bonus rate override'),
        tuiEligibility: choose(fr, fv.tuiEligibility, TUI, 'TUI eligibility', 'INHERIT'),
      };
      if (fv.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fv.email)) fr.errors.push(`Email “${fv.email}” is not a valid address.`);
      const plan = findPlan(fr, fv, d, ctx);
      const uber = Boolean(plan && currentVersion(plan)?.calculationType === 'UBER');

      const operators = [];
      const opRow = new Map();
      for (const m of g.members) {
        if (m !== first) {
          for (const k of PROVIDER_LEVEL) {
            if (m.v[k] !== null && ci(m.v[k]) !== ci(fv[k])) {
              const col = PROVIDER_COLUMNS.find((c) => c.key === k);
              m.r.warnings.push(`${col.header} “${m.v[k]}” differs from row ${fr.row}; the provider uses row ${fr.row}’s value.`);
            }
          }
          if (m.v.providerNumber && fv.providerNumber && ci(m.v.providerNumber) !== ci(fv.providerNumber)) {
            m.r.errors.push(`Provider number ${m.v.providerNumber} differs from row ${fr.row} (${fv.providerNumber}) for the same provider name.`);
          }
        }
        const op = operatorFromRow(m.r, m.v, fv.name);
        if (uber && op.basePay === null && overrides.basePay === null) {
          m.r.errors.push(`Uber base hourly rate is required for ${op.name}. Enter the provider rate in Base pay override, or an operator-specific rate.`);
        }
        if (uber && op.contractedHours === null) {
          m.r.errors.push(`Uber contracted hours are required for ${op.name}.`);
        }
        if (opRow.has(ci(op.name))) {
          m.r.status = 'DUPLICATE';
          m.r.errors = [];
          m.r.warnings = [`Same provider and operator as row ${opRow.get(ci(op.name))} — only the first one is imported.`];
          continue;
        }
        opRow.set(ci(op.name), m.r.row);
        if (m !== first) m.r.warnings.unshift(`Another operator of the provider on row ${fr.row}.`);
        if (!op.routes.length) m.r.warnings.push(`No route / run for ${op.name} — Performance Report hours cannot be matched.`);
        for (const rt of op.routes) {
          const owner = routeOwners.get(`${d._id}|${ci(rt)}`);
          if (owner) m.r.warnings.push(`Route ${rt} is also assigned to ${owner}. Shared routes are flagged for review during processing.`);
          else if (status === 'ACTIVE') routeOwners.set(`${d._id}|${ci(rt)}`, `${op.name} (row ${m.r.row} of this file)`);
        }
        if (!m.r.errors.length) operators.push(op);
      }

      const members = g.members.filter((m) => m.r.status !== 'DUPLICATE');
      if (fr.errors.length) {
        members.filter((m) => m !== first).forEach((m) => m.r.errors.push(`The provider on row ${fr.row} needs fixing first.`));
        continue;
      }
      const ok = members.filter((m) => !m.r.errors.length);
      if (operators.length > 1) fr.warnings.unshift(`${operators.length} operators: ${operators.map((o) => o.name).join(', ')}.`);
      try {
        const doc = new Provider({ divisionId: d._id });
        await applyProvider(doc, {
          divisionId: d._id, name: fv.name, providerNumber: fv.providerNumber ?? undefined, status,
          serviceType: fv.serviceType ?? undefined, notes: fv.notes ?? undefined, planId: plan?._id ?? null, overrides, operators,
          contact: { email: fv.email ?? undefined, phone: fv.phone ?? undefined, address: fv.address ?? undefined },
        });
        await doc.validate();
        fr.doc = doc;
        ok.filter((m) => m !== first).forEach((m) => { m.r.partOf = fr; });
      } catch (e) {
        ok.forEach((m) => m.r.errors.push(e.message));
      }
    }
    return { rows: rows.map(finalise), notes: [] };
  },
};

// ======================= handlers =======================
const KINDS = { divisions, plans, providers };

function specFor(req) {
  const spec = KINDS[req.params.kind];
  if (!spec) throw notFound('Import type');
  if (isCompassRosterAuthority() && ['divisions', 'providers'].includes(req.params.kind)) {
    throw new HttpError(400, 'Compass manages divisions and providers. Bulk roster import is disabled.');
  }
  if (spec.admin && req.user?.role !== 'ADMIN') throw new HttpError(403, `Only administrators can import ${spec.title.toLowerCase()}.`);
  return spec;
}

export async function template(req, res) {
  const spec = specFor(req);
  const ctx = await loadContext();
  const lists = spec.lists(ctx);
  const refs = listRanges(lists);
  const wb = newWorkbook();
  addInstructionsSheet(wb, {
    title: `Big Star VDP — ${spec.title} bulk import`,
    intro: [
      `Downloaded ${isoDate(new Date())}. Up to ${MAX_ROWS} rows per upload.`,
      'Drop-downs are filled from the system at download time — download a fresh copy after adding divisions or plans.',
      'Records that already exist are pointed out on upload and left unchanged.',
    ],
    steps: spec.steps,
    sheets: spec.sheets,
  });
  spec.sheets.forEach((s, i) => addDataSheet(wb, { name: s.name, columns: s.columns, listRefs: refs, tab: i === 0 ? 'FF15803D' : 'FF0E7490' }));
  addReferenceSheet(wb, spec.reference(ctx));
  addListsSheet(wb, lists);
  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 1, visibility: 'visible' }];
  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${spec.fileName}"`);
  res.send(Buffer.from(buffer));
}

async function analyse(req) {
  const spec = specFor(req);
  const wb = await loadWorkbook(req.file);
  const { rows, notes } = await spec.analyse(wb, await loadContext(), req.user);
  return { spec, rows, notes };
}

function result(kind, rows, notes) {
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    kind,
    notes,
    summary: {
      total: rows.length,
      new: count('NEW'),
      created: count('CREATED'),
      exists: count('EXISTS'),
      duplicate: count('DUPLICATE'),
      error: count('ERROR'),
      withWarnings: rows.filter((r) => r.warnings.length && ['NEW', 'CREATED'].includes(r.status)).length,
    },
    rows: rows.map(({ doc, partOf, ...r }) => r),
  };
}

// Dry run: nothing is saved.
export async function preview(req, res) {
  const { rows, notes } = await analyse(req);
  res.json(result(req.params.kind, rows, notes));
}

// Saves the rows that are NEW after re-checking the same file; everything else is left alone.
export async function commit(req, res) {
  const { spec, rows, notes } = await analyse(req);
  for (const r of rows.filter((x) => x.status === 'NEW' && x.doc)) {
    try {
      await r.doc.save();
      await spec.afterSave?.(r.doc);
      r.status = 'CREATED';
    } catch (e) {
      r.status = e.code === 11000 ? 'EXISTS' : 'ERROR';
      if (e.code === 11000) r.existing = 'Created elsewhere while this import was running.';
      else r.errors.push(e.message);
    }
  }
  // Extra operator rows share their provider's outcome.
  for (const r of rows.filter((x) => x.status === 'NEW' && x.partOf)) {
    r.status = r.partOf.status === 'CREATED' ? 'CREATED' : r.partOf.status;
  }
  res.json(result(req.params.kind, rows, notes));
}
