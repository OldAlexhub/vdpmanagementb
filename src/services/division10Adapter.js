import crypto from 'node:crypto';
import PerformanceImport from '../models/PerformanceImport.js';
import Provider from '../models/Provider.js';
import { actor } from './errors.js';
import { D, sum, str } from './money.js';
import { isoDate, weekOf } from './cycleService.js';
import { activeOperators, worksOn } from './operators.js';
import { bestRouteMatches } from './routeMatching.js';
import { normalizeName, suggestOperator } from './uberDriverMatching.js';

export const DIV10_ADAPTER_VERSION = 'DIV10_V2';
const REQUIRED = ['DIV10_MANIFESTS', 'DIV10_JASPER_TRIPS', 'DIV10_TRAPEZE_HOURS'];

const activeSources = (cycleId) => PerformanceImport.find({
  cycleId,
  kind: 'DIVISION_SOURCE',
  status: 'ACTIVE',
  validationStatus: 'VALID',
}).sort({ uploadedAt: 1 });

export function division10SourcesAdapterReady(sources) {
  return REQUIRED.every((datasetType) => {
    const files = sources.filter((doc) => doc.datasetType === datasetType);
    return files.length > 0 && files.every((doc) => doc.stats?.adapterVersion === DIV10_ADAPTER_VERSION);
  });
}

const plainOtherHours = (row) => {
  if (!row?.otherHours) return {};
  if (row.otherHours instanceof Map) return Object.fromEntries(row.otherHours.entries());
  if (typeof row.otherHours.toObject === 'function') return row.otherHours.toObject();
  return { ...row.otherHours };
};

function newestRows(sources, field, keyOf) {
  const rows = new Map();
  for (const source of sources) {
    for (const row of source[field] || []) rows.set(keyOf(row), row.toObject ? row.toObject() : { ...row });
  }
  return [...rows.values()];
}

function derivedRows(sources) {
  const trapeze = newestRows(
    sources.filter((doc) => doc.datasetType === 'DIV10_TRAPEZE_HOURS'),
    'rows',
    (row) => `${row.date}|${row.route}`,
  );
  const manifests = newestRows(
    sources.filter((doc) => doc.datasetType === 'DIV10_MANIFESTS'),
    'division10ManifestRows',
    (row) => `${row.date}|${row.route}`,
  );
  const byKey = new Map(trapeze.map((row) => [`${row.date}|${row.route}`, {
    date: row.date,
    route: row.route,
    trips: str(row.trips) || '0',
    totalHours: str(row.totalHours),
    serviceHours: str(row.serviceHours),
    revenueHours: str(row.revenueHours),
    serviceMiles: str(row.serviceMiles),
    otherHours: plainOtherHours(row),
  }]));
  for (const manifest of manifests) {
    const key = `${manifest.date}|${manifest.route}`;
    const current = byKey.get(key) || {
      date: manifest.date, route: manifest.route, trips: '0', totalHours: null,
      serviceHours: null, revenueHours: null, serviceMiles: null, otherHours: {},
    };
    // The finalized workbook pays overnight routes from manifest first/last
    // actual activity, while Trapeze remains the source for trips and miles.
    current.totalHours = str(manifest.actualHours);
    current.otherHours['Manifest Lunch Hours'] = str(manifest.lunchHours) || '0';
    byKey.set(key, current);
  }
  return [...byKey.values()].filter((row) => [
    row.trips, row.totalHours, row.serviceHours, row.revenueHours, row.serviceMiles,
  ].some((value) => value !== null && D(value || 0).gt(0))).sort((a, b) => (a.date === b.date
    ? a.route.localeCompare(b.route, undefined, { numeric: true })
    : a.date.localeCompare(b.date)));
}

const combined = (sources, datasetType, field, keyOf) => newestRows(
  sources.filter((doc) => doc.datasetType === datasetType), field, keyOf,
);

/**
 * Materialize a small STANDARD import from the normalized DIV 10 source facts.
 * This deliberately stores no raw report rows beyond the daily calculation
 * grain, and lets the existing route-review and VDP calculation engine run.
 */
export async function refreshDivision10DerivedImport({ cycle, user = null }) {
  const [sources, providers] = await Promise.all([
    activeSources(cycle._id),
    Provider.find({ divisionId: cycle.divisionId, status: 'ACTIVE' }),
  ]);
  const current = await PerformanceImport.findOne({ cycleId: cycle._id, kind: 'STANDARD', status: 'ACTIVE' });
  const latestDerived = current?.stats?.sourceAdapter === DIV10_ADAPTER_VERSION
    ? current
    : await PerformanceImport.findOne({
      cycleId: cycle._id, kind: 'STANDARD', 'stats.sourceAdapter': DIV10_ADAPTER_VERSION,
    }).sort({ uploadedAt: -1 });
  if (!division10SourcesAdapterReady(sources)) {
    if (current?.stats?.sourceAdapter === DIV10_ADAPTER_VERSION) {
      current.status = 'REPLACED';
      current.replacedAt = new Date();
      current.replaceReason = 'DIV 10 source coverage or normalized source data is incomplete';
      if (user) current.replacedBy = actor(user);
      await current.save();
    }
    return null;
  }

  const rows = derivedRows(sources);
  const manifests = combined(sources, 'DIV10_MANIFESTS', 'division10ManifestRows', (row) => `${row.date}|${row.route}`);
  const fares = combined(sources, 'DIV10_JASPER_TRIPS', 'division10FareRows', (row) => `${row.date}|${row.route}|${row.operatorName}`);
  const fuel = combined(sources, 'DIV10_COAST_FUEL', 'division10FuelRows', (row) => `${row.date}|${normalizeName(row.operatorName)}`);
  const hash = crypto.createHash('sha256').update(sources.map((doc) => doc.fileHash).sort().join('|')).digest('hex');
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const weeks = [...new Set(dates.map((date) => weekOf(date, cycle)).filter(Boolean).map((week) => (
    week === 1 ? isoDate(cycle.week1Start) : isoDate(cycle.week2Start)
  )))].sort();
  const sourceIds = sources.map((doc) => String(doc._id));
  const sourceNames = sources.map((doc) => doc.originalFileName);
  const routeResolutions = [...(latestDerived?.routeResolutions || current?.routeResolutions || [])];
  const resolvedRoutes = new Set(routeResolutions.map((resolution) => resolution.route));
  const candidates = providers.flatMap((provider) => activeOperators(provider, cycle).map((operator) => ({
    providerId: provider._id,
    providerName: provider.name,
    operatorId: operator.id,
    operatorName: operator.name,
  })));
  const sourceNamesByRoute = new Map();
  for (const manifest of manifests) {
    if (D(manifest.actualHours || 0).lte(0) || !manifest.operatorName) continue;
    if (!sourceNamesByRoute.has(manifest.route)) sourceNamesByRoute.set(manifest.route, new Set());
    sourceNamesByRoute.get(manifest.route).add(manifest.operatorName);
  }
  for (const route of [...new Set(rows.map((row) => row.route))]) {
    if (resolvedRoutes.has(route)) continue;
    const routeOwners = providers.filter((provider) => bestRouteMatches(route, provider.routes).score > 0);
    if (routeOwners.length) continue;
    const suggestions = [...(sourceNamesByRoute.get(route) || [])]
      .map((sourceName) => suggestOperator(sourceName, candidates).suggestion)
      .filter(Boolean);
    const providerIds = new Set(suggestions.map((suggestion) => String(suggestion.providerId)));
    if (suggestions.length && providerIds.size === 1) {
      const suggestion = suggestions[0];
      routeResolutions.push({
        route,
        action: 'ASSIGN',
        providerId: suggestion.providerId,
        note: `Automatically matched from the DIV 10 manifest operator name (${[...(sourceNamesByRoute.get(route) || [])].join(', ')}).`,
        resolvedBy: user ? actor(user) : { name: 'DIV 10 source adapter' },
        resolvedAt: new Date(),
      });
      resolvedRoutes.add(route);
    }
  }

  let derived = latestDerived;
  if (!derived) {
    if (current) {
      current.status = 'REPLACED';
      current.replacedAt = new Date();
      current.replaceReason = 'Replaced by normalized DIV 10 source pipeline';
      if (user) current.replacedBy = actor(user);
      await current.save();
    }
    derived = new PerformanceImport({
      divisionId: cycle.divisionId,
      cycleId: cycle._id,
      kind: 'STANDARD',
      originalFileName: 'DIV 10 normalized source pipeline',
      fileHash: hash,
      uploadedBy: user ? actor(user) : { name: 'System' },
      routeResolutions,
    });
  } else if (current && String(current._id) !== String(derived._id)) {
    current.status = 'REPLACED';
    current.replacedAt = new Date();
    current.replaceReason = 'Replaced by normalized DIV 10 source pipeline';
    if (user) current.replacedBy = actor(user);
    await current.save();
  }
  derived.status = 'ACTIVE';
  derived.validationStatus = 'VALID';
  derived.replacedAt = undefined;
  derived.replacedBy = undefined;
  derived.replaceReason = undefined;
  derived.fileHash = hash;
  derived.fileSize = sources.reduce((total, doc) => total + Number(doc.fileSize || 0), 0);
  derived.rowCount = rows.length;
  derived.dataRange = dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null;
  derived.datesDetected = dates;
  derived.weeksDetected = weeks;
  derived.rows = rows;
  derived.routeResolutions = routeResolutions;
  derived.division10ManifestRows = manifests;
  derived.division10FareRows = fares;
  derived.division10FuelRows = fuel;
  derived.detectedColumns = {
    date: true, route: true, trips: true,
    TOTAL_HOURS: manifests.length > 0,
    SERVICE_HOURS: sources.some((doc) => doc.datasetType === 'DIV10_TRAPEZE_HOURS' && doc.detectedColumns?.SERVICE_HOURS),
    REVENUE_HOURS: sources.some((doc) => doc.datasetType === 'DIV10_TRAPEZE_HOURS' && doc.detectedColumns?.REVENUE_HOURS),
    SERVICE_MILES: sources.some((doc) => doc.datasetType === 'DIV10_TRAPEZE_HOURS' && doc.detectedColumns?.SERVICE_MILES),
    otherHourColumns: ['Incentive Hours', 'Manifest Lunch Hours'],
  };
  derived.stats = {
    sourceAdapter: DIV10_ADAPTER_VERSION,
    sourceImportIds: sourceIds,
    sourceFileNames: sourceNames,
    manifestDayRows: manifests.length,
    fareRows: fares.length,
    fuelRows: fuel.length,
  };
  derived.warnings = sources.flatMap((doc) => doc.warnings || []).slice(0, 50);
  await derived.save();
  return derived;
}

const weekday = (date) => ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date(`${date}T12:00:00Z`).getUTCDay()];
const clock = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  return match ? (Number(match[1]) * 60) + Number(match[2]) : null;
};

function windowFor(operator, route, date, allowOperatorFallback = false, scheduledOnly = true) {
  const day = weekday(date);
  const configured = operator?.tuiWindows || [];
  let candidates = configured.filter((window) => {
    const routeScore = window.route ? bestRouteMatches(route, [window.route]).score : 1;
    return routeScore > 0;
  });
  if (!candidates.length && allowOperatorFallback) candidates = configured;
  if (scheduledOnly) {
    candidates = candidates.filter((window) => (
      !window.daysOfWeek?.length || window.daysOfWeek.includes(day)
    ));
  }
  return candidates.flatMap((window) => {
    const override = (window.weekdayTimes || []).find((entry) => entry.day === day);
    const start = clock(override?.startTime || window.startTime);
    let end = clock(override?.endTime || window.endTime);
    if (start === null || end === null) return [];
    if (end <= start) end += 24 * 60;
    return [{ start, end }];
  });
}

function operatorFor(provider, route, date, sourceName) {
  const available = activeOperators(provider).filter((operator) => worksOn(operator, date));
  const candidates = available.map((operator) => ({
    operator,
    score: bestRouteMatches(route, operator.routes).score,
  })).filter((candidate) => candidate.score > 0);
  if (candidates.length) {
    const best = Math.max(...candidates.map((candidate) => candidate.score));
    const winners = candidates.filter((candidate) => candidate.score === best);
    if (winners.length === 1) return { operator: winners[0].operator, byName: false };
  }
  const suggestion = suggestOperator(sourceName, available.map((operator) => ({
    providerId: provider._id, providerName: provider.name,
    operatorId: operator.id, operatorName: operator.name,
  }))).suggestion;
  const operator = suggestion && available.find((candidate) => candidate.id === String(suggestion.operatorId));
  return operator ? { operator, byName: true } : null;
}

export function division10ImportForProvider(importDoc, provider) {
  if (importDoc?.stats?.sourceAdapter !== DIV10_ADAPTER_VERSION) return importDoc;
  const manifests = new Map((importDoc.division10ManifestRows || []).map((row) => [`${row.date}|${row.route}`, row]));
  const rows = importDoc.rows.map((stored) => {
    const row = stored.toObject ? stored.toObject() : { ...stored };
    const manifest = manifests.get(`${row.date}|${row.route}`);
    if (!manifest) return row;
    const operatorMatch = operatorFor(provider, row.route, row.date, manifest.operatorName);
    const windows = windowFor(operatorMatch?.operator, row.route, row.date, operatorMatch?.byName);
    const configuredWindows = windowFor(operatorMatch?.operator, row.route, row.date, operatorMatch?.byName, false);
    const start = Number(manifest.actualStartMinutes);
    const end = Number(manifest.actualEndMinutes);
    const incentiveMinutes = windows.length
      ? Math.max(...windows.map((window) => Math.max(0, Math.min(end, window.end) - Math.max(start, window.start))))
      // A known Compass window that is not scheduled for this weekday means
      // zero qualifying hours, not missing source data.
      : configuredWindows.length ? 0 : null;
    row.otherHours = {
      ...plainOtherHours(row),
      'Incentive Hours': incentiveMinutes === null ? null : D(incentiveMinutes).div(60).toString(),
    };
    return row;
  });
  return { ...(importDoc.toObject ? importDoc.toObject() : importDoc), rows };
}

const belongsToProvider = (match, providerId, date) => {
  if (!['MATCHED', 'ASSIGNED'].includes(match?.status)) return false;
  const split = match.split?.find((part) => String(part.providerId) === String(providerId));
  if (split) return date >= split.from && date <= split.to;
  return !match.split && String(match.providerId) === String(providerId);
};

export function division10ProviderSourceData({ importDoc, provider, matches, cycle }) {
  if (importDoc?.stats?.sourceAdapter !== DIV10_ADAPTER_VERSION) {
    return { importDoc, cashFares: '0', fuelExpense: null };
  }
  const byRoute = new Map(matches.map((match) => [match.route, match]));
  const from = isoDate(cycle.cycleStart);
  const to = isoDate(cycle.cycleEnd);
  const fareRows = (importDoc.division10FareRows || []).filter((row) => row.date >= from && row.date <= to
    && belongsToProvider(byRoute.get(row.route), provider._id, row.date));
  const fuelCandidates = activeOperators(provider, cycle).map((operator) => ({
    providerId: provider._id, providerName: provider.name,
    operatorId: operator.id, operatorName: operator.name,
  }));
  const fuelRows = (importDoc.division10FuelRows || []).filter((row) => row.date >= from && row.date <= to
    && Boolean(suggestOperator(row.operatorName, fuelCandidates).suggestion));
  return {
    importDoc: division10ImportForProvider(importDoc, provider),
    cashFares: sum(fareRows.map((row) => row.cashFares || 0)).toString(),
    fuelExpense: fuelRows.length ? sum(fuelRows.map((row) => row.amount || 0)).toString() : null,
    fareRows: fareRows.length,
    fuelRows: fuelRows.length,
  };
}

