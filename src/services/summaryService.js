import VdpCycle from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import Vdp from '../models/Vdp.js';
import VdpPlan from '../models/VdpPlan.js';
import { activeImportFor, matchRoutes, unresolvedRoutes } from './performanceService.js';
import { activeUberImportsFor, listUberImports, matchUberDrivers } from './uberPerformanceService.js';
import { activeUberTollImportsFor, listUberTollImports, uberTollReadiness } from './uberTollService.js';
import { activeDivision3ImportsFor, listDivision3Imports, division3Readiness } from './division3ImportService.js';
import { resolveVersion } from './planService.js';
import { isoDate } from './cycleService.js';
import { sum, money } from './money.js';
import { notFound } from './errors.js';
import { autoApproveDue } from './vdpService.js';
import { isDivision3Division, processingDivisionsFor } from './divisionGroups.js';
import { divisionSourceReadiness } from './divisionSourceService.js';

export async function cycleSummary(cycleId) {
  await autoApproveDue();
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const division = await Division.findById(cycle.divisionId);
  const processingDivisions = await processingDivisionsFor(division);
  const divisionIds = processingDivisions.map((item) => item._id);
  const [providers, vdps, importDoc, uberImports, uberUploads, tollImports, tollUploads, plans, division3Imports, division3Uploads] = await Promise.all([
    Provider.find({ divisionId: { $in: divisionIds } }),
    Vdp.find({ cycleId: cycle._id }, 'status gross net calculation.totalDeductions calculation.totalAdditions stale providerId exceptions'),
    activeImportFor(cycle._id),
    activeUberImportsFor(cycle._id),
    listUberImports({ cycleId: cycle._id }),
    activeUberTollImportsFor(cycle._id),
    listUberTollImports({ cycleId: cycle._id }),
    VdpPlan.find({ divisionId: { $in: divisionIds } }),
    activeDivision3ImportsFor(cycle._id),
    listDivision3Imports({ cycleId: cycle._id }),
  ]);

  const matches = importDoc ? matchRoutes(importDoc, providers) : [];
  const counts = { DRAFT: 0, NEEDS_REVIEW: 0, READY: 0, APPROVED: 0, DISPUTED: 0, PROCESSED: 0, PAID: 0 };
  vdps.forEach((v) => { counts[v.status] += 1; });
  const expected = providers.filter((p) => p.status === 'ACTIVE');
  const plansById = new Map(plans.map((plan) => [String(plan._id), plan]));
  const planType = (provider) => {
    const plan = plansById.get(String(provider.planId));
    return plan ? (resolveVersion(plan, cycle).version?.calculationType || 'STANDARD') : 'STANDARD';
  };
  const uberProviderCount = expected.filter((provider) => planType(provider) === 'UBER').length;
  const division3 = isDivision3Division(division);
  const standardProviderCount = division3 ? 0 : expected.length - uberProviderCount;
  // DIV 2 has a fixed Uber + toll source contract even before its Compass roster
  // has been added. This keeps the file pipeline ready while provider count is zero.
  const division2 = String(division?.divisionNumber || '').trim() === '2';
  const division10 = String(division?.divisionNumber || '').trim() === '10';
  const division12 = String(division?.divisionNumber || '').trim() === '12';
  // DIV 3 can be processed from ADA/GoLink alone. Uber remains available, and
  // once any Uber data is supplied both weekly files must still be complete.
  const uberRequired = division2 || division12 || (!division3 && uberProviderCount > 0);
  // DIV 10 does not use the Uber driver-week toll reimbursement feed.
  const tollsRequired = division2 || (division3 && uberImports.length > 0);
  const tollsAvailable = division2 || division3 || division12;
  const driverMatches = matchUberDrivers(uberImports, providers, cycle);
  const tollReadiness = uberTollReadiness({ cycle, tollImports, uberImports });
  const expectedUberWeeks = [isoDate(cycle.week1Start), isoDate(cycle.week2Start)];
  const loadedUberWeeks = [...new Set(uberImports.flatMap((doc) => doc.weeksDetected || []))].sort();
  const missingUberWeeks = (division2 || division10 || (division3 && uberImports.length > 0))
    ? expectedUberWeeks.filter((week) => !loadedUberWeeks.includes(week))
    : [];
  const division3Data = division3 ? division3Readiness({ cycle, imports: division3Imports, providers, processingDivisions }) : null;
  const divisionSources = await divisionSourceReadiness({ cycle, division });
  const activePlanAssignments = expected.map((provider) => {
    const plan = plansById.get(String(provider.planId));
    return plan ? { provider, plan, version: resolveVersion(plan, cycle).version } : null;
  }).filter(Boolean);
  const actualFuelAssignments = activePlanAssignments.filter(({ version }) => version?.fuelMethod === 'ACTUAL_EXPENSE_REIMBURSEMENT');
  for (const dataset of Object.values(divisionSources.datasets || {})) {
    dataset.applicable = true;
    if (dataset.id === 'DIV7_LAKESIDE_FUEL') {
      dataset.applicable = actualFuelAssignments.some(({ plan, provider }) => plan.blueprint?.id === 'div7-lakeside' || /lakeside/i.test(`${plan.name} ${provider.name}`));
    } else if (dataset.id === 'DIV7_COAST_FUEL') {
      dataset.applicable = actualFuelAssignments.some(({ plan, provider }) => plan.blueprint?.id !== 'div7-lakeside' && !/lakeside/i.test(`${plan.name} ${provider.name}`));
    }
  }
  if (division3Data) {
    for (const source of Object.values(division3Data.sources)) {
      source.files = division3Uploads.filter((upload) => upload.kind === source.kind);
    }
  }
  const calculated = vdps.filter((v) => v.gross !== null && v.gross !== undefined);

  return {
    cycle,
    division,
    processingDivisions,
    performance: importDoc
      ? {
          loaded: true,
          importId: importDoc._id,
          fileName: importDoc.originalFileName,
          uploadedAt: importDoc.uploadedAt,
          uploadedBy: importDoc.uploadedBy,
          rowCount: importDoc.rowCount,
          dataRange: importDoc.dataRange,
          routes: matches,
          unresolvedCount: unresolvedRoutes(matches).length,
        }
      : { loaded: false },
    uberPerformance: {
      required: uberRequired,
      loaded: uberImports.length > 0,
      files: uberUploads,
      activeFileCount: uberImports.length,
      rowCount: uberImports.reduce((total, doc) => total + (doc.rowCount || 0), 0),
      weeksDetected: loadedUberWeeks,
      expectedWeeks: (division2 || division3 || division10) ? expectedUberWeeks : [],
      missingWeeks: missingUberWeeks,
      ready: uberImports.length > 0 ? missingUberWeeks.length === 0 : !uberRequired,
      driversDetected: driverMatches.length,
      driverMatches,
      unresolvedCount: driverMatches.filter((match) => match.status !== 'MATCHED').length,
    },
    uberTolls: {
      required: tollsRequired,
      loaded: tollImports.length > 0,
      ready: tollReadiness.ready,
      files: tollUploads,
      activeFileCount: tollImports.length,
      rowCount: tollImports.reduce((total, doc) => total + (doc.rowCount || 0), 0),
      tollRowCount: tollImports.reduce((total, doc) => total + Number(doc.stats?.tollRowCount || 0), 0),
      tollTotal: tollImports.reduce((total, doc) => total + Number(doc.stats?.tollTotal || 0), 0).toFixed(2),
      ...tollReadiness,
    },
    division3Data,
    divisionSources,
    inputRequirements: {
      standardProviderCount,
      uberProviderCount,
      uberRequired,
      uberOptional: division3,
      tollsRequired,
      tollsAvailable,
      division3Required: division3,
      divisionSourcesRequired: divisionSources.configured,
      // No generic fallback: an unconfigured division must provide sample
      // source files before Accounting can upload or process it.
      standardPerformanceRequired: false,
    },
    providersExpected: expected.length,
    providersWithoutVdp: expected.filter((p) => !vdps.some((v) => String(v.providerId) === String(p._id))).length,
    vdps: {
      total: vdps.length,
      calculated: calculated.length,
      stale: vdps.filter((v) => v.stale).length,
      ...counts,
    },
    totals: {
      gross: money(sum(calculated.map((v) => v.gross))),
      deductions: money(sum(calculated.map((v) => v.calculation?.totalDeductions || 0))),
      additions: money(sum(calculated.map((v) => v.calculation?.totalAdditions || 0))),
      net: money(sum(calculated.map((v) => v.net))),
    },
  };
}
