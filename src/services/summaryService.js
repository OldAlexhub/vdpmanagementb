import VdpCycle from '../models/VdpCycle.js';
import Division from '../models/Division.js';
import Provider from '../models/Provider.js';
import Vdp from '../models/Vdp.js';
import { activeImportFor, matchRoutes, unresolvedRoutes } from './performanceService.js';
import { sum, money } from './money.js';
import { notFound } from './errors.js';
import { autoApproveDue } from './vdpService.js';

export async function cycleSummary(cycleId) {
  await autoApproveDue();
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');
  const [division, providers, vdps, importDoc] = await Promise.all([
    Division.findById(cycle.divisionId),
    Provider.find({ divisionId: cycle.divisionId }),
    Vdp.find({ cycleId: cycle._id }, 'status gross net calculation.totalDeductions calculation.totalAdditions stale providerId exceptions'),
    activeImportFor(cycle._id),
  ]);

  const matches = importDoc ? matchRoutes(importDoc, providers) : [];
  const counts = { DRAFT: 0, NEEDS_REVIEW: 0, READY: 0, APPROVED: 0, DISPUTED: 0, PROCESSED: 0, PAID: 0 };
  vdps.forEach((v) => { counts[v.status] += 1; });
  const expected = providers.filter((p) => p.status === 'ACTIVE');
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
