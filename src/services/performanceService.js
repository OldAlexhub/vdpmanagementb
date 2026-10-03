import crypto from 'node:crypto';
import PerformanceImport from '../models/PerformanceImport.js';
import VdpCycle from '../models/VdpCycle.js';
import Provider from '../models/Provider.js';
import Vdp from '../models/Vdp.js';
import { parsePerformanceFile, ReportFormatError } from './performanceParser.js';
import { isoDate } from './cycleService.js';
import { runsRouteOn } from './operators.js';
import { bestRouteMatches, routeKey } from './routeMatching.js';
import { badRequest, conflict, notFound, actor } from './errors.js';

// Existing records predate `kind`, so STANDARD includes a missing kind value.
export const activeImportFor = (cycleId) => PerformanceImport.findOne({ cycleId, status: 'ACTIVE', kind: { $ne: 'UBER' } });

/**
 * Route → provider association for an import.
 * A route matches the single ACTIVE provider in the division that lists it. When an operator
 * moved between providers, both list the route and it is split by date (`split`).
 * Explicit resolutions on the import win. Anything else is left for a human.
 */
export function matchRoutes(importDoc, providers) {
  const routes = [...new Set(importDoc.rows.map((r) => r.route))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const resolutions = new Map(importDoc.routeResolutions.map((r) => [r.route, r]));
  const normalizedResolutions = new Map();
  for (const resolution of importDoc.routeResolutions) {
    const key = routeKey(resolution.route);
    if (!key) continue;
    if (normalizedResolutions.has(key)) normalizedResolutions.set(key, null);
    else normalizedResolutions.set(key, resolution);
  }
  const active = providers.filter((p) => p.status === 'ACTIVE');
  const byId = new Map(providers.map((p) => [String(p._id), p]));

  return routes.map((route) => {
    const rows = importDoc.rows.filter((r) => r.route === route);
    const summary = { route, days: rows.length };
    // Carry an explicit decision across corrected reports when only formatting changed. A suffix
    // change is not carried forward because one prior route could otherwise decide several rows.
    const res = resolutions.get(route) || normalizedResolutions.get(routeKey(route));
    if (res) {
      if (res.action === 'IGNORE') return { ...summary, status: 'IGNORED', resolution: res };
      const p = byId.get(String(res.providerId));
      const matched = bestRouteMatches(route, p?.routes);
      return {
        ...summary,
        status: 'ASSIGNED',
        providerId: res.providerId,
        providerName: p?.name,
        resolution: res,
        matchType: matched.matchType,
        profileRoutes: matched.routes,
      };
    }
    const ranked = active
      .map((p) => ({ p, ...bestRouteMatches(route, p.routes) }))
      .filter((candidate) => candidate.score > 0);
    const bestScore = ranked.length ? Math.max(...ranked.map((candidate) => candidate.score)) : 0;
    // Exact/normalized profile matches take precedence over the optional trailing-letter fallback.
    const listing = ranked.filter((candidate) => candidate.score === bestScore);
    // An operator who moved between providers leaves the route on both profiles; their dates decide.
    const days = [...new Set(rows.map((r) => r.date))].sort();
    const owners = (candidate) => days.filter((d) => runsRouteOn(candidate.p, route, d));
    const candidates = listing.length > 1 ? listing.filter((candidate) => owners(candidate).length) : listing;
    if (candidates.length === 1) {
      const [{ p, matchType, routes: profileRoutes }] = candidates;
      return { ...summary, status: 'MATCHED', providerId: p._id, providerName: p.name, matchType, profileRoutes };
    }
    if (candidates.length === 0) {
      return { ...summary, status: 'UNKNOWN', message: `Route ${route} is not assigned to any active provider.` };
    }
    const split = candidates.map((candidate) => ({ ...candidate, days: owners(candidate) }));
    const eachDayOnce = days.every((d) => split.filter((s) => s.days.includes(d)).length === 1);
    if (eachDayOnce) {
      const parts = split
        .map(({ p, days: own, matchType, routes: profileRoutes }) => ({
          providerId: p._id,
          providerName: p.name,
          from: own[0],
          to: own[own.length - 1],
          days: own.length,
          matchType,
          profileRoutes,
        }))
        .sort((a, b) => a.from.localeCompare(b.from));
      const last = parts[parts.length - 1];
      return {
        ...summary,
        status: 'MATCHED',
        providerId: last.providerId,
        providerName: parts.map((s) => `${s.providerName} (${s.from} – ${s.to})`).join(' → '),
        split: parts,
      };
    }
    return {
      ...summary,
      status: 'AMBIGUOUS',
      candidates: candidates.map(({ p, matchType, routes: profileRoutes }) => ({ id: p._id, name: p.name, matchType, profileRoutes })),
      message: `Route ${route} matches ${candidates.length} active providers (${candidates.map(({ p }) => p.name).join(', ')}).`,
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

  const sameFile = await PerformanceImport.findOne({ cycleId: cycle._id, fileHash, status: 'ACTIVE', kind: { $ne: 'UBER' } });
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
    kind: 'STANDARD',
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

export async function resolveRoute(importId, { route, action, providerId, operatorId, saveToProfile, note }, user) {
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
      // With several operators the route has to go to one of them.
      const active = provider.operators.filter((o) => o.status === 'ACTIVE');
      const target = active.length > 1 ? active.find((o) => String(o._id) === String(operatorId)) : active[0];
      if (active.length > 1 && !target) throw badRequest(`${provider.name} has several operators. Choose which one runs route ${route}.`);
      // Remove the route from other active providers' profiles so future reports match cleanly.
      const others = await Provider.find({ divisionId: doc.divisionId, _id: { $ne: provider._id }, routes: route, status: 'ACTIVE' });
      for (const other of others) {
        other.routes.pull(route);
        other.operators.forEach((o) => o.routes.pull(route));
        await other.save();
      }
      if (target) {
        provider.operators.forEach((o) => o.routes.pull(route));
        target.routes.push(route);
        await provider.save();
      } else if (!provider.routes.includes(route)) {
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
