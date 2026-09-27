import crypto from 'node:crypto';
import PerformanceImport from '../models/PerformanceImport.js';
import VdpCycle from '../models/VdpCycle.js';
import Provider from '../models/Provider.js';
import Vdp from '../models/Vdp.js';
import { parsePerformanceFile, ReportFormatError } from './performanceParser.js';
import { isoDate } from './cycleService.js';
import { badRequest, conflict, notFound, actor } from './errors.js';

export const activeImportFor = (cycleId) => PerformanceImport.findOne({ cycleId, status: 'ACTIVE' });

/**
 * Route → provider association for an import.
 * A route matches the single ACTIVE provider in the division that lists it.
 * Explicit resolutions on the import win. Anything else is left for a human.
 */
export function matchRoutes(importDoc, providers) {
  const routes = [...new Set(importDoc.rows.map((r) => r.route))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const resolutions = new Map(importDoc.routeResolutions.map((r) => [r.route, r]));
  const active = providers.filter((p) => p.status === 'ACTIVE');
  const byId = new Map(providers.map((p) => [String(p._id), p]));

  return routes.map((route) => {
    const rows = importDoc.rows.filter((r) => r.route === route);
    const summary = { route, days: rows.length };
    const res = resolutions.get(route);
    if (res) {
      if (res.action === 'IGNORE') return { ...summary, status: 'IGNORED', resolution: res };
      const p = byId.get(String(res.providerId));
      return { ...summary, status: 'ASSIGNED', providerId: res.providerId, providerName: p?.name, resolution: res };
    }
    const candidates = active.filter((p) => p.routes.includes(route));
    if (candidates.length === 1) {
      return { ...summary, status: 'MATCHED', providerId: candidates[0]._id, providerName: candidates[0].name };
    }
    if (candidates.length === 0) {
      return { ...summary, status: 'UNKNOWN', message: `Route ${route} is not assigned to any active provider.` };
    }
    return {
      ...summary,
      status: 'AMBIGUOUS',
      candidates: candidates.map((p) => ({ id: p._id, name: p.name })),
      message: `Route ${route} is assigned to ${candidates.length} active providers (${candidates.map((p) => p.name).join(', ')}).`,
    };
  });
}

export const unresolvedRoutes = (matches) => matches.filter((m) => m.status === 'UNKNOWN' || m.status === 'AMBIGUOUS');

async function markCycleVdpsStale(cycleId) {
  await Vdp.updateMany({ cycleId, status: { $in: ['DRAFT', 'NEEDS_REVIEW', 'READY'] } }, { $set: { stale: true } });
}

export async function importReport({ cycleId, file, replace = false, replaceReason, user }) {
  if (!file) throw badRequest('Choose the Performance Report file to upload.');
  const cycle = await VdpCycle.findById(cycleId);
  if (!cycle) throw notFound('VDP cycle');

  const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const current = await activeImportFor(cycle._id);

  const sameFile = await PerformanceImport.findOne({ cycleId: cycle._id, fileHash, status: 'ACTIVE' });
  if (sameFile) {
    throw conflict(
      `This exact file (${sameFile.originalFileName}) is already loaded for this cycle. Nothing was imported.`,
      { code: 'DUPLICATE_UPLOAD', importId: sameFile._id },
    );
  }
  if (current && !replace) {
    throw conflict(
      `A Performance Report (${current.originalFileName}) is already loaded for this cycle. Confirm replacement to load a corrected report.`,
      { code: 'REPLACEMENT_REQUIRED', importId: current._id },
    );
  }
  if (current && replace && !String(replaceReason || '').trim()) {
    throw badRequest('Give a reason for replacing the loaded Performance Report.');
  }

  let parsed;
  try {
    parsed = await parsePerformanceFile(file.buffer, file.originalname, {
      from: isoDate(cycle.cycleStart),
      to: isoDate(cycle.cycleEnd),
    });
  } catch (err) {
    if (err instanceof ReportFormatError) throw badRequest(err.message);
    throw badRequest(`The file could not be read: ${err.message}`);
  }
  if (parsed.rows.length === 0) {
    const range = parsed.reportRange ? ` The report covers ${parsed.reportRange.from} to ${parsed.reportRange.to}.` : '';
    throw badRequest(`The report has no rows inside this cycle (${isoDate(cycle.cycleStart)} – ${isoDate(cycle.cycleEnd)}).${range}`);
  }

  const doc = new PerformanceImport({
    divisionId: cycle.divisionId,
    cycleId: cycle._id,
    originalFileName: file.originalname,
    fileHash,
    fileSize: file.size ?? file.buffer.length,
    uploadedBy: actor(user),
    rowCount: parsed.stats.dataRows,
    reportRange: parsed.reportRange,
    dataRange: parsed.dataRange,
    detectedColumns: parsed.detectedColumns,
    stats: parsed.stats,
    warnings: parsed.warnings,
    rows: parsed.rows,
  });

  if (current) {
    // Carry forward route decisions the user already made for this cycle.
    doc.routeResolutions = current.routeResolutions;
    current.status = 'REPLACED';
    current.replacedAt = new Date();
    current.replacedBy = actor(user);
    current.replaceReason = replaceReason;
    await current.save();
  }
  await doc.save();
  await markCycleVdpsStale(cycle._id);
  if (['UPCOMING', 'OPEN'].includes(cycle.status)) {
    cycle.status = 'PROCESSING';
    await cycle.save();
  }
  return doc;
}

export async function resolveRoute(importId, { route, action, providerId, saveToProfile, note }, user) {
  const doc = await PerformanceImport.findById(importId);
  if (!doc) throw notFound('Performance import');
  if (doc.status !== 'ACTIVE') throw badRequest('This report has been replaced; resolve routes on the current report.');
  if (!doc.rows.some((r) => r.route === route)) throw badRequest(`Route ${route} is not in this report.`);
  if (!['ASSIGN', 'IGNORE', 'CLEAR'].includes(action)) throw badRequest('Choose to assign or ignore the route.');

  doc.routeResolutions = doc.routeResolutions.filter((r) => r.route !== route);
  if (action === 'ASSIGN') {
    const provider = await Provider.findOne({ _id: providerId, divisionId: doc.divisionId });
    if (!provider) throw badRequest('Choose a provider in this division.');
    doc.routeResolutions.push({ route, action, providerId: provider._id, note, resolvedBy: actor(user) });
    if (saveToProfile) {
      // Remove the route from other active providers' profiles so future reports match cleanly.
      await Provider.updateMany(
        { divisionId: doc.divisionId, _id: { $ne: provider._id }, routes: route, status: 'ACTIVE' },
        { $pull: { routes: route } },
      );
      if (!provider.routes.includes(route)) {
        provider.routes.push(route);
        await provider.save();
      }
    }
  } else if (action === 'IGNORE') {
    doc.routeResolutions.push({ route, action, note, resolvedBy: actor(user) });
  }
  await doc.save();
  await markCycleVdpsStale(doc.cycleId);
  return doc;
}
