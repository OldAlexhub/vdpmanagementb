import VdpCycle from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import Vdp from '../models/Vdp.js';
import VdpPlan from '../models/VdpPlan.js';
import { activeImportFor, matchRoutes, unresolvedRoutes } from './performanceService.js';
import { activeUberImportsFor, listUberImports, matchUberDrivers } from './uberPerformanceService.js';
import { resolveVersion } from './planService.js';
import { sum, money } from './money.js';
import { notFound } from './errors.js';
import { autoApproveDue } from './vdpService.js';

export async function cycleSummary(cycleId) {
  await autoApproveDue();
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const [division, providers, vdps, importDoc, uberImports, uberUploads, plans] = await Promise.all([
    Division.findById(cycle.divisionId),
    Provider.find({ divisionId: cycle.divisionId }),
    Vdp.find({ cycleId: cycle._id }, 'status gross net calculation.totalDeductions calculation.totalAdditions stale providerId exceptions'),
    activeImportFor(cycle._id),
    activeUberImportsFor(cycle._id),
    listUberImports({ cycleId: cycle._id }),
    VdpPlan.find({ divisionId: cycle.divisionId }),
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
  const standardProviderCount = expected.length - uberProviderCount;
  const driverMatches = matchUberDrivers(uberImports, providers, cycle);
  const calculated = vdps.filter((v) => v.gross !== null && v.gross !== undefined);

  return {
    cycle,
    division,
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
      required: uberProviderCount > 0,
      loaded: uberImports.length > 0,
      files: uberUploads,
      activeFileCount: uberImports.length,
      rowCount: uberImports.reduce((total, doc) => total + (doc.rowCount || 0), 0),
      weeksDetected: [...new Set(uberImports.flatMap((doc) => doc.weeksDetected || []))].sort(),
      driversDetected: driverMatches.length,
      driverMatches,
      unresolvedCount: driverMatches.filter((match) => match.status !== 'MATCHED').length,
    },
    inputRequirements: { standardProviderCount, uberProviderCount },
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
