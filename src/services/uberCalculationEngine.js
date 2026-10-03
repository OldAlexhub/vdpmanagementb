// Uber VDP calculation engine. Pure, deterministic, and independent of HTTP/DB.
// Percentages are ratios (0.95 = 95%) and stay at full precision for tier selection.
import { D, cents, sum, min, money, str, fmtMoney, fmtNum } from './money.js';
import { ADJUSTMENT_TYPES, calculateLease } from './calculationEngine.js';

export class UberCalculationError extends Error {}

const step = (label, detail, value, tone = 'info') => ({ label, detail, value, tone });

function minimumTier(value, tiers) {
  return [...tiers]
    .sort((a, b) => D(a.minimum).cmp(D(b.minimum)))
    .filter((tier) => D(value).gte(tier.minimum))
    .at(-1) || null;
}

function maximumTier(value, tiers) {
  return [...tiers]
    .sort((a, b) => D(a.maximum).cmp(D(b.maximum)))
    .find((tier) => D(value).lte(tier.maximum)) || null;
}

const pctText = (value) => `${D(value).times(100).toDecimalPlaces(4).toString()}%`;
const keyOf = (unit, week) => `${String(unit).toLowerCase()}|${week}`;
const SUM_FIELDS = [
  'totalSupplyHours', 'pausedHours', 'coreHoursTotalSupplyHours', 'utilizedHours',
  'totalAccepts', 'totalRejects', 'totalExpiredOffers', 'totalCancels',
  'driverEarningsExclTips', 'driverTips',
];

const sourceRow = (row) => ({
  week: row.week,
  driverUuid: row.driverUuid,
  operatorId: row.operatorId || null,
  operatorName: row.operatorName || '',
  sourceImportId: row.sourceImportId || null,
  sourceFileName: row.sourceFileName || null,
  sourceZeroFields: row.sourceZeroFields || [],
  contractedHours: row.settings?.contractedWeeklyHours ?? null,
  ...Object.fromEntries(SUM_FIELDS.map((field) => [field, row[field]])),
});

const sharedSettingsSignature = (settings = {}) => JSON.stringify(Object.fromEntries(
  Object.entries(settings).filter(([key]) => !['contractedWeeklyHours', 'contractedWeeklyHoursSource'].includes(key)),
));

// Uber contracts are normally one driver per vehicle. When several operators on
// the provider profile share a Vehicle / pay unit, their source rows are summed
// before weekly eligibility is evaluated. The individual rows remain attached
// for audit and display.
function groupCalculationRows(rows) {
  const seen = new Set();
  const groups = new Map();
  for (const row of rows || []) {
    const driverKey = keyOf(row.driverUuid, row.week);
    if (seen.has(driverKey)) throw new UberCalculationError(`Duplicate Uber row for driver ${row.driverUuid}, week ${row.week}.`);
    seen.add(driverKey);
    const unitId = row.calculationUnitId || `driver:${String(row.driverUuid).toLowerCase()}`;
    const groupKey = keyOf(unitId, row.week);
    const group = groups.get(groupKey) || { unitId, week: row.week, rows: [] };
    group.rows.push(row);
    groups.set(groupKey, group);
  }
  return [...groups.values()].map((group) => {
    const first = group.rows[0];
    const settingsSignature = sharedSettingsSignature(first.settings);
    if (group.rows.some((row) => sharedSettingsSignature(row.settings) !== settingsSignature)) {
      throw new UberCalculationError(`Operators sharing ${first.calculationUnitLabel || first.vehicleUnit || group.unitId} must use the same Uber rate and plan rules.`);
    }
    const driverUuids = [...new Set(group.rows.map((row) => row.driverUuid))];
    const operatorNames = [...new Set(group.rows.map((row) => row.operatorName).filter(Boolean))];
    const sourceFiles = [...new Set(group.rows.map((row) => row.sourceFileName).filter(Boolean))];
    const operatorHours = new Map();
    group.rows.forEach((row) => operatorHours.set(row.operatorId || row.driverUuid, row.settings?.contractedWeeklyHours));
    const contractedWeeklyHours = first.vehicleUnit && operatorHours.size > 1
      ? str(sum([...operatorHours.values()].map((value) => D(value))))
      : first.settings?.contractedWeeklyHours;
    return {
      ...first,
      settings: first.settings ? {
        ...first.settings,
        contractedWeeklyHours,
        contractedWeeklyHoursSource: first.vehicleUnit && operatorHours.size > 1 ? 'OPERATOR_PROFILE_SUM' : first.settings.contractedWeeklyHoursSource,
      } : undefined,
      calculationUnitId: group.unitId,
      calculationUnitLabel: first.calculationUnitLabel || first.vehicleUnit || operatorNames.join(' + ') || group.unitId,
      driverUuid: driverUuids.length === 1 ? driverUuids[0] : null,
      driverUuids,
      operatorName: operatorNames.join(' + '),
      operatorNames,
      sourceImportId: group.rows.length === 1 ? first.sourceImportId : null,
      sourceFileName: sourceFiles.join(', '),
      sourceFiles,
      sourceRows: group.rows.map(sourceRow),
      ...Object.fromEntries(SUM_FIELDS.map((field) => [field, str(sum(group.rows.map((row) => D(row[field]))))])),
    };
  });
}

function adjustmentFor(row, adjustments) {
  const direct = adjustments.get(keyOf(row.calculationUnitId, row.week));
  if (direct) return direct;
  const legacy = (row.driverUuids || []).map((driverUuid) => adjustments.get(keyOf(driverUuid, row.week))).filter(Boolean);
  if (!legacy.length) return {};
  const extras = [...new Set(legacy.map((entry) => entry.approvedExtraHours).filter((value) => value !== null && value !== undefined && value !== ''))];
  if (extras.length > 1) throw new UberCalculationError(`Shared vehicle ${row.calculationUnitLabel} has conflicting approved extra hours for ${row.week}. Enter one vehicle/week adjustment.`);
  return {
    approvedExtraHours: extras[0],
    passThroughs: legacy.flatMap((entry) => entry.passThroughs || []),
  };
}

function validatePlanSettings(settings) {
  if (!settings.contractHoursIncentiveTiers?.length) throw new UberCalculationError('Uber contract-hours incentive tiers are missing.');
  if (!settings.acceptanceIncentiveTiers?.length) throw new UberCalculationError('Uber acceptance incentive tiers are missing.');
  if (!settings.cancellationIncentiveTiers?.length) throw new UberCalculationError('Uber cancellation incentive tiers are missing.');
}

function validateSettings(settings) {
  validatePlanSettings(settings);
  if (D(settings.baseHourlyRate).lte(0)) {
    throw new UberCalculationError('Uber operator base hourly rate must be greater than zero.');
  }
  if (D(settings.contractedWeeklyHours).lte(0)) {
    throw new UberCalculationError('Uber operator contracted weekly hours must be greater than zero.');
  }
}

function calculateRow(settings, row, adjustment = {}) {
  settings = { ...settings, ...(row.settings || {}) };
  validateSettings(settings);
  const totalSupplyHours = D(row.totalSupplyHours);
  const pausedHours = D(row.pausedHours);
  if (totalSupplyHours.lt(0) || pausedHours.lt(0) || pausedHours.gt(totalSupplyHours)) {
    throw new UberCalculationError(`${row.driverUuid} (${row.week}) has invalid supply/paused hours.`);
  }
  const contractedHours = D(settings.contractedWeeklyHours);
  const approvedExtraHours = adjustment.approvedExtraHours === null || adjustment.approvedExtraHours === undefined || adjustment.approvedExtraHours === ''
    ? D(settings.approvedExtraHours || 0)
    : D(adjustment.approvedExtraHours);
  if (approvedExtraHours.lt(0)) throw new UberCalculationError('Approved extra hours cannot be negative.');

  const qualifyingSupplyHours = totalSupplyHours.minus(pausedHours);
  const fulfillment = qualifyingSupplyHours.div(contractedHours);
  const payableHours = min(qualifyingSupplyHours, contractedHours.plus(approvedExtraHours));
  const hourTier = minimumTier(fulfillment, settings.contractHoursIncentiveTiers);
  const hourIncentivePct = D(hourTier?.rate || 0);
  const qualificationThreshold = D([...settings.contractHoursIncentiveTiers]
    .sort((a, b) => D(a.minimum).cmp(D(b.minimum)))[0].minimum);
  const qualified = fulfillment.gte(qualificationThreshold);

  const accepts = D(row.totalAccepts);
  const rejects = D(row.totalRejects);
  const expiredOffers = D(row.totalExpiredOffers);
  const cancels = D(row.totalCancels);
  if ([accepts, rejects, expiredOffers, cancels].some((v) => v.lt(0))) {
    throw new UberCalculationError(`${row.driverUuid} (${row.week}) has a negative offer/cancellation count.`);
  }
  const totalOffers = accepts.plus(rejects).plus(expiredOffers);
  const acceptanceRate = totalOffers.gt(0) ? accepts.div(totalOffers) : D(0);
  const acceptanceTier = minimumTier(acceptanceRate, settings.acceptanceIncentiveTiers);
  const acceptanceIncentivePct = D(acceptanceTier?.rate || 0);

  const cancellationRate = accepts.gt(0) ? cancels.div(accepts) : D(0);
  const cancellationTier = accepts.gt(0) ? maximumTier(cancellationRate, settings.cancellationIncentiveTiers) : null;
  const cancellationIncentivePct = D(cancellationTier?.rate || 0);
  const acceptanceCancellationPct = min(acceptanceIncentivePct, cancellationIncentivePct);

  const utilizedHours = D(row.utilizedHours);
  if (utilizedHours.lt(0)) throw new UberCalculationError(`${row.driverUuid} (${row.week}) has negative utilized hours.`);
  const utilizationRate = qualifyingSupplyHours.gt(0) ? utilizedHours.div(qualifyingSupplyHours) : D(0);
  const utilizationIncentivePct = utilizationRate.gte(settings.utilizationTarget) ? D(settings.utilizationIncentivePct) : D(0);

  const coreHours = D(row.coreHoursTotalSupplyHours);
  if (coreHours.lt(0)) throw new UberCalculationError(`${row.driverUuid} (${row.week}) has negative core hours.`);
  const coreHoursPct = coreHours.div(contractedHours);
  const coreHoursPassed = coreHoursPct.gte(settings.coreHoursRequirement);

  const baseCompensation = cents(payableHours.times(settings.baseHourlyRate));
  const coreCompensation = cents(baseCompensation.times(settings.coreRatePct));
  const contractHoursIncentive = cents(baseCompensation.times(hourIncentivePct));
  const acceptanceCancellationIncentive = cents(baseCompensation.times(acceptanceCancellationPct));
  const utilizationIncentive = cents(baseCompensation.times(utilizationIncentivePct));
  const driverEarningsExclTips = cents(row.driverEarningsExclTips);
  const tips = cents(row.driverTips);
  const passThroughs = (adjustment.passThroughs || []).map((p) => {
    const amount = cents(p.amount || 0);
    if (amount.lt(0)) throw new UberCalculationError('Pass-through amounts cannot be negative.');
    return { type: p.type || 'OTHER', amount, description: p.description || '' };
  });
  const passThroughTotal = sum(passThroughs.map((p) => p.amount));
  const tolls = sum(passThroughs.filter((p) => p.type === 'TOLL').map((p) => p.amount));

  // The fallback is intentionally isolated: earnings excluding tips are never
  // added to the qualified accounting-style compensation.
  const normalGross = coreCompensation
    .plus(contractHoursIncentive)
    .plus(acceptanceCancellationIncentive)
    .plus(utilizationIncentive)
    .plus(tips)
    .plus(passThroughTotal);
  const fallbackGross = driverEarningsExclTips.plus(tips).plus(passThroughTotal);
  const grossVdp = cents(qualified ? normalGross : fallbackGross);

  const explanation = qualified
    ? [
        `Qualified supply: ${fmtNum(totalSupplyHours)} - ${fmtNum(pausedHours)} = ${fmtNum(qualifyingSupplyHours)} hours`,
        `Fulfillment: ${fmtNum(qualifyingSupplyHours)} / ${fmtNum(contractedHours)} = ${pctText(fulfillment)}`,
        `Payable hours: lesser of ${fmtNum(qualifyingSupplyHours)} and ${fmtNum(contractedHours.plus(approvedExtraHours))} = ${fmtNum(payableHours)}`,
        `Gross VDP: core ${fmtMoney(coreCompensation)} + hours ${fmtMoney(contractHoursIncentive)} + acceptance/cancellation ${fmtMoney(acceptanceCancellationIncentive)} + utilization ${fmtMoney(utilizationIncentive)} + tips ${fmtMoney(tips)} + pass-throughs ${fmtMoney(passThroughTotal)} = ${fmtMoney(grossVdp)}`,
      ]
    : [
        `Fulfillment ${pctText(fulfillment)} is below the configured ${pctText(qualificationThreshold)} qualification threshold.`,
        `Fallback Gross VDP: driver earnings excluding tips ${fmtMoney(driverEarningsExclTips)} + tips ${fmtMoney(tips)} + pass-throughs ${fmtMoney(passThroughTotal)} = ${fmtMoney(grossVdp)}`,
      ];

  return {
    week: row.week,
    driverUuid: row.driverUuid,
    driverUuids: row.driverUuids || [row.driverUuid],
    calculationUnitId: row.calculationUnitId || `driver:${row.driverUuid}`,
    calculationUnitLabel: row.calculationUnitLabel || row.operatorName || row.driverUuid,
    vehicleUnit: row.vehicleUnit || null,
    operatorNames: row.operatorNames || [row.operatorName].filter(Boolean),
    // Display identity comes from the provider/operator profile. The upload
    // supplies only the UUID join key and weekly performance facts.
    operatorName: row.operatorName || '',
    sourceImportId: row.sourceImportId || null,
    sourceFileName: row.sourceFileName || null,
    sourceFiles: row.sourceFiles || [row.sourceFileName].filter(Boolean),
    // Keep one compact, reproducible source snapshot. Matching hints and
    // provider-profile fields are intentionally excluded to avoid duplicating
    // master data inside the calculation.
    raw: {
      week: row.week,
      driverUuid: row.driverUuid,
      driverUuids: row.driverUuids || [row.driverUuid],
      calculationUnitId: row.calculationUnitId || `driver:${row.driverUuid}`,
      vehicleUnit: row.vehicleUnit || null,
      sourceZeroFields: row.sourceZeroFields || [],
      totalSupplyHours: row.totalSupplyHours,
      pausedHours: row.pausedHours,
      coreHoursTotalSupplyHours: row.coreHoursTotalSupplyHours,
      utilizedHours: row.utilizedHours,
      totalAccepts: row.totalAccepts,
      totalRejects: row.totalRejects,
      totalExpiredOffers: row.totalExpiredOffers,
      totalCancels: row.totalCancels,
      driverEarningsExclTips: row.driverEarningsExclTips,
      driverTips: row.driverTips,
      sourceRows: row.sourceRows || [sourceRow(row)],
    },
    settingsUsed: { ...settings },
    totalSupplyHours,
    pausedHours,
    qualifyingSupplyHours,
    contractedHours,
    approvedExtraHours,
    payableHours,
    fulfillment,
    qualified,
    qualificationThreshold,
    hourIncentivePct,
    hourTierMinimum: hourTier ? D(hourTier.minimum) : null,
    totalOffers,
    acceptanceRate,
    acceptanceIncentivePct,
    acceptanceTierMinimum: acceptanceTier ? D(acceptanceTier.minimum) : null,
    cancellationRate,
    cancellationIncentivePct,
    cancellationTierMaximum: cancellationTier ? D(cancellationTier.maximum) : null,
    acceptanceCancellationPct,
    utilizationRate,
    utilizationIncentivePct,
    coreHoursPct,
    coreHoursPassed,
    baseCompensation,
    coreCompensation,
    contractHoursIncentive,
    acceptanceCancellationIncentive,
    utilizationIncentive,
    driverEarningsExclTips,
    tips,
    tolls,
    passThroughs,
    passThroughTotal,
    grossVdp,
    explanation,
    steps: [
      step('Qualifying supply hours', `${fmtNum(totalSupplyHours)} - ${fmtNum(pausedHours)}`, `${fmtNum(qualifyingSupplyHours)} h`),
      step('Fulfillment', `${fmtNum(qualifyingSupplyHours)} / ${fmtNum(contractedHours)}`, pctText(fulfillment)),
      step('Payable hours', `cap ${fmtNum(contractedHours.plus(approvedExtraHours))} h`, `${fmtNum(payableHours)} h`),
      step(qualified ? 'Accounting-style Uber Gross VDP' : 'Uber fallback Gross VDP', qualified ? 'Qualified compensation components' : 'Earnings excluding tips + tips + pass-throughs', fmtMoney(grossVdp), 'total'),
    ],
  };
}

function paymentLedger(calculatedGross, leases, adjustments) {
  const lease = sum((leases || []).map((l) => calculateLease(l, 2).amount));
  const groups = { fares: D(0), otherDeductions: D(0), reimbursements: D(0), otherIncome: D(0) };
  let adjustmentTolls = D(0);
  let adjustmentTollDeductions = D(0);
  for (const adjustment of adjustments || []) {
    const definition = ADJUSTMENT_TYPES[adjustment.type];
    if (!definition) throw new UberCalculationError(`Unknown adjustment type "${adjustment.type}".`);
    const amount = cents(adjustment.amount);
    if (amount.lt(0)) throw new UberCalculationError('Adjustment amounts must be positive; the type sets the direction.');
    // Uber tolls are explicitly classified when entered. Existing Uber tolls
    // without a classification retain the original credit behavior.
    if (adjustment.type === 'TOLL') {
      if (adjustment.tollDirection === 'DEDUCTION') {
        adjustmentTollDeductions = adjustmentTollDeductions.plus(amount);
        groups.otherDeductions = groups.otherDeductions.plus(amount);
      } else {
        adjustmentTolls = adjustmentTolls.plus(amount);
      }
      continue;
    }
    groups[definition.group] = groups[definition.group].plus(amount);
  }
  const gross = calculatedGross.plus(adjustmentTolls);
  const totalDeductions = lease.plus(groups.fares).plus(groups.otherDeductions);
  const totalAdditions = groups.reimbursements.plus(groups.otherIncome);
  return {
    gross, calculatedGross, adjustmentTolls, adjustmentTollDeductions, lease, ...groups,
    totalDeductions, totalAdditions, net: gross.minus(totalDeductions).plus(totalAdditions),
  };
}

export function calculateUberVdp({ settings, rows, weeklyAdjustments = [], leases = [], adjustments = [] }) {
  // Contracted hours can differ by operator, so only plan-owned rules are
  // validated globally. calculateRow validates the merged operator settings.
  validatePlanSettings(settings);
  const byKey = new Map(weeklyAdjustments.map((a) => [keyOf(a.calculationUnitId || a.driverUuid, a.week), a]));
  const groupedRows = groupCalculationRows(rows);
  const calculatedRows = groupedRows.map((row) => calculateRow(settings, row, adjustmentFor(row, byKey)))
    .sort((a, b) => a.week.localeCompare(b.week) || a.calculationUnitId.localeCompare(b.calculationUnitId));

  const weekMap = new Map();
  for (const row of calculatedRows) {
    const current = weekMap.get(row.week) || { week: row.week, gross: [], hours: [], drivers: new Set(), units: new Set() };
    current.gross.push(row.grossVdp);
    current.hours.push(row.qualifyingSupplyHours);
    (row.driverUuids || []).forEach((driverUuid) => current.drivers.add(driverUuid));
    current.units.add(row.calculationUnitId);
    weekMap.set(row.week, current);
  }
  const tollCreditsByWeek = new Map();
  const tollDeductionsByWeek = new Map();
  for (const adjustment of adjustments || []) {
    if (adjustment.type === 'TOLL' && adjustment.week) {
      const target = adjustment.tollDirection === 'DEDUCTION' ? tollDeductionsByWeek : tollCreditsByWeek;
      target.set(adjustment.week, (target.get(adjustment.week) || D(0)).plus(cents(adjustment.amount)));
    }
  }
  const weeks = [...weekMap.values()].sort((a, b) => a.week.localeCompare(b.week)).map((w, i) => ({
    weekNumber: i + 1,
    week: w.week,
    start: w.week,
    end: w.week,
    trips: D(0),
    actualHours: sum(w.hours),
    calculatedEarnings: sum(w.gross),
    adjustmentTolls: tollCreditsByWeek.get(w.week) || D(0),
    adjustmentTollDeductions: tollDeductionsByWeek.get(w.week) || D(0),
    weeklyEarnings: sum(w.gross).plus(tollCreditsByWeek.get(w.week) || D(0)),
    weeklyNetBeforeLease: sum(w.gross)
      .plus(tollCreditsByWeek.get(w.week) || D(0))
      .minus(tollDeductionsByWeek.get(w.week) || D(0)),
    driverCount: w.drivers.size,
    calculationUnitCount: w.units.size,
  }));
  const calculatedGross = sum(calculatedRows.map((row) => row.grossVdp));
  const ledger = paymentLedger(calculatedGross, leases, adjustments);
  const gross = ledger.gross;
  return {
    calculationType: 'UBER',
    uberRows: calculatedRows,
    weeks,
    gross,
    ...ledger,
    fuelReimbursement: D(0),
    fuelTrips: null,
    fuelReimbursementRate: null,
    fuelReimbursementDetail: null,
    fuelAllowance: null,
    fuelOverspend: D(0),
    explanation: [
      ...calculatedRows.flatMap((row) => row.explanation.map((line) => `${row.week} ${row.calculationUnitLabel}: ${line}`)),
      `Calculated Uber pay before toll adjustments: ${weeks.map((week) => fmtMoney(week.calculatedEarnings)).join(' + ')} = ${fmtMoney(calculatedGross)}`,
      ...(ledger.adjustmentTolls.gt(0) ? [`Toll credits included in Gross: ${fmtMoney(ledger.adjustmentTolls)}`] : []),
      ...(ledger.adjustmentTollDeductions.gt(0) ? [`Toll bills included in deductions: ${fmtMoney(ledger.adjustmentTollDeductions)}`] : []),
      `VDP Gross: ${fmtMoney(calculatedGross)} + ${fmtMoney(ledger.adjustmentTolls)} toll credits = ${fmtMoney(gross)}`,
      `Net VDP: ${fmtMoney(gross)} - ${fmtMoney(ledger.totalDeductions)} + ${fmtMoney(ledger.totalAdditions)} = ${fmtMoney(ledger.net)}`,
    ],
    steps: [
      ...weeks.map((week) => step(`Week of ${week.week}`, `${week.calculationUnitCount} pay unit(s) · ${week.driverCount} driver(s)`, fmtMoney(week.weeklyEarnings), 'money')),
      ...(ledger.adjustmentTolls.gt(0) ? [step('Toll credits', 'Entered in Adjustments · included in Gross VDP', fmtMoney(ledger.adjustmentTolls), 'plus')] : []),
      ...(ledger.adjustmentTollDeductions.gt(0) ? [step('Toll deductions', 'Entered in Adjustments · billed to provider', fmtMoney(ledger.adjustmentTollDeductions), 'minus')] : []),
      step('Uber Gross VDP', 'Weekly pay units + toll credits', fmtMoney(gross), 'subtotal'),
      step('Net VDP payment', '', fmtMoney(ledger.net), 'total'),
    ],
  };
}

const serializePassThrough = (p) => ({ type: p.type, amount: money(p.amount), description: p.description });

export function serializeUberResult(result) {
  return {
    calculationType: 'UBER',
    uberRows: result.uberRows.map((row) => ({
      ...row,
      raw: row.raw,
      settingsUsed: row.settingsUsed,
      totalSupplyHours: str(row.totalSupplyHours),
      pausedHours: str(row.pausedHours),
      qualifyingSupplyHours: str(row.qualifyingSupplyHours),
      contractedHours: str(row.contractedHours),
      approvedExtraHours: str(row.approvedExtraHours),
      payableHours: str(row.payableHours),
      fulfillment: str(row.fulfillment),
      qualificationThreshold: str(row.qualificationThreshold),
      hourIncentivePct: str(row.hourIncentivePct),
      hourTierMinimum: str(row.hourTierMinimum),
      totalOffers: str(row.totalOffers),
      acceptanceRate: str(row.acceptanceRate),
      acceptanceIncentivePct: str(row.acceptanceIncentivePct),
      acceptanceTierMinimum: str(row.acceptanceTierMinimum),
      cancellationRate: str(row.cancellationRate),
      cancellationIncentivePct: str(row.cancellationIncentivePct),
      cancellationTierMaximum: str(row.cancellationTierMaximum),
      acceptanceCancellationPct: str(row.acceptanceCancellationPct),
      utilizationRate: str(row.utilizationRate),
      utilizationIncentivePct: str(row.utilizationIncentivePct),
      coreHoursPct: str(row.coreHoursPct),
      baseCompensation: money(row.baseCompensation),
      coreCompensation: money(row.coreCompensation),
      contractHoursIncentive: money(row.contractHoursIncentive),
      acceptanceCancellationIncentive: money(row.acceptanceCancellationIncentive),
      utilizationIncentive: money(row.utilizationIncentive),
      driverEarningsExclTips: money(row.driverEarningsExclTips),
      tips: money(row.tips),
      tolls: money(row.tolls),
      passThroughs: row.passThroughs.map(serializePassThrough),
      passThroughTotal: money(row.passThroughTotal),
      grossVdp: money(row.grossVdp),
    })),
    weeks: result.weeks.map((week) => ({
      ...week,
      trips: str(week.trips),
      actualHours: str(week.actualHours),
      calculatedEarnings: money(week.calculatedEarnings),
      adjustmentTolls: money(week.adjustmentTolls),
      adjustmentTollDeductions: money(week.adjustmentTollDeductions),
      weeklyEarnings: money(week.weeklyEarnings),
      weeklyNetBeforeLease: money(week.weeklyNetBeforeLease),
    })),
    gross: money(result.gross),
    calculatedGross: money(result.calculatedGross),
    adjustmentTolls: money(result.adjustmentTolls),
    adjustmentTollDeductions: money(result.adjustmentTollDeductions),
    lease: money(result.lease),
    fares: money(result.fares),
    otherDeductions: money(result.otherDeductions),
    reimbursements: money(result.reimbursements),
    otherIncome: money(result.otherIncome),
    totalDeductions: money(result.totalDeductions),
    totalAdditions: money(result.totalAdditions),
    net: money(result.net),
    fuelReimbursement: '0.00',
    fuelTrips: null,
    fuelReimbursementRate: null,
    fuelReimbursementDetail: null,
    fuelAllowance: null,
    fuelOverspend: '0.00',
    explanation: result.explanation,
    steps: result.steps,
  };
}
