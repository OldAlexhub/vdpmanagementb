// VDP lifecycle: process → review → approve (snapshot) → paid, with reopen.
import Vdp, { ISSUE_AREAS } from '../models/Vdp.js';
import Provider from '../models/Provider.js';
import VdpPlan from '../models/VdpPlan.js';
import VdpCycle from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import { calculateVdp, serializeResult, CalculationError, ADJUSTMENT_TYPES, priceOn } from './calculationEngine.js';
import { calculateUberVdp, serializeUberResult, UberCalculationError } from './uberCalculationEngine.js';
import { resolveVersion, resolveSettings, engineSettings, uberEngineSettings, validateVersion, SERVICE_MILE_ALLOWANCE } from './planService.js';
import { activeImportFor, matchRoutes, unresolvedRoutes } from './performanceService.js';
import { activeUberImportsFor, matchUberDrivers, uberRowsForCycle } from './uberPerformanceService.js';
import { hoursForMetric, HOUR_METRICS } from './performanceParser.js';
import { weekOf, isoDate, endOfDayIn } from './cycleService.js';
import { activeOperators, operatorsOf, worksOn, leaseWeeksInCycle } from './operators.js';
import { bestRouteMatches } from './routeMatching.js';
import { D, sum, isBlank, str, fmtMoney, fmtRate, fmtNum } from './money.js';
import { badRequest, conflict, notFound, actor } from './errors.js';

const EDITABLE = ['DRAFT', 'NEEDS_REVIEW', 'READY'];
const ACKNOWLEDGEABLE = new Set(['NO_PERFORMANCE_DATA', 'PLAN_CHANGES_MID_CYCLE']);
// Still calculated (so the fuel allowance is visible), but the VDP cannot be READY.
const NON_BLOCKING = new Set(['NO_PERFORMANCE_DATA', 'PLAN_CHANGES_MID_CYCLE', 'FUEL_EXPENSE_MISSING']);
const usDate = (day) => `${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;
const dateList = (days) => (days.length > 4 ? `${days.slice(0, 4).map(usDate).join(', ')} and ${days.length - 4} more` : days.map(usDate).join(', '));

// The VDP uses the service mile fuel allowance (provider's plan, or any operator's own plan).
const usesAllowance = (vdp) => vdp.settings?.fuelMethod?.value === SERVICE_MILE_ALLOWANCE
  || (vdp.settings?.operatorPlans || []).some((o) => o.fuelMethod === SERVICE_MILE_ALLOWANCE);

const exception = (code, message) => ({ code, message, acknowledgeable: ACKNOWLEDGEABLE.has(code) });

// Uber's hourly rate belongs to the provider profile. A provider-level rate is the
// default for every operator; an operator rate is only needed when that person differs.
const uberBasePayFor = (provider, operator) => {
  if (!isBlank(operator.basePay)) return { value: operator.basePay, source: 'OPERATOR_PROFILE' };
  if (!isBlank(provider.overrides?.basePay)) return { value: provider.overrides.basePay, source: 'PROVIDER_PROFILE' };
  return { value: null, source: null };
};

const vehicleKey = (operator) => operator.vehicleUnit
  ? `vehicle:${operator.vehicleUnit.trim().toLowerCase()}`
  : `operator:${operator.id}`;

function uberPaymentUnits(operators) {
  const units = new Map();
  for (const operator of operators) {
    const key = vehicleKey(operator);
    const unit = units.get(key) || {
      id: key,
      vehicleUnit: operator.vehicleUnit || null,
      label: operator.vehicleUnit ? `Vehicle ${operator.vehicleUnit}` : operator.name,
      operators: [],
    };
    unit.operators.push(operator);
    units.set(key, unit);
  }
  return [...units.values()];
}

function leaseWeeksForUnit(unit, cycle) {
  const starts = [cycle.week1Start, cycle.week2Start].map(isoDate);
  const charged = starts.filter((day) => unit.operators.some((operator) => worksOn(operator, day))).length;
  return charged === starts.length ? null : String(charged);
}

function uberUnitLeases(operators, cycle, overrideWeeks) {
  return uberPaymentUnits(operators).map((unit) => {
    const configured = unit.operators.map((operator) => operator.liftLease).filter((lease) => lease.frequency !== 'NONE');
    const distinct = new Set(configured.map((lease) => `${lease.frequency}|${lease.amount ?? ''}`));
    if (distinct.size > 1) {
      throw new UberCalculationError(`${unit.label} has conflicting lift-lease settings. Enter the same lease for the shared vehicle, or keep it on one operator only.`);
    }
    const charged = configured[0] || { amount: null, frequency: 'NONE' };
    return {
      ...charged,
      calculationUnitId: unit.id,
      vehicleUnit: unit.vehicleUnit,
      operatorNames: unit.operators.map((operator) => operator.name),
      weeksCharged: overrideWeeks ?? leaseWeeksForUnit(unit, cycle),
    };
  });
}

function cycleInfo(cycle) {
  return {
    id: cycle._id,
    cycleStart: isoDate(cycle.cycleStart),
    cycleEnd: isoDate(cycle.cycleEnd),
    week1: { start: isoDate(cycle.week1Start), end: isoDate(cycle.week1End) },
    week2: { start: isoDate(cycle.week2Start), end: isoDate(cycle.week2End) },
    submissionDate: cycle.submissionDate ? isoDate(cycle.submissionDate) : null,
    paymentDate: cycle.paymentDate ? isoDate(cycle.paymentDate) : null,
  };
}

const weekTotals = (days, cycle) => [1, 2].map((n) => {
  const rows = days.filter((d) => d.week === n);
  return {
    weekNumber: n,
    start: n === 1 ? isoDate(cycle.week1Start) : isoDate(cycle.week2Start),
    end: n === 1 ? isoDate(cycle.week1End) : isoDate(cycle.week2End),
    days: rows.length,
    trips: sum(rows.map((d) => d.trips)).toString(),
    actualHours: sum(rows.map((d) => d.hours ?? 0)).toString(),
    serviceMiles: rows.some((d) => d.serviceMiles === null) ? null : sum(rows.map((d) => d.serviceMiles)).toString(),
  };
});

// Service miles per service date (routes summed) for the fuel allowance. null = missing that day.
function fuelDays(days) {
  const byDate = new Map();
  for (const d of days) {
    const e = byDate.get(d.date) || { date: d.date, week: d.week, miles: [], missing: false };
    if (d.serviceMiles === null) e.missing = true; else e.miles.push(d.serviceMiles);
    byDate.set(d.date, e);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({ date: e.date, week: e.week, serviceMiles: e.missing ? null : sum(e.miles).toString() }));
}


// Gather this provider's report rows and total them by week — overall and per operator.
// A route matched to the provider but on none of its operators is reported, not guessed
// (unless the provider has a single operator, who then runs every route).
function providerPerformance({ provider, cycle, importDoc, matches, metric, otherColumn, metricOf = () => null }) {
  const me = String(provider._id);
  // A route split between providers by an operator transfer: only this provider's dates.
  const mine = new Map();
  for (const m of matches) {
    if (!['MATCHED', 'ASSIGNED'].includes(m.status)) continue;
    const part = m.split?.find((s) => String(s.providerId) === me);
    if (part) mine.set(m.route, part);
    else if (!m.split && String(m.providerId) === me) mine.set(m.route, null);
  }
  const routes = [...mine.keys()];
  const ops = activeOperators(provider, cycle);
  // The operator with the best route match that day. Ties stay unassigned for review rather than
  // guessing between operators (for example a bare 1029 against separate 1029A and 1029B routes).
  const operatorFor = (route, day) => {
    const pick = (list) => {
      const ranked = list
        .map((o) => ({ o, score: bestRouteMatches(route, o.routes).score }))
        .filter((candidate) => candidate.score > 0);
      if (!ranked.length) return null;
      const best = Math.max(...ranked.map((candidate) => candidate.score));
      const candidates = ranked.filter((candidate) => candidate.score === best);
      return candidates.length === 1 ? candidates[0].o : null;
    };
    return (pick(ops.filter((o) => worksOn(o, day))) ?? pick(ops) ?? (ops.length === 1 ? ops[0] : null))?.id ?? null;
  };
  const days = importDoc.rows
    .filter((r) => mine.has(r.route))
    .filter((r) => { const part = mine.get(r.route); return !part || (r.date >= part.from && r.date <= part.to); })
    .map((r) => {
      const operatorId = operatorFor(r.route, r.date);
      // An operator on another plan counts the hours column that plan pays on.
      const m = metricOf(operatorId) || { metric, otherColumn };
      return {
        date: r.date,
        route: r.route,
        operatorId,
        week: weekOf(r.date, cycle),
        trips: str(r.trips) ?? '0',
        hours: str(hoursForMetric(r, m.metric, m.otherColumn)),
        serviceMiles: str(r.serviceMiles),
      };
    })
    .filter((d) => d.week);
  const operators = ops.map((o) => {
    const own = days.filter((d) => d.operatorId === o.id);
    return {
      id: o.id,
      name: o.name,
      routes: [...new Set(own.map((d) => d.route))],
      contractedHours: o.contractedHours,
      liftLease: o.liftLease,
      leaseWeeks: leaseWeeksInCycle(o, cycle),
      startDate: o.startDate,
      endDate: o.endDate,
      weeks: weekTotals(own, cycle),
    };
  });
  const unassignedRoutes = [...new Set(days.filter((d) => !d.operatorId).map((d) => d.route))];
  return { routes, days, weeks: weekTotals(days, cycle), operators, unassignedRoutes, metric, metricLabel: HOUR_METRICS[metric]?.label || otherColumn };
}

/** Recompute a VDP from current provider, plan, report and reviewer inputs. Does not save. */
export async function computeVdp(vdp, preloaded = {}) {
  const provider = preloaded.provider || (await Provider.findById(vdp.providerId));
  const cycle = preloaded.cycle || (await VdpCycle.findById(vdp.cycleId));
  const importDoc = preloaded.importDoc !== undefined ? preloaded.importDoc : await activeImportFor(vdp.cycleId);
  const exceptions = [];

  let plan = null;
  let version = null;
  let settings = null;
  if (!provider.planId) {
    exceptions.push(exception('NO_PLAN', `${provider.name} has no VDP plan assigned. Assign a plan on the provider profile.`));
  } else {
    plan = preloaded.plans?.get(String(provider.planId)) || (await VdpPlan.findById(provider.planId));
    if (!plan) {
      exceptions.push(exception('NO_PLAN', `The VDP plan assigned to ${provider.name} no longer exists.`));
    } else {
      const resolved = resolveVersion(plan, cycle);
      version = resolved.version;
      if (!version) {
        exceptions.push(exception('PLAN_NOT_EFFECTIVE',
          `Plan "${plan.name}" has no version effective on ${isoDate(cycle.cycleStart)}. Add or extend a plan version.`));
      } else {
        if (resolved.changesMidCycle) {
          exceptions.push(exception('PLAN_CHANGES_MID_CYCLE',
            `Plan "${plan.name}" changes rates inside this cycle. Version ${version.versionNumber} (effective on the cycle start) was used.`));
        }
        const versionErrors = validateVersion(version);
        if (versionErrors.length) {
          const tierError = versionErrors.some((e) => /tier/i.test(e));
          exceptions.push(exception(tierError ? 'INVALID_INCENTIVE_TIERS' : 'INVALID_PLAN',
            `Plan "${plan.name}" v${version.versionNumber} is not valid: ${versionErrors.join(' ')}`));
        }
        settings = resolveSettings(provider, plan, version);
        const s = engineSettings(settings);
        if (s.tuiEligible && s.incentiveTiers.length === 0) {
          exceptions.push(exception('TUI_WITHOUT_TIERS',
            `TUI is switched on for ${provider.name}, but plan "${plan.name}" has no incentive tiers.`));
        }
      }
    }
  }

  // Operators on their own VDP plan are paid under that plan. Provider overrides adjust the
  // provider's plan only — they do not carry over to a plan an operator was explicitly put on.
  const opPlan = new Map(); // operatorId → { settings, plan, version, own }
  if (settings) {
    for (const o of activeOperators(provider, cycle)) {
      if (!o.planId || o.planId === String(provider.planId)) {
        opPlan.set(o.id, { settings, plan, version, own: false });
        continue;
      }
      const p = preloaded.plans?.get(o.planId) || (await VdpPlan.findById(o.planId));
      if (!p) {
        exceptions.push(exception('NO_PLAN', `The VDP plan assigned to operator ${o.name} no longer exists. Choose another on the provider profile.`));
        continue;
      }
      const res = resolveVersion(p, cycle);
      if (!res.version) {
        exceptions.push(exception('PLAN_NOT_EFFECTIVE', `Plan "${p.name}" (operator ${o.name}) has no version effective on ${isoDate(cycle.cycleStart)}. Add or extend a plan version.`));
        continue;
      }
      if (res.changesMidCycle) {
        exceptions.push(exception('PLAN_CHANGES_MID_CYCLE',
          `Plan "${p.name}" (operator ${o.name}) changes rates inside this cycle. Version ${res.version.versionNumber} (effective on the cycle start) was used.`));
      }
      const errs = validateVersion(res.version);
      if (errs.length) {
        exceptions.push(exception(errs.some((e) => /tier/i.test(e)) ? 'INVALID_INCENTIVE_TIERS' : 'INVALID_PLAN',
          `Plan "${p.name}" v${res.version.versionNumber} (operator ${o.name}) is not valid: ${errs.join(' ')}`));
      }
      const own = resolveSettings({ overrides: {} }, p, res.version);
      if (own.tuiEligible.value && !own.incentiveTiers.value.length) {
        exceptions.push(exception('TUI_WITHOUT_TIERS', `Plan "${p.name}" (operator ${o.name}) has TUI on but no incentive tiers.`));
      }
      opPlan.set(o.id, { settings: own, plan: p, version: res.version, own: true });
    }
    const noContract = activeOperators(provider, cycle).filter((o) => opPlan.has(o.id)).filter((o) => {
      const s = engineSettings(opPlan.get(o.id).settings);
      return s.paymentType === 'HOURLY' && isBlank(o.contractedHours) && (isBlank(s.contractedHours) || D(s.contractedHours).lte(0));
    });
    if (noContract.length) {
      exceptions.push(exception('MISSING_CONTRACTED_HOURS', `Contracted hours are missing for ${provider.name}${noContract.length < activeOperators(provider, cycle).length ? ` (operator ${noContract.map((o) => o.name).join(', ')})` : ''}.`));
    }
  }
  const mixedPlans = [...opPlan.values()].some((x) => x.own);
  const settingsOf = (operatorId) => opPlan.get(operatorId)?.settings || settings;
  if (mixedPlans) {
    // Shown on the VDP and frozen with it: which plan each operator was paid under.
    settings = {
      ...settings,
      operatorPlans: activeOperators(provider, cycle).filter((o) => opPlan.has(o.id)).map((o) => {
        const x = opPlan.get(o.id);
        return {
          operatorId: o.id,
          name: o.name,
          planId: x.plan._id,
          planName: x.plan.name,
          versionNumber: x.version.versionNumber,
          source: x.own ? 'OPERATOR' : 'PROVIDER',
          calculationType: x.settings.calculationType?.value || 'STANDARD',
          paymentType: x.settings.paymentType.value,
          basePay: x.settings.basePay.value,
          fuelMethod: x.settings.fuelMethod.value,
          fuelMpg: x.settings.fuelMpg.value,
          performanceHourMetric: x.settings.performanceHourMetric.value,
        };
      }),
    };
  }
  const calculationTypes = new Set([...opPlan.values()].map((x) => x.settings.calculationType?.value || 'STANDARD'));
  if (calculationTypes.size > 1) {
    exceptions.push(exception('MIXED_CALCULATION_TYPES',
      'A provider cannot combine Uber and standard calculation types in one VDP. Put all active operators on plans with the same calculation type.'));
  }
  const isUber = settings?.calculationType?.value === 'UBER';

  for (const o of activeOperators(provider, cycle)) {
    const lease = o.liftLease;
    if (lease.frequency !== 'NONE' && isBlank(lease.amount)) {
      exceptions.push(exception('MISSING_LEASE_AMOUNT', `${o.name} (${provider.name}) has a ${lease.frequency.toLowerCase()} lift lease with no amount.`));
    }
  }
  if (!activeOperators(provider, cycle).length) {
    exceptions.push(exception('NO_OPERATORS', `${provider.name} has no active operators. Add one on the provider profile.`));
  }

  let performance = null;
  let uberImports = [];
  if (isUber && settings) {
    const operators = activeOperators(provider, cycle);
    const missingBasePay = operators.filter((operator) => {
      const rateStructure = settingsOf(operator.id)?.uberConfig?.value?.rateStructureType || 'FLAT';
      return rateStructure === 'FLAT' && isBlank(uberBasePayFor(provider, operator).value);
    });
    if (missingBasePay.length) {
      exceptions.push(exception('MISSING_UBER_BASE_PAY',
        `Uber base hourly rate is missing for operator${missingBasePay.length === 1 ? '' : 's'} ${missingBasePay.map((operator) => operator.name).join(', ')}. Add one provider-level rate, or an operator-specific rate when someone differs.`));
    }
    const missingContractedHours = operators.filter((operator) => isBlank(operator.contractedHours));
    if (missingContractedHours.length) {
      exceptions.push(exception('MISSING_UBER_CONTRACTED_HOURS',
        `Uber contracted hours are missing for operator${missingContractedHours.length === 1 ? '' : 's'} ${missingContractedHours.map((operator) => operator.name).join(', ')}. Add weekly contracted hours to each operator on the provider profile.`));
    }
    uberImports = preloaded.uberImports !== undefined ? preloaded.uberImports : await activeUberImportsFor(cycle._id);
    if (!uberImports.length) {
      exceptions.push(exception('NO_UBER_PERFORMANCE_IMPORT', 'No valid Uber weekly data has been uploaded for this cycle.'));
    } else {
      const byId = new Map(operators.map((operator) => [operator.id, operator]));
      const allRows = preloaded.uberRows !== undefined ? preloaded.uberRows : await uberRowsForCycle(cycle._id);
      const rows = allRows.filter((row) => String(row.providerId) === String(provider._id) && byId.has(String(row.operatorId))).map((row) => {
        const operator = byId.get(String(row.operatorId));
        const basePay = uberBasePayFor(provider, operator);
        const effective = uberEngineSettings(settingsOf(operator.id), operator.contractedHours, basePay.value, basePay.source);
        const calculationUnitId = operator.vehicleUnit ? vehicleKey(operator) : `driver:${String(row.driverUuid).toLowerCase()}`;
        return {
          ...row,
          operatorId: operator.id,
          operatorName: operator.name,
          vehicleUnit: operator.vehicleUnit,
          calculationUnitId,
          calculationUnitLabel: operator.vehicleUnit ? `Vehicle ${operator.vehicleUnit}` : operator.name,
          settings: effective,
        };
      });
      performance = {
        kind: 'UBER',
        rows,
        imports: uberImports.map((doc) => ({ id: doc._id, fileName: doc.originalFileName, fileHash: doc.fileHash, uploadedAt: doc.uploadedAt })),
        drivers: [...new Set(rows.map((row) => row.driverUuid))],
        weeks: [...new Set(rows.map((row) => row.week))].sort(),
      };
      if (!rows.length) {
        exceptions.push(exception('NO_UBER_PERFORMANCE_DATA', `No uploaded Uber rows are matched to ${provider.name}'s operators.`));
      }
    }
  } else if (!isUber) {
    if (!importDoc) {
      exceptions.push(exception('NO_PERFORMANCE_IMPORT', 'No Performance Report has been uploaded for this cycle.'));
    } else if (settings) {
      const metric = settings.performanceHourMetric.value;
      const otherColumn = settings.performanceHourColumn.value;
      const metricOf = (operatorId) => {
        const x = settingsOf(operatorId);
        return { metric: x.performanceHourMetric.value, otherColumn: x.performanceHourColumn.value };
      };
      const inPlay = [{ metric, otherColumn }, ...[...opPlan.keys()].map(metricOf)];
      const missingMetrics = new Set(inPlay.filter((m) => !(m.metric === 'OTHER'
        ? (importDoc.detectedColumns?.otherHourColumns || []).includes(m.otherColumn)
        : importDoc.detectedColumns?.[m.metric])).map((m) => HOUR_METRICS[m.metric]?.label || m.otherColumn));
      for (const label of missingMetrics) {
        exceptions.push(exception('METRIC_NOT_IN_REPORT', `The plan pays on "${label}", which is not in the uploaded report.`));
      }
      const matches = preloaded.matches || matchRoutes(importDoc, await Provider.find({ divisionId: provider.divisionId }));
      performance = providerPerformance({ provider, cycle, importDoc, matches, metric, otherColumn, metricOf: mixedPlans ? metricOf : undefined });
      if (performance.unassignedRoutes.length) {
        exceptions.push(exception('ROUTE_WITHOUT_OPERATOR',
          `Route ${performance.unassignedRoutes.join(', ')} is matched to ${provider.name} but not to any of its operators. Add it to an operator on the provider profile.`));
      }
      if (performance.days.length === 0) {
        const routeText = provider.routes.length ? `route ${provider.routes.join(', ')}` : 'no routes on the profile';
        exceptions.push(exception('NO_PERFORMANCE_DATA',
          `No Performance Report rows for ${provider.name} (${routeText}) in this cycle.`));
      }
    }
  }

  // Service mile fuel allowance: service miles, the MPG and a fuel price for every service date
  // (from the plan) are needed to calculate; the actual expense is needed before the VDP can be READY.
  let fuel = null;
  const allowanceOps = activeOperators(provider, cycle).filter((o) => settingsOf(o.id)?.fuelMethod?.value === SERVICE_MILE_ALLOWANCE);
  if (settings && (mixedPlans ? allowanceOps.length > 0 : settings.fuelMethod?.value === SERVICE_MILE_ALLOWANCE)) {
    const mpgs = mixedPlans ? allowanceOps.map((o) => settingsOf(o.id).fuelMpg?.value) : [settings.fuelMpg?.value];
    if (mpgs.some((m) => isBlank(m) || D(m).lte(0))) exceptions.push(exception('FUEL_MPG_MISSING', 'Fuel MPG configuration is missing.'));
    if (performance) {
      const pricesOf = (p) => (p?.fuelPrices || []).map((x) => ({ pricePerGallon: str(x.pricePerGallon), effectiveFrom: x.effectiveFrom, effectiveTo: x.effectiveTo || null }));
      const withPrice = (d, p) => ({ ...d, pricePerGallon: priceOn(pricesOf(p), d.date)?.pricePerGallon ?? null, planName: p?.name });
      const days = mixedPlans
        ? allowanceOps.flatMap((o) => fuelDays(performance.days.filter((d) => d.operatorId === o.id))
          .map((d) => withPrice({ ...d, mpg: settingsOf(o.id).fuelMpg?.value ?? null, operator: o.name }, opPlan.get(o.id)?.plan)))
        : fuelDays(performance.days).map((d) => withPrice(d, plan));
      const unpriced = days.filter((d) => d.pricePerGallon === null);
      if (unpriced.length) {
        const plans = [...new Set(unpriced.map((d) => d.planName))].map((n) => `"${n}"`).join(', ');
        exceptions.push(exception('FUEL_PRICE_MISSING',
          `No fuel price configured for ${dateList([...new Set(unpriced.map((d) => d.date))])}. Add it under Fuel prices on the VDP plan ${plans}.`));
      }
      if (importDoc && !importDoc.detectedColumns?.SERVICE_MILES) {
        exceptions.push(exception('SERVICE_MILES_MISSING',
          'Service Miles required for fuel calculation are missing. The uploaded Performance Report has no Miles → Service column — if it was uploaded before Service Miles were captured, upload it again.'));
      } else {
        const missing = days.filter((d) => d.serviceMiles === null).map((d) => d.date);
        if (missing.length) {
          exceptions.push(exception('SERVICE_MILES_MISSING', `Service Miles are missing from the Performance Report for ${dateList(missing)}.`));
        }
      }
      const amount = str(vdp.fuelExpense?.amount);
      if (amount === null) exceptions.push(exception('FUEL_EXPENSE_MISSING', 'Fuel expense has not been entered.'));
      fuel = { days, actualExpense: amount };
    }
  }

  let calculation = null;
  const blocking = exceptions.filter((e) => !NON_BLOCKING.has(e.code));
  if (settings && performance && blocking.length === 0) {
    try {
      if (isUber) {
        calculation = serializeUberResult(calculateUberVdp({
          settings: uberEngineSettings(settings),
          rows: performance.rows,
          weeklyAdjustments: vdp.uberWeeklyAdjustments.map((entry) => ({
            driverUuid: entry.driverUuid,
            calculationUnitId: entry.calculationUnitId,
            week: entry.week,
            approvedExtraHours: str(entry.approvedExtraHours),
            passThroughs: entry.passThroughs.map((p) => ({ type: p.type, amount: str(p.amount), description: p.description })),
          })),
          leases: uberUnitLeases(activeOperators(provider, cycle), cycle, str(vdp.leaseWeeksCharged)),
          adjustments: vdp.adjustments.map((a) => ({
            type: a.type,
            amount: str(a.amount),
            operatorId: a.operatorId ? String(a.operatorId) : null,
            operatorName: a.operatorName || null,
            week: a.week || null,
            tollDirection: a.tollDirection || null,
            description: a.description || '',
          })),
        }));
      } else {
        calculation = serializeResult(calculateVdp({
          settings: engineSettings(settings),
          operators: performance.operators.map((o) => ({
            name: o.name,
            routes: o.routes,
            ...(opPlan.get(o.id)?.own ? {
              settings: engineSettings(opPlan.get(o.id).settings),
              plan: { id: String(opPlan.get(o.id).plan._id), name: opPlan.get(o.id).plan.name, versionNumber: opPlan.get(o.id).version.versionNumber },
            } : {}),
            contractedHours: o.contractedHours,
            weeks: o.weeks,
            // A reviewer's weeks-charged wins; otherwise a transfer inside the cycle limits the weeks.
            lease: { ...o.liftLease, weeksCharged: str(vdp.leaseWeeksCharged) ?? o.leaseWeeks },
          })),
          adjustments: vdp.adjustments.map((a) => ({ type: a.type, amount: str(a.amount) })),
          fuel,
        }));
      }
    } catch (err) {
      if (!(err instanceof CalculationError) && !(err instanceof UberCalculationError)) throw err;
      exceptions.push(exception('CALCULATION_ERROR', err.message));
    }
  }

  const acknowledged = new Set(vdp.acknowledgements.map((a) => a.code));
  const open = exceptions.filter((e) => !(e.acknowledgeable && acknowledged.has(e.code)));
  const status = open.length || !calculation ? 'NEEDS_REVIEW' : 'READY';

  return { provider, plan, version, cycle, settings, performance, calculation, exceptions, status, importDoc: isUber ? null : importDoc, uberImports };
}

function applyComputation(vdp, c) {
  vdp.planId = c.plan?._id ?? null;
  vdp.planVersionId = c.version?._id ?? null;
  vdp.performanceImportId = c.importDoc?._id ?? null;
  vdp.uberPerformanceImportIds = (c.uberImports || []).map((doc) => doc._id);
  vdp.settings = c.settings;
  vdp.performance = c.performance;
  vdp.calculation = c.calculation;
  vdp.gross = c.calculation?.gross ?? null;
  vdp.net = c.calculation?.net ?? null;
  vdp.exceptions = c.exceptions;
  vdp.status = c.status;
  vdp.calculatedAt = new Date();
  vdp.stale = false;
}

export async function processCycle(cycleId, user) {
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const providers = await Provider.find({ divisionId: cycle.divisionId });
  const plans = new Map((await VdpPlan.find({ divisionId: cycle.divisionId })).map((p) => [String(p._id), p]));
  const expected = providers.filter((p) => p.status === 'ACTIVE');
  const typeFor = (provider) => {
    const plan = plans.get(String(provider.planId));
    return plan ? (resolveVersion(plan, cycle).version?.calculationType || 'STANDARD') : null;
  };
  const needsStandard = expected.some((provider) => typeFor(provider) !== 'UBER');
  const needsUber = expected.some((provider) => typeFor(provider) === 'UBER');
  const [importDoc, uberImports] = await Promise.all([
    needsStandard ? activeImportFor(cycle._id) : Promise.resolve(null),
    needsUber ? activeUberImportsFor(cycle._id) : Promise.resolve([]),
  ]);
  if (needsStandard && !importDoc) throw badRequest('Upload the Performance Report for this cycle before processing standard VDP plans.');
  if (needsUber && !uberImports.length) throw badRequest('Upload valid Uber weekly data for this cycle before processing Uber VDP plans.');
  const matches = importDoc ? matchRoutes(importDoc, providers) : [];
  const unresolved = unresolvedRoutes(matches);
  if (unresolved.length) {
    throw conflict(
      `${unresolved.length} route(s) in the Performance Report need review before VDPs can be processed.`,
      { code: 'UNRESOLVED_ROUTES', routes: unresolved },
    );
  }
  const driverMatches = needsUber ? matchUberDrivers(uberImports, providers, cycle) : [];
  const unmatchedDrivers = driverMatches.filter((match) => match.status !== 'MATCHED');
  if (unmatchedDrivers.length) {
    throw conflict(
      `${unmatchedDrivers.length} Uber driver(s) need to be matched to provider operators before VDPs can be processed.`,
      { code: 'UNRESOLVED_UBER_DRIVERS', drivers: unmatchedDrivers },
    );
  }
  const uberRows = needsUber ? await uberRowsForCycle(cycle._id) : [];
  const counts = { processed: 0, ready: 0, needsReview: 0, skippedLocked: 0 };

  for (const provider of expected) {
    let vdp = await Vdp.findOne({ providerId: provider._id, cycleId: cycle._id });
    if (vdp && !EDITABLE.includes(vdp.status)) {
      counts.skippedLocked += 1;
      continue;
    }
    const isNew = !vdp;
    vdp ||= new Vdp({ providerId: provider._id, divisionId: cycle.divisionId, cycleId: cycle._id });
    const c = await computeVdp(vdp, { provider, cycle, importDoc, matches, plans, uberImports, uberRows });
    applyComputation(vdp, c);
    vdp.history.push({ action: isNew ? 'PROCESSED' : 'RECALCULATED', by: actor(user) });
    await vdp.save();
    counts.processed += 1;
    if (vdp.status === 'READY') counts.ready += 1; else counts.needsReview += 1;
  }
  await syncCycleStatus(cycle._id);
  return counts;
}

async function loadEditable(id) {
  const vdp = await Vdp.findById(id);
  if (!vdp) throw notFound('VDP');
  if (!EDITABLE.includes(vdp.status)) {
    throw conflict(`This VDP is ${vdp.status.toLowerCase()}. Reopen it before making changes.`);
  }
  return vdp;
}

async function recalcAndSave(vdp, user, action, reason) {
  applyComputation(vdp, await computeVdp(vdp));
  vdp.history.push({ action, reason, by: actor(user) });
  await vdp.save();
  await syncCycleStatus(vdp.cycleId);
  return vdp;
}

export async function recalculate(id, user) {
  return recalcAndSave(await loadEditable(id), user, 'RECALCULATED');
}

export async function addAdjustment(id, input, user) {
  const vdp = await loadEditable(id);
  if (!ADJUSTMENT_TYPES[input.type]) throw badRequest('Choose an adjustment type.');
  if (input.type === 'FUEL' && usesAllowance(vdp)) {
    // Would deduct fuel twice: the overspend is already calculated from the actual expense.
    throw badRequest('Fuel on this plan is calculated from service miles. Enter the actual fuel expense instead — any overspend is deducted automatically.');
  }
  if (isBlank(input.amount) || !/^\d+(\.\d+)?$/.test(String(input.amount).trim()) || D(input.amount).lte(0)) {
    throw badRequest('Enter a positive amount. The type decides whether it is deducted or added.');
  }
  if (D(input.amount).decimalPlaces() > 2) throw badRequest('Amounts are in dollars and cents (max 2 decimals).');
  let tollAssignment = {};
  if (input.type === 'TOLL' && vdp.settings?.calculationType?.value === 'UBER') {
    const operatorId = String(input.operatorId || '').trim();
    const week = String(input.week || '').trim();
    const tollDirection = String(input.tollDirection || 'CREDIT').trim().toUpperCase();
    if (!operatorId) throw badRequest('Choose the provider driver for this toll.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw badRequest('Choose the Uber week for this toll.');
    if (!['CREDIT', 'DEDUCTION'].includes(tollDirection)) throw badRequest('Choose whether the toll is a provider credit or deduction.');
    const source = vdp.performance?.rows?.find((row) => String(row.operatorId) === operatorId && row.week === week);
    if (!source) throw badRequest('That driver did not have matched Uber data in the selected week.');
    tollAssignment = { operatorId, operatorName: source.operatorName, week, tollDirection };
  }
  vdp.adjustments.push({
    type: input.type,
    amount: String(input.amount).trim(),
    description: input.description,
    date: input.date || new Date(),
    ...tollAssignment,
    createdBy: actor(user),
  });
  return recalcAndSave(vdp, user, 'ADJUSTMENT_ADDED',
    `${ADJUSTMENT_TYPES[input.type].label} $${D(input.amount).toFixed(2)}${tollAssignment.tollDirection ? ` (${tollAssignment.tollDirection.toLowerCase()})` : ''}${input.description ? ` — ${input.description}` : ''}`);
}

export async function removeAdjustment(id, adjustmentId, user) {
  const vdp = await loadEditable(id);
  const adj = vdp.adjustments.id(adjustmentId);
  if (!adj) throw notFound('Adjustment');
  const text = `${ADJUSTMENT_TYPES[adj.type].label} $${D(adj.amount).toFixed(2)}`;
  adj.deleteOne();
  return recalcAndSave(vdp, user, 'ADJUSTMENT_REMOVED', text);
}

// Service mile allowance: the one number Accounting enters. Blank clears it.
export async function setFuelExpense(id, { amount, note }, user) {
  const vdp = await loadEditable(id);
  if (!usesAllowance(vdp)) {
    throw badRequest('This VDP’s plan does not use the service mile fuel allowance.');
  }
  const text = String(amount ?? '').trim().replace(/[$,]/g, '');
  if (text === '') {
    vdp.fuelExpense = { amount: null, note: undefined, enteredBy: actor(user), enteredAt: new Date() };
    return recalcAndSave(vdp, user, 'FUEL_EXPENSE_SET', 'Actual fuel expense cleared');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw badRequest('Enter the actual fuel expense in dollars and cents, e.g. 507.89.');
  const before = str(vdp.fuelExpense?.amount);
  vdp.fuelExpense = { amount: text, note: String(note || '').trim() || undefined, enteredBy: actor(user), enteredAt: new Date() };
  return recalcAndSave(vdp, user, 'FUEL_EXPENSE_SET',
    `Actual fuel expense ${before === null ? '' : `changed from $${D(before).toFixed(2)} `}set to $${D(text).toFixed(2)}${note ? ` — ${note}` : ''}`);
}

export async function setLeaseWeeks(id, { weeksCharged, note }, user) {
  const vdp = await loadEditable(id);
  if (isBlank(weeksCharged)) {
    vdp.leaseWeeksCharged = null;
  } else {
    if (!/^\d+(\.\d+)?$/.test(String(weeksCharged)) || D(weeksCharged).gt(2)) {
      throw badRequest('Weeks charged must be between 0 and 2.');
    }
    if (!String(note || '').trim()) throw badRequest('Give a reason for changing the lease weeks charged.');
    vdp.leaseWeeksCharged = String(weeksCharged);
  }
  vdp.leaseNote = note;
  return recalcAndSave(vdp, user, 'LEASE_CHANGED',
    isBlank(weeksCharged) ? 'Lease reset to all weeks in the cycle' : `Lease weeks charged: ${weeksCharged}. ${note}`);
}

// Per pay-unit/week Uber review input. Approved tolls belong in Adjustments;
// this endpoint only changes the payable-hour cap.
export async function setUberWeeklyAdjustment(id, input, user) {
  const vdp = await loadEditable(id);
  if (vdp.settings?.calculationType?.value !== 'UBER') throw badRequest('This VDP does not use an Uber plan.');
  const driverUuid = String(input.driverUuid || '').trim().toLowerCase();
  const calculationUnitId = String(input.calculationUnitId || '').trim().toLowerCase();
  const week = String(input.week || '').trim();
  if ((!driverUuid && !calculationUnitId) || !/^\d{4}-\d{2}-\d{2}$/.test(week)) throw badRequest('Choose a valid Uber pay unit and week.');
  if (!vdp.performance?.rows?.some((row) => row.week === week && (
    (calculationUnitId && String(row.calculationUnitId).toLowerCase() === calculationUnitId)
    || (driverUuid && row.driverUuid.toLowerCase() === driverUuid)
  ))) {
    throw badRequest('That pay unit/week is not part of this VDP.');
  }
  const decimal = (value, label, { blank = false } = {}) => {
    const text = String(value ?? '').trim().replace(/[$,]/g, '');
    if (blank && text === '') return null;
    if (!/^\d+(\.\d+)?$/.test(text)) throw badRequest(`${label} must be zero or a positive number.`);
    if (D(text).decimalPlaces() > 8) throw badRequest(`${label} allows at most 8 decimal places.`);
    return text;
  };
  const approvedExtraHours = decimal(input.approvedExtraHours, 'Approved extra hours', { blank: true });
  let passThroughs;
  if (Array.isArray(input.passThroughs)) {
    passThroughs = input.passThroughs.map((p, i) => ({
      type: String(p.type || '').trim().toUpperCase(),
      amount: decimal(p.amount, `Pass-through ${i + 1} amount`),
      description: String(p.description || '').trim() || undefined,
    })).filter((p) => D(p.amount).gt(0));
    if (passThroughs.some((p) => !/^[A-Z][A-Z0-9_]*$/.test(p.type))) throw badRequest('Pass-through type must use letters, numbers, and underscores.');
    if (passThroughs.some((p) => p.type === 'TOLL')) {
      throw badRequest('Enter Uber tolls in Adjustments and assign each toll to a provider driver and week.');
    }
  } else {
    passThroughs = [];
  }
  let entry = vdp.uberWeeklyAdjustments.find((item) => item.week === week && (
    (calculationUnitId && item.calculationUnitId === calculationUnitId)
    || (!calculationUnitId && item.driverUuid === driverUuid)
  ));
  if (!entry) {
    vdp.uberWeeklyAdjustments.push({ calculationUnitId: calculationUnitId || null, driverUuid: driverUuid || null, week });
    entry = vdp.uberWeeklyAdjustments[vdp.uberWeeklyAdjustments.length - 1];
  }
  entry.calculationUnitId = calculationUnitId || null;
  entry.driverUuid = driverUuid || null;
  entry.approvedExtraHours = approvedExtraHours;
  entry.passThroughs = passThroughs;
  entry.updatedBy = actor(user);
  entry.updatedAt = new Date();
  return recalcAndSave(vdp, user, 'UBER_WEEKLY_ADJUSTMENT_SET',
    `${calculationUnitId || driverUuid} / ${week}: approved extra hours ${approvedExtraHours ?? 'plan default'}`);
}

export async function acknowledge(id, { code, note }, user) {
  const vdp = await loadEditable(id);
  if (!ACKNOWLEDGEABLE.has(code)) throw badRequest('This issue must be fixed at its source, not acknowledged.');
  if (!String(note || '').trim()) throw badRequest('Explain why this is acceptable.');
  vdp.acknowledgements = vdp.acknowledgements.filter((a) => a.code !== code);
  vdp.acknowledgements.push({ code, note, by: actor(user) });
  return recalcAndSave(vdp, user, 'EXCEPTION_ACKNOWLEDGED', `${code}: ${note}`);
}

// Lift lease as shown on the VDP: one entry per distinct vehicle/pay unit.
function leaseView(provider, vdp, cycle) {
  const units = uberPaymentUnits(activeOperators(provider, cycle)).map((unit) => {
    const lease = unit.operators.map((operator) => operator.liftLease)
      .find((entry) => entry.frequency !== 'NONE') || { amount: null, frequency: 'NONE' };
    const transfers = unit.operators.flatMap((operator) => {
      if (operator.transferredTo?.effectiveDate && cycle && operator.endDate <= isoDate(cycle.cycleEnd)) {
        return [`${operator.name} moved to ${operator.transferredTo.providerName} from ${operator.transferredTo.effectiveDate}`];
      }
      if (operator.transferredFrom?.effectiveDate && cycle && operator.startDate >= isoDate(cycle.cycleStart)) {
        return [`${operator.name} joined from ${operator.transferredFrom.providerName} on ${operator.transferredFrom.effectiveDate}`];
      }
      return [];
    });
    return {
      id: unit.id,
      name: unit.label,
      vehicleUnit: unit.vehicleUnit,
      operatorNames: unit.operators.map((operator) => operator.name),
      amount: lease.amount,
      frequency: lease.frequency,
      weeksCharged: str(vdp.leaseWeeksCharged) ?? (cycle ? leaseWeeksForUnit(unit, cycle) : null),
      transfer: transfers.join(' · ') || null,
    };
  });
  const only = units.length === 1 ? units[0] : null;
  const transfers = units.filter((unit) => unit.transfer).map((unit) => unit.transfer);
  return {
    amount: only ? only.amount : null,
    frequency: only ? only.frequency : units.some((unit) => unit.frequency !== 'NONE') ? 'PER_VEHICLE' : 'NONE',
    operators: units,
    weeksCharged: str(vdp.leaseWeeksCharged) ?? only?.weeksCharged ?? null,
    note: [vdp.leaseNote, ...transfers].filter(Boolean).join(' · ') || null,
  };
}

const providerView = (p, routes) => ({
  id: p._id,
  name: p.name,
  providerNumber: p.providerNumber,
  operatorName: p.operatorName,
  routes: routes?.length ? routes : p.routes,
  serviceType: p.serviceType,
  operators: operatorsOf(p).map((o) => ({
    id: o.id,
    name: o.name,
    vehicleUnit: o.vehicleUnit,
    routes: o.routes,
    status: o.status,
    basePay: o.basePay,
    contractedHours: o.contractedHours,
  })),
});

async function buildSnapshot(vdp, c, user) {
  const division = await Division.findById(vdp.divisionId);
  return {
    capturedAt: new Date(),
    provider: providerView(c.provider, c.performance?.routes),
    division: { id: division._id, divisionNumber: division.divisionNumber, name: division.name, location: division.location, timezone: division.timezone },
    cycle: cycleInfo(c.cycle),
    plan: { id: c.plan._id, name: c.plan.name, versionId: c.version._id, versionNumber: c.version.versionNumber },
    settings: c.settings,
    lease: leaseView(c.provider, vdp, c.cycle),
    performance: c.performance,
    performanceImport: c.importDoc
      ? { id: c.importDoc._id, fileName: c.importDoc.originalFileName, fileHash: c.importDoc.fileHash, uploadedAt: c.importDoc.uploadedAt }
      : null,
    uberPerformanceImports: (c.uberImports || []).map((doc) => ({
      id: doc._id, fileName: doc.originalFileName, fileHash: doc.fileHash, uploadedAt: doc.uploadedAt,
      rowCount: doc.rowCount, weeksDetected: doc.weeksDetected,
    })),
    adjustments: vdp.adjustments.map((a) => ({
      type: a.type, amount: str(a.amount), description: a.description, date: a.date,
      operatorId: a.operatorId ? String(a.operatorId) : null, operatorName: a.operatorName, week: a.week,
      tollDirection: a.tollDirection || null, createdBy: a.createdBy, createdAt: a.createdAt,
    })),
    uberWeeklyAdjustments: vdp.uberWeeklyAdjustments.map((entry) => ({
      driverUuid: entry.driverUuid,
      week: entry.week,
      approvedExtraHours: str(entry.approvedExtraHours),
      passThroughs: entry.passThroughs.map((p) => ({ type: p.type, amount: str(p.amount), description: p.description })),
      updatedBy: entry.updatedBy,
      updatedAt: entry.updatedAt,
    })),
    acknowledgements: vdp.acknowledgements,
    fuelExpense: vdp.fuelExpense?.amount == null ? null
      : { amount: str(vdp.fuelExpense.amount), note: vdp.fuelExpense.note, enteredBy: vdp.fuelExpense.enteredBy, enteredAt: vdp.fuelExpense.enteredAt },
    calculation: c.calculation,
    gross: c.calculation.gross,
    net: c.calculation.net,
    calculatedAt: new Date(),
    approvedAt: new Date(),
    approvedBy: actor(user),
  };
}

// Big Star approval: freezes the snapshot and sends the VDP to the provider for approval.
export async function approve(id, user) {
  const vdp = await loadEditable(id);
  const c = await computeVdp(vdp); // never approve stale numbers
  applyComputation(vdp, c);
  if (vdp.status !== 'READY') {
    await vdp.save();
    throw conflict('This VDP still needs review and cannot be approved.', { exceptions: vdp.exceptions });
  }
  const division = await Division.findById(vdp.divisionId);
  vdp.snapshot = await buildSnapshot(vdp, c, user);
  vdp.status = 'APPROVED';
  vdp.approvedAt = vdp.snapshot.approvedAt;
  vdp.approvedBy = actor(user);
  const corrected = vdp.issues.filter((i) => i.status === 'IN_CORRECTION');
  corrected.forEach((i) => {
    i.status = 'RESOLVED';
    i.response.at = new Date();
    i.response.newNet = c.calculation.net;
  });
  vdp.providerDeadline = providerDeadlineFor(c.cycle, division, corrected.length > 0);
  vdp.providerApproval = { method: null };
  vdp.history.push({
    action: 'APPROVED',
    by: actor(user),
    reason: corrected.length ? 'Corrected and sent back to the provider for approval' : 'Sent to provider for approval',
  });
  await vdp.save();
  await autoApproveDue(); // approved after the deadline → processed straight away
  await syncCycleStatus(vdp.cycleId);
  return Vdp.findById(vdp._id);
}

// After Big Star answers a provider issue the provider always gets at least this long to review again.
export const ISSUE_RESPONSE_WINDOW_HOURS = 48;

function providerDeadlineFor(cycle, division, afterIssue) {
  const base = cycle.submissionDate ? endOfDayIn(cycle.submissionDate, division?.timezone) : null;
  if (!afterIssue) return base;
  const grace = new Date(Date.now() + ISSUE_RESPONSE_WINDOW_HOURS * 3600 * 1000);
  return !base || grace > base ? grace : base;
}

// The value the statement shows for an issue line (computed from the frozen snapshot).
function shownValue(snapshot, item) {
  const calc = snapshot?.calculation;
  const w = item.week ? calc?.weeks?.[item.week - 1] : null;
  const both = (fn) => calc?.weeks?.map((x) => `W${x.weekNumber}: ${fn(x)}`).join(' · ');
  const pick = (fn) => (w ? fn(w) : both(fn));
  switch (item.area) {
    case 'TRIPS': return pick((x) => `${fmtNum(x.trips)} trips`);
    case 'HOURS': return pick((x) => `${fmtNum(x.actualHours)} h`);
    case 'CONTRACTED_HOURS': return pick((x) => `${fmtNum(x.contractedHours)} h`);
    case 'RATE': return pick((x) => `${fmtRate(x.incentiveRate)} (${x.tierLabel})`);
    case 'BONUS': return pick((x) => `${fmtNum(x.bonusHours)} h = ${fmtMoney(x.bonusEarnings)}`);
    case 'LIFT_LEASE': return fmtMoney(calc?.lease);
    case 'FARES': return fmtMoney(calc?.fares);
    case 'ADJUSTMENT': {
      const a = snapshot?.adjustments?.[item.adjustmentIndex];
      return a ? `${a.type.replace(/_/g, ' ').toLowerCase()} ${fmtMoney(a.amount)}${a.description ? ` — ${a.description}` : ''}` : null;
    }
    default: return null;
  }
}

// Provider reports what is wrong and why. Pauses auto-approval until Big Star responds.
export async function raiseIssue(id, { items, comment }, user) {
  await autoApproveDue();
  const vdp = await Vdp.findOne({ _id: id, providerId: user.providerId });
  if (!vdp) throw notFound('VDP');
  if (vdp.status === 'DISPUTED') throw conflict('You already reported an issue on this statement. Big Star will respond.');
  if (vdp.status !== 'APPROVED') {
    throw conflict(vdp.status === 'PROCESSED' || vdp.status === 'PAID'
      ? 'This statement is already approved. Please contact Big Star directly.'
      : 'This statement is not open for review.');
  }
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Tell us at least one thing that is wrong.');
  if (items.length > 20) throw badRequest('Please report at most 20 lines at once.');
  const clean = items.map((it, i) => {
    const n = items.length > 1 ? ` (line ${i + 1})` : '';
    if (!ISSUE_AREAS[it.area]) throw badRequest(`Choose what is wrong${n}.`);
    const week = it.week === 1 || it.week === 2 || it.week === '1' || it.week === '2' ? Number(it.week) : null;
    const adjustmentIndex = it.area === 'ADJUSTMENT' ? Number(it.adjustmentIndex) : null;
    if (it.area === 'ADJUSTMENT' && !vdp.snapshot?.adjustments?.[adjustmentIndex]) throw badRequest(`Choose which deduction or addition is wrong${n}.`);
    const reason = String(it.reason || '').trim();
    if (reason.length < 5) throw badRequest(`Explain why it is wrong${n}.`);
    const item = { area: it.area, week, adjustmentIndex, expectedValue: String(it.expectedValue || '').trim().slice(0, 200), reason: reason.slice(0, 2000) };
    return { ...item, shownValue: shownValue(vdp.snapshot, item) };
  });
  vdp.issues.push({
    items: clean,
    comment: String(comment || '').trim().slice(0, 2000),
    raisedBy: actor(user),
    netAtRaise: vdp.snapshot?.net,
  });
  vdp.status = 'DISPUTED';
  vdp.history.push({
    action: 'ISSUE_RAISED',
    by: actor(user),
    reason: clean.map((i) => `${ISSUE_AREAS[i.area]}${i.week ? ` (week ${i.week})` : ''}: ${i.reason}`).join(' | '),
  });
  await vdp.save();
  await syncCycleStatus(vdp.cycleId);
  return vdp;
}

// Big Star answers without changing the statement; it goes back to the provider.
export async function respondToIssue(id, { message }, user) {
  const vdp = await Vdp.findById(id);
  if (!vdp) throw notFound('VDP');
  if (vdp.status !== 'DISPUTED') throw conflict('There is no open provider issue on this VDP.');
  if (String(message || '').trim().length < 5) throw badRequest('Explain to the provider why the statement is correct.');
  const issue = vdp.issues.find((i) => i.status === 'OPEN');
  issue.status = 'RESOLVED';
  issue.response = { action: 'NO_CHANGE', message: message.trim(), by: actor(user), at: new Date(), newNet: vdp.snapshot?.net };
  const [cycle, division] = await Promise.all([VdpCycle.findById(vdp.cycleId), Division.findById(vdp.divisionId)]);
  vdp.status = 'APPROVED';
  vdp.providerDeadline = providerDeadlineFor(cycle, division, true);
  vdp.history.push({ action: 'ISSUE_ANSWERED', by: actor(user), reason: message.trim() });
  await vdp.save();
  await syncCycleStatus(vdp.cycleId);
  return vdp;
}

function markProcessed(vdp, method, by, at = new Date()) {
  vdp.status = 'PROCESSED';
  vdp.providerApproval = { method, at, by };
  vdp.history.push(method === 'AUTO'
    ? { action: 'AUTO_APPROVED', by, at, reason: 'No provider response by the Closed for Submission date' }
    : { action: 'PROVIDER_APPROVED', by, at });
}

// Provider approval from the portal: only their own VDP, only while the window is open.
export async function providerApprove(id, user) {
  await autoApproveDue();
  const vdp = await Vdp.findOne({ _id: id, providerId: user.providerId });
  if (!vdp) throw notFound('VDP');
  if (vdp.status === 'PROCESSED' || vdp.status === 'PAID') {
    throw conflict(vdp.providerApproval?.method === 'AUTO'
      ? 'The submission deadline has passed, so this VDP was approved automatically.'
      : 'This VDP is already approved.');
  }
  if (vdp.status !== 'APPROVED') throw conflict('This VDP is not ready for your approval.');
  markProcessed(vdp, 'PROVIDER', actor(user));
  await vdp.save();
  await syncCycleStatus(vdp.cycleId);
  return vdp;
}

// Auto-approve every VDP whose provider deadline has passed. Idempotent; safe to run any time.
export async function autoApproveDue(now = new Date()) {
  const due = await Vdp.find({ status: 'APPROVED', providerDeadline: { $ne: null, $lte: now } });
  const cycles = new Set();
  for (const vdp of due) {
    markProcessed(vdp, 'AUTO', { name: 'System' }, now);
    await vdp.save();
    cycles.add(String(vdp.cycleId));
  }
  for (const cycleId of cycles) await syncCycleStatus(cycleId);
  return due.length;
}

export async function reopen(id, { reason }, user) {
  const vdp = await Vdp.findById(id);
  if (!vdp) throw notFound('VDP');
  if (!['APPROVED', 'DISPUTED', 'PROCESSED'].includes(vdp.status)) throw conflict('Only approved, unpaid VDPs can be reopened.');
  if (!String(reason || '').trim()) throw badRequest('A reason is required to reopen an approved VDP.');
  const openIssue = vdp.issues.find((i) => i.status === 'OPEN');
  if (openIssue) {
    // The reason is what the provider will read as Big Star's answer once the corrected VDP is re-approved.
    openIssue.status = 'IN_CORRECTION';
    openIssue.response = { action: 'CORRECTED', message: reason.trim(), by: actor(user) };
  }
  vdp.history.push({
    action: 'REOPENED',
    reason,
    by: actor(user),
    previousSnapshot: { ...vdp.snapshot, providerApproval: vdp.providerApproval?.method ? vdp.providerApproval : null },
  });
  vdp.snapshot = null;
  vdp.approvedAt = null;
  vdp.approvedBy = null;
  vdp.providerDeadline = null;
  vdp.providerApproval = { method: null };
  applyComputation(vdp, await computeVdp(vdp));
  await vdp.save();
  await syncCycleStatus(vdp.cycleId);
  return vdp;
}

export async function markPaid(id, user) {
  const vdp = await Vdp.findById(id);
  if (!vdp) throw notFound('VDP');
  if (vdp.status === 'APPROVED') {
    throw conflict('Waiting for the provider to approve (it auto-approves after the submission deadline).');
  }
  if (vdp.status === 'DISPUTED') throw conflict('The provider reported an issue. Respond to it or correct the VDP first.');
  if (vdp.status !== 'PROCESSED') throw conflict('Only approved & processed VDPs can be marked as paid.');
  vdp.status = 'PAID';
  vdp.paidAt = new Date();
  vdp.paidBy = actor(user);
  vdp.history.push({ action: 'PAID', by: actor(user) });
  await vdp.save();
  await syncCycleStatus(vdp.cycleId);
  return vdp;
}

const CYCLE_ORDER = ['UPCOMING', 'OPEN', 'PROCESSING', 'READY_FOR_REVIEW', 'APPROVED', 'PAID', 'CLOSED'];

// Move the cycle forward automatically as its VDPs progress (never backwards past a manual CLOSED).
export async function syncCycleStatus(cycleId) {
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle || cycle.status === 'CLOSED') return;
  const vdps = await Vdp.find({ cycleId }, 'status');
  if (!vdps.length) return;
  const all = (s) => vdps.every((v) => s.includes(v.status));
  let next = 'PROCESSING';
  if (all(['PAID'])) next = 'PAID';
  else if (all(['APPROVED', 'DISPUTED', 'PROCESSED', 'PAID'])) next = 'APPROVED';
  else if (all(['READY', 'APPROVED', 'DISPUTED', 'PROCESSED', 'PAID'])) next = 'READY_FOR_REVIEW';
  if (next !== cycle.status && CYCLE_ORDER.indexOf(cycle.status) >= CYCLE_ORDER.indexOf('OPEN')) {
    cycle.status = next;
    await cycle.save();
  }
}

// One consistent shape for the UI: frozen snapshot when approved, live data otherwise.
export async function vdpView(vdp) {
  const json = vdp.toJSON();
  if (vdp.snapshot) return { ...json, view: { ...vdp.snapshot, source: 'SNAPSHOT' } };
  const [provider, division, cycle, plan] = await Promise.all([
    Provider.findById(vdp.providerId),
    Division.findById(vdp.divisionId),
    VdpCycle.findById(vdp.cycleId),
    vdp.planId ? VdpPlan.findById(vdp.planId) : null,
  ]);
  return {
    ...json,
    view: {
      source: 'LIVE',
      provider: provider && providerView(provider),
      division: division && { id: division._id, divisionNumber: division.divisionNumber, name: division.name, location: division.location, timezone: division.timezone },
      cycle: cycle && cycleInfo(cycle),
      plan: plan && { id: plan._id, name: plan.name, versionId: vdp.planVersionId, versionNumber: vdp.settings?.versionNumber },
      settings: vdp.settings,
      lease: provider ? leaseView(provider, vdp, cycle) : null,
      performance: vdp.performance,
      adjustments: json.adjustments,
      fuelExpense: json.fuelExpense?.amount == null ? null : json.fuelExpense,
      calculation: vdp.calculation,
      gross: vdp.calculation?.gross ?? null,
      net: vdp.calculation?.net ?? null,
      calculatedAt: vdp.calculatedAt,
    },
  };
}

// Mark open VDPs as needing recalculation after their inputs change.
export async function markStale(filter) {
  await Vdp.updateMany({ ...filter, status: { $in: EDITABLE } }, { $set: { stale: true } });
}

export async function vdpUsesVersion(versionId) {
  return Boolean(await Vdp.exists({ planVersionId: versionId, status: { $in: ['APPROVED', 'DISPUTED', 'PROCESSED', 'PAID'] } }));
}
