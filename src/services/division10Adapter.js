import crypto from 'node:crypto';
import PerformanceImport from '../models/PerformanceImport.js';
import NormalizedFact from '../models/NormalizedFact.js';
import Provider from '../models/Provider.js';
import { actor } from './errors.js';
import { D, sum, str } from './money.js';
import { isoDate, weekOf } from './cycleService.js';
import { activeOperators, worksOn } from './operators.js';
import { bestRouteMatches } from './routeMatching.js';
import { normalizeName, suggestOperator } from './uberDriverMatching.js';

export const DIV10_ADAPTER_VERSION = 'DIV10_V2';
const REQUIRED = ['DIV10_MANIFESTS', 'DIV10_JASPER_TRIPS', 'DIV10_TRAPEZE_HOURS'];
const DIVISION_ADAPTERS = {
  5: { version: 'DIV5_V1', required: ['DIV5_BIG_EXPORT', 'DIV5_RPR', 'DIV5_TICKETS'], performance: ['DIV5_RPR'] },
  6: { version: 'DIV6_V1', required: ['DIV6_TRAPEZE', 'DIV6_RETURNED_TICKETS'], performance: ['DIV6_TRAPEZE'] },
  7: { version: 'DIV7_V1', required: ['DIV7_DAILY_PRODUCTIVITY', 'DIV7_DRIVER_HOURS', 'DIV7_FARES', 'DIV7_MANIFESTS', 'DIV7_MESSAGES'], performance: ['DIV7_DAILY_PRODUCTIVITY'], windows: ['DIV7_DRIVER_HOURS'] },
  8: { version: 'DIV8_V1', required: ['DIV8_DUTY', 'DIV8_RIDERSHIP'], performance: ['DIV8_DUTY'], windows: ['DIV8_DUTY'] },
  11: { version: 'DIV11_V1', required: ['DIV11_RIDES', 'DIV11_SHIFT_HOURS'], performance: ['DIV11_SHIFT_HOURS'], windows: ['DIV11_SHIFT_HOURS'] },
};

export const divisionAdapterFor = (divisionNumber) => DIVISION_ADAPTERS[String(divisionNumber || '').trim()] || null;

const FACT_FIELD = {
  PERFORMANCE: 'rows',
  OBSERVED_WINDOW: 'division10ManifestRows',
  FARE: 'division10FareRows',
  FUEL: 'division10FuelRows',
  ADJUSTMENT: 'sourceAdjustmentRows',
};

const storageHours = (value) => (
  value === null || value === undefined || value === ''
    ? value
    : D(value).toDecimalPlaces(12).toString()
);

function storedFactPayload(fact) {
  if (fact.factType !== 'OBSERVED_WINDOW' || !fact.payload) return fact.payload;
  // Facts written before the time parser's Decimal128 boundary may contain a
  // repeating 40-digit duration. Normalize those legacy facts while hydrating
  // them so an already-uploaded cycle can recover without another upload.
  return {
    ...fact.payload,
    actualHours: storageHours(fact.payload.actualHours),
    lunchHours: storageHours(fact.payload.lunchHours),
  };
}

const activeSources = async (cycleId) => {
  const docs = await PerformanceImport.find({
    cycleId,
    kind: 'DIVISION_SOURCE',
    status: 'ACTIVE',
    validationStatus: 'VALID',
  }).sort({ uploadedAt: 1 });
  if (!docs.length) return docs;
  const facts = await NormalizedFact.find({ importId: { $in: docs.map((doc) => doc._id) } }).sort({ sequence: 1 }).lean();
  const byImport = new Map();
  for (const fact of facts) {
    const key = String(fact.importId);
    if (!byImport.has(key)) byImport.set(key, {});
    const field = FACT_FIELD[fact.factType];
    if (field) (byImport.get(key)[field] ||= []).push(storedFactPayload(fact));
  }
  for (const doc of docs) {
    const stored = byImport.get(String(doc._id));
    // Backward compatibility keeps already-normalized legacy imports usable
    // while every newly uploaded source uses the bounded fact collection.
    if (!stored) continue;
    for (const field of Object.values(FACT_FIELD)) doc[field] = stored[field] || [];
  }
  return docs;
};

export function division10SourcesAdapterReady(sources) {
  return REQUIRED.every((datasetType) => {
    const files = sources.filter((doc) => doc.datasetType === datasetType);
    return files.length > 0 && files.every((doc) => doc.stats?.adapterVersion === DIV10_ADAPTER_VERSION);
  });
}

export function divisionSourcesAdapterReady(divisionNumber, sources) {
  const config = divisionAdapterFor(divisionNumber);
  if (!config) return false;
  return config.required.every((datasetType) => {
    const files = sources.filter((doc) => doc.datasetType === datasetType);
    return files.length > 0 && files.every((doc) => doc.stats?.adapterVersion === config.version);
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

export async function refreshDivisionDerivedImport({ cycle, division, user = null }) {
  const config = divisionAdapterFor(division?.divisionNumber);
  if (!config) return null;
  const sources = await activeSources(cycle._id);
  const current = await PerformanceImport.findOne({ cycleId: cycle._id, kind: 'STANDARD', status: 'ACTIVE' });
  const latest = current?.stats?.sourceAdapter === config.version ? current : await PerformanceImport.findOne({
    cycleId: cycle._id, kind: 'STANDARD', 'stats.sourceAdapter': config.version,
  }).sort({ uploadedAt: -1 });
  if (!divisionSourcesAdapterReady(division.divisionNumber, sources)) {
    if (current?.stats?.sourceAdapter === config.version) {
      current.status = 'REPLACED';
      current.replacedAt = new Date();
      current.replaceReason = `DIV ${division.divisionNumber} source coverage is incomplete`;
      if (user) current.replacedBy = actor(user);
      await current.save();
    }
    return null;
  }
  const rows = newestRows(sources.filter((doc) => config.performance.includes(doc.datasetType)), 'rows', (row) => `${row.date}|${row.route}`)
    .sort((a, b) => a.date === b.date ? a.route.localeCompare(b.route, undefined, { numeric: true }) : a.date.localeCompare(b.date));
  const manifests = newestRows(sources.filter((doc) => config.windows?.includes(doc.datasetType)), 'division10ManifestRows', (row) => `${row.date}|${row.route}`);
  const adjustments = newestRows(sources, 'sourceAdjustmentRows', (row) => `${row.date}|${row.providerName}|${row.type}|${row.description}`);
  const fuel = newestRows(sources, 'division10FuelRows', (row) => `${row.date}|${normalizeName(row.operatorName)}`);
  const hash = crypto.createHash('sha256').update(sources.map((doc) => doc.fileHash).sort().join('|')).digest('hex');
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const weeks = [...new Set(dates.map((date) => weekOf(date, cycle)).filter(Boolean).map((week) => week === 1 ? isoDate(cycle.week1Start) : isoDate(cycle.week2Start)))].sort();
  let derived = latest;
  if (!derived) derived = new PerformanceImport({
    divisionId: cycle.divisionId,
    cycleId: cycle._id,
    kind: 'STANDARD',
    originalFileName: `DIV ${division.divisionNumber} normalized source pipeline`,
    uploadedBy: user ? actor(user) : { name: 'System' },
  });
  if (current && String(current._id) !== String(derived._id)) {
    current.status = 'REPLACED';
    current.replacedAt = new Date();
    current.replaceReason = `Replaced by normalized DIV ${division.divisionNumber} source pipeline`;
    if (user) current.replacedBy = actor(user);
    await current.save();
  }
  derived.status = 'ACTIVE';
  derived.validationStatus = 'VALID';
  derived.fileHash = hash;
  derived.fileSize = sources.reduce((total, doc) => total + Number(doc.fileSize || 0), 0);
  derived.rowCount = rows.length;
  derived.dataRange = dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null;
  derived.datesDetected = dates;
  derived.weeksDetected = weeks;
  derived.rows = rows;
  derived.division10ManifestRows = manifests;
  derived.sourceAdjustmentRows = adjustments;
  derived.division10FuelRows = fuel;
  derived.detectedColumns = {
    date: true,
    route: true,
    trips: true,
    TOTAL_HOURS: rows.some((row) => row.totalHours !== null && row.totalHours !== undefined),
    SERVICE_HOURS: rows.some((row) => row.serviceHours !== null && row.serviceHours !== undefined),
    REVENUE_HOURS: rows.some((row) => row.revenueHours !== null && row.revenueHours !== undefined),
    SERVICE_MILES: rows.some((row) => row.serviceMiles !== null && row.serviceMiles !== undefined),
    otherHourColumns: manifests.length ? ['Incentive Hours'] : [],
  };
  derived.stats = {
    sourceAdapter: config.version,
    windowSource: manifests.length > 0,
    sourceImportIds: sources.map((doc) => String(doc._id)),
    sourceFileNames: sources.map((doc) => doc.originalFileName),
    adjustmentRows: adjustments.length,
    fuelRows: fuel.length,
  };
  await derived.save();
  return derived;
}

const weekday = (date) => ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date(`${date}T12:00:00Z`).getUTCDay()];
const clock = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  return match ? (Number(match[1]) * 60) + Number(match[2]) : null;
};

function timezoneOffset(epoch, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epoch));
  const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second) - epoch;
}

function zonedEpoch(date, minutes, timezone) {
  const [year, month, day] = date.split('-').map(Number);
  const dayOffset = Math.floor(minutes / (24 * 60));
  const minuteOfDay = ((minutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  const wall = Date.UTC(year, month - 1, day + dayOffset, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let epoch = wall;
  for (let iteration = 0; iteration < 3; iteration += 1) epoch = wall - timezoneOffset(epoch, timezone);
  return epoch;
}

function overlapMinutes(date, observed, scheduled, timezone) {
  try {
    const observedStart = zonedEpoch(date, observed.start, timezone);
    const observedEnd = zonedEpoch(date, observed.end, timezone);
    const scheduledStart = zonedEpoch(date, scheduled.start, timezone);
    const scheduledEnd = zonedEpoch(date, scheduled.end, timezone);
    return {
      overlap: Math.max(0, Math.min(observedEnd, scheduledEnd) - Math.max(observedStart, scheduledStart)) / 60000,
      observed: Math.max(0, observedEnd - observedStart) / 60000,
    };
  } catch {
    return {
      overlap: Math.max(0, Math.min(observed.end, scheduled.end) - Math.max(observed.start, scheduled.start)),
      observed: Math.max(0, observed.end - observed.start),
    };
  }
}

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

export function division10ImportForProvider(importDoc, provider, timezone = 'America/Los_Angeles') {
  if (!importDoc?.stats?.windowSource && importDoc?.stats?.sourceAdapter !== DIV10_ADAPTER_VERSION) return importDoc;
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
    const overlaps = windows.map((window) => {
      const calculated = overlapMinutes(row.date, { start, end }, window, timezone);
      return { window, minutes: calculated.overlap, observedMinutes: calculated.observed };
    });
    const best = overlaps.sort((a, b) => b.minutes - a.minutes)[0] || null;
    const incentiveMinutes = windows.length
      ? best.minutes
      // A known Compass window that is not scheduled for this weekday means
      // zero qualifying hours, not missing source data.
      : configuredWindows.length ? 0 : null;
    row.otherHours = {
      ...plainOtherHours(row),
      'Incentive Hours': incentiveMinutes === null ? null : D(incentiveMinutes).div(60).toString(),
    };
    row.tui = {
      route: row.route,
      date: row.date,
      compassWindow: best ? { startMinutes: best.window.start, endMinutes: best.window.end } : null,
      observedInterval: { startMinutes: start, endMinutes: end },
      overlapMinutes: incentiveMinutes,
      excludedMinutes: incentiveMinutes === null ? null : Math.max(0, (best?.observedMinutes ?? end - start) - incentiveMinutes),
      timezone,
      sourceOperatorName: manifest.operatorName || null,
      sourceRule: 'FIRST_LAST_ARRIVED',
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

export function division10ProviderSourceData({ importDoc, provider, matches, cycle, timezone }) {
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
    importDoc: division10ImportForProvider(importDoc, provider, timezone),
    cashFares: sum(fareRows.map((row) => row.cashFares || 0)).toString(),
    fuelExpense: fuelRows.length ? sum(fuelRows.map((row) => row.amount || 0)).toString() : null,
    fareRows: fareRows.length,
    fuelRows: fuelRows.length,
  };
}

const sameProviderName = (source, provider) => {
  const left = normalizeName(source);
  const right = normalizeName(provider.name);
  return left && right && (left === right || left.includes(right) || right.includes(left));
};

export function divisionProviderSourceData({ importDoc, provider, matches, cycle, timezone }) {
  if (!importDoc?.stats?.sourceAdapter) return { importDoc, adjustments: [], fuelExpense: null };
  const base = importDoc.stats.sourceAdapter === DIV10_ADAPTER_VERSION
    ? division10ProviderSourceData({ importDoc, provider, matches, cycle, timezone })
    : (() => {
        const fuelCandidates = activeOperators(provider, cycle).map((operator) => ({
          providerId: provider._id, providerName: provider.name,
          operatorId: operator.id, operatorName: operator.name,
        }));
        const fuelRows = (importDoc.division10FuelRows || []).filter((row) => row.date >= isoDate(cycle.cycleStart)
          && row.date <= isoDate(cycle.cycleEnd) && Boolean(suggestOperator(row.operatorName, fuelCandidates).suggestion));
        return {
          importDoc: division10ImportForProvider(importDoc, provider, timezone),
          fuelExpense: fuelRows.length ? sum(fuelRows.map((row) => row.amount || 0)).toString() : null,
          fuelRows: fuelRows.length,
        };
      })();
  const from = isoDate(cycle.cycleStart);
  const to = isoDate(cycle.cycleEnd);
  const adjustments = (importDoc.sourceAdjustmentRows || [])
    .filter((row) => row.date >= from && row.date <= to && sameProviderName(row.providerName, provider))
    .map((row) => ({ type: row.type, amount: str(row.amount), description: row.description }));
  if (D(base.cashFares || 0).gt(0)) adjustments.push({ type: 'FARES', amount: base.cashFares, description: 'DIV 10 Jasper cash fares' });
  return { ...base, adjustments };
}

