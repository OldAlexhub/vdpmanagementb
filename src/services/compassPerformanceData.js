import crypto from 'node:crypto';
import { D, sum } from './money.js';
import { badRequest } from './errors.js';
import { operatorsOf, worksOn } from './operators.js';
import { bestRouteMatches, routeKey } from './routeMatching.js';

export const hashPerformance = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceFingerprint = (row) => hashPerformance([row.date, row.route, row.divisionId, row.source, row.trips, row.serviceHours, row.revenueHours, row.externalOperatorId, row.externalProviderId, row.reportedOperator]);
export const needsPaidHours = (settings) => settings.paymentType?.value === 'HOURLY'
  || settings.bonusEnabled?.value || settings.standbyGuaranteeEnabled?.value
  || (settings.rateCards?.value || []).some((card) => card.components.some((c) => c.basis === 'HOURS'));
export const needsAttainmentHours = (settings) => Boolean(settings.tuiEligible?.value || settings.bonusEnabled?.value);
const id = (value) => String(value?._id || value || '');
const invalid = (message) => badRequest(message, { code: 'COMPASS_INVALID_PERFORMANCE' });

export function metricValue(value, field, optional = false) {
  if (optional && (value === null || value === undefined)) return null;
  if (!['string', 'number'].includes(typeof value) || !/^\d+(\.\d+)?$/.test(String(value))) throw invalid(`Compass ${field} must be a nonnegative number.`);
  const n = D(value);
  if (!n.isFinite() || n.lt(0) || (field === 'trips' && !n.isInteger())) throw invalid(`Invalid ${field}.`);
  return n.toString();
}

// Keep signed upstream hours for exact reconciliation. A negative source hour
// value is unusable for pay and is flagged separately; it must not discard valid
// trips/service hours when only an unrelated revenue-hours field is affected.
const sourceHours = (value, field) => {
  if (value === null || value === undefined) return null;
  if (!['string', 'number'].includes(typeof value) || !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(String(value)) || !D(value).isFinite()) throw invalid(`Compass ${field} must be a finite number.`);
  return D(value).toString();
};
export const unusableHour = (value) => value === null || value === undefined || D(value).lt(0);

export function normalizeCompassPerformance(entries, analysis, { divisionId, externalDivisionId, from, to }) {
  if (!Array.isArray(entries) || !Array.isArray(analysis?.records) || !Array.isArray(analysis?.daily) || !analysis?.summary) throw invalid('Compass performance response is incomplete.');
  const parents = new Map();
  for (const entry of entries) {
    if (!entry._id || parents.has(id(entry._id)) || id(entry.division) !== externalDivisionId || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || entry.date < from || entry.date > to) throw invalid('Compass returned duplicate or out-of-period entries.');
    parents.set(id(entry._id), entry);
  }
  const seen = new Set();
  const rows = analysis.records.map((record) => {
    const entry = parents.get(id(record.id));
    if (!entry || record.date !== entry.date || record.source !== entry.source || id(record.divisionId) !== externalDivisionId) throw invalid('Compass detail and performance records do not agree. Refresh again.');
    const componentKey = record.componentKey === null || record.componentKey === undefined ? null : String(record.componentKey);
    const component = componentKey === null ? null : (entry.components || []).find((item, index) => String(item.sourceRecordKey || item.sourceDutyId || (item.sourceRow ?? index)) === componentKey);
    if (componentKey !== null && !component) throw invalid('Compass component detail is missing.');
    const metrics = component || entry.metrics;
    const route = record.route || entry.route?.code || entry.deployment?.canonicalRoute;
    if (!route || !metrics) throw invalid('Compass route or metrics are missing.');
    const rowKey = hashPerformance([externalDivisionId, entry.source, id(entry._id), componentKey]);
    if (seen.has(rowKey)) throw invalid('Compass returned duplicate component records.');
    seen.add(rowKey);
    const row = {
      rowKey, divisionId: String(divisionId), externalDivisionId,
      sourceRecordId: id(entry._id), componentKey, source: entry.source,
      date: entry.date, route: String(route),
      trips: metricValue(metrics.completedTrips, 'trips'),
      serviceHours: sourceHours(metrics.reportedServiceHours, 'serviceHours'),
      revenueHours: sourceHours(metrics.reportedRevenueHours, 'revenueHours'),
      externalOperatorId: id(record.operatorId) || null,
      externalProviderId: id(record.providerId) || null,
      reportedOperator: record.reportedOperator || record.operator || null,
      assignmentSource: record.assignmentSource || null,
    };
    if (!D(row.trips).eq(metricValue(record.trips, 'trips'))) throw invalid('Compass trip detail changed during retrieval. Refresh again.');
    return { ...row, fingerprint: sourceFingerprint(row) };
  });
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.sourceRecordId)) grouped.set(row.sourceRecordId, []);
    grouped.get(row.sourceRecordId).push(row);
  }
  if (grouped.size !== parents.size) throw invalid('Compass entries and performance coverage do not agree.');
  const check = (items, expected, label) => {
    for (const [field, upstream] of [['trips', 'trips'], ['serviceHours', 'serviceHours'], ['revenueHours', 'revenueHours']]) {
      const actual = sum(items.map((row) => row[field])).toDecimalPlaces(field === 'trips' ? 0 : 2);
      const expectedValue = field === 'trips' ? metricValue(expected[upstream], field) : sourceHours(expected[upstream], field);
      if (expectedValue === null || !actual.eq(D(expectedValue).toDecimalPlaces(field === 'trips' ? 0 : 2))) throw invalid(`Compass ${label} ${field} totals do not reconcile. Refresh again.`);
    }
  };
  for (const [entryId, items] of grouped) {
    if (items.some((row) => row.componentKey === null) && items.length !== 1) throw invalid('Compass returned both parent and component metrics.');
    if (items.every((row) => row.componentKey !== null) && items.length !== parents.get(entryId).components?.length) throw invalid('Compass component coverage is incomplete.');
    const m = parents.get(entryId).metrics;
    check(items, { trips: m.completedTrips, serviceHours: m.reportedServiceHours ?? 0, revenueHours: m.reportedRevenueHours ?? 0 }, 'entry');
  }
  check(rows, analysis.summary, 'period');
  const daily = new Map(analysis.daily.map((day) => [day.date, day]));
  for (const date of new Set(rows.map((row) => row.date))) {
    if (!daily.has(date)) throw invalid('Compass daily coverage is missing.');
    check(rows.filter((row) => row.date === date), daily.get(date), date);
  }
  for (const [date, day] of daily) check(rows.filter((row) => row.date === date), day, date);
  return rows.sort((a, b) => a.rowKey.localeCompare(b.rowKey));
}

export function matchCompassRows(rows, providers, corrections = []) {
  const correctionByKey = new Map(corrections.filter((c) => c.active).map((c) => [c.rowKey, c]));
  const candidates = providers.flatMap((p) => operatorsOf(p).map((o) => ({ p, o })));
  const present = new Set(rows.map((row) => row.rowKey));
  const sourceRows = [...rows, ...[...correctionByKey.values()].filter((c) => !present.has(c.rowKey)).map((c) => ({
    ...c.sourceRow, ...c.original, fingerprint: 'MISSING', missingFromSource: true,
  }))];
  const results = sourceRows.map((row) => {
    const correction = correctionByKey.get(row.rowKey);
    const eligible = candidates.filter(({ p, o }) => String(p.divisionId) === row.divisionId && worksOn(o, row.date) && (o.status === 'ACTIVE' || o.endDate));
    let matches = row.externalOperatorId ? eligible.filter(({ o }) => o.source?.externalId === row.externalOperatorId) : [];
    if (!row.externalOperatorId && row.reportedOperator) {
      const name = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
      matches = eligible.filter(({ o }) => name(o.name) === name(row.reportedOperator));
    }
    if (!row.externalOperatorId && !row.reportedOperator) {
      const ranked = eligible.map((x) => ({ ...x, score: bestRouteMatches(row.route, x.o.routes).score })).filter((x) => x.score > 0);
      const best = Math.max(0, ...ranked.map((x) => x.score));
      matches = ranked.filter((x) => x.score === best);
    }
    if (correction?.assignment) matches = eligible.filter(({ p, o }) => String(p._id) === correction.assignment.providerId && o.id === correction.assignment.operatorId);
    const match = matches.length === 1 ? matches[0] : null;
    const conflict = Boolean(correction && correction.baseline !== row.fingerprint);
    return {
      ...row, original: { trips: row.trips, serviceHours: row.serviceHours },
      ...correction?.values,
      metricIssues: ['serviceHours', 'revenueHours'].filter((field) => unusableHour(correction?.values?.[field] ?? row[field])),
      providerId: match ? String(match.p._id) : null, providerName: match?.p.name || null,
      operatorId: match?.o.id || null, operatorName: match?.o.name || null,
      assignmentIssue: row.missingFromSource && conflict ? 'Corrected record is no longer in Compass' : match ? null : matches.length > 1 ? 'Ambiguous operator assignment' : 'No dated operator assignment',
      correction: correction || null, conflict,
    };
  });
  return results.sort((a, b) => `${a.date}|${a.route}|${a.rowKey}`.localeCompare(`${b.date}|${b.route}|${b.rowKey}`, undefined, { numeric: true }));
}

// File rows are route/day aggregates. Never copy their supplemental hours or
// miles onto each driver when Compass splits that route between operators.
export function mergeCompassRows(fallbackRows, compassRows) {
  const keyOf = (r) => `${r.date}|${routeKey(r.route)}`;
  const groups = new Map();
  for (const row of compassRows.filter((r) => !r.missingFromSource || r.correction?.baseline === 'MISSING')) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const fallback = new Map(fallbackRows.map((r) => [keyOf(r), r.toObject ? r.toObject({ getters: true }) : r]));
  const output = fallbackRows.filter((r) => !r.compassDerived && !groups.has(keyOf(r)));
  for (const [key, items] of groups) {
    const byOwner = new Map();
    for (const item of items) {
      const owner = item.operatorId ? `${item.providerId}|${item.operatorId}` : item.rowKey;
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner).push(item);
    }
    for (const owned of byOwner.values()) {
      const base = byOwner.size === 1 ? fallback.get(key) : null;
      const first = owned[0];
      const aggregate = (field) => owned.every((r) => field === 'trips' || !unusableHour(r[field]))
        ? sum(owned.map((r) => r[field])).toString()
        : !base?.compassDerived && !unusableHour(base?.[field]) ? base[field] : null;
      output.push({
        ...(base || {}), date: first.date, route: first.route,
        providerId: first.providerId, operatorId: first.operatorId, compass: true,
        trips: aggregate('trips'), serviceHours: aggregate('serviceHours'), revenueHours: aggregate('revenueHours'),
        totalHours: base?.totalHours ?? null, serviceMiles: base?.serviceMiles ?? null, otherHours: base?.otherHours || {},
        sourceRowKeys: owned.map((r) => r.rowKey), correctionConflict: owned.some((r) => r.conflict),
        supplementalAmbiguous: byOwner.size > 1 && Boolean(fallback.get(key)),
      });
    }
  }
  return output;
}
