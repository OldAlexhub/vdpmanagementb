import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCompassPerformance, matchCompassRows, mergeCompassRows, metricValue } from '../src/services/compassPerformanceData.js';
import { fetchCompassPerformance } from '../src/services/compassPerformanceService.js';
import { requestCompass } from '../src/services/compassClient.js';
import { compassFixture, fixtureRequest } from './fixtures/compassPerformance.js';

const options = { divisionId: 'local-6', externalDivisionId: 'external-6', from: '2026-09-01', to: '2026-09-01' };
const provider = { _id: 'p1', divisionId: 'local-6', name: 'Provider One', operators: [{ _id: 'o1', name: 'Driver One', routes: ['600'], source: { externalId: 'external-op-1' } }] };
const normalized = (config) => { const f = compassFixture(config); return normalizeCompassPerformance(f.entries, f.analysis, options); };

test('exact daily metrics retain split components without also adding parent totals', () => {
  const rows = normalized({ split: true });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.trips).sort(), ['4', '6']);
  assert.ok(rows.every((r) => r.serviceHours === '4'));
  assert.equal(new Set(rows.map((r) => r.rowKey)).size, 2);
});

test('mismatched totals, missing components, duplicates and filter violations are rejected', () => {
  for (const change of [
    (f) => { f.analysis.summary.serviceHours = 9; },
    (f) => { f.analysis.daily[0].trips = 11; },
    (f) => { f.entries[0].date = '2026-08-31'; },
    (f) => { f.entries[0].division = 'other'; },
    (f) => { f.analysis.records.push(f.analysis.records[0]); },
    (f) => { f.analysis.records[0].componentKey = 'missing'; },
    (f) => { f.entries[0].metrics.completedTrips = -1; },
  ]) {
    const f = compassFixture(); change(f);
    assert.throws(() => normalizeCompassPerformance(f.entries, f.analysis, options));
  }
  for (const value of [-1, 'NaN', '', null, Infinity, true]) assert.throws(() => metricValue(value, 'serviceHours'));
  assert.throws(() => metricValue('1.5', 'trips'));
});

test('operator IDs and dated transfers take priority over route matching', () => {
  const former = { ...provider, operators: [{ ...provider.operators[0], endDate: '2026-08-31' }] };
  const next = { ...provider, _id: 'p2', operators: [{ ...provider.operators[0], _id: 'o2', startDate: '2026-09-01' }] };
  assert.equal(matchCompassRows(normalized(), [former, next])[0].providerId, 'p2');
  assert.ok(matchCompassRows(normalized(), [provider, next])[0].assignmentIssue);
  const unmatched = normalized().map((row) => ({ ...row, externalOperatorId: 'unknown' }));
  assert.ok(matchCompassRows(unmatched, [provider])[0].assignmentIssue, 'a conflicting external identity is not reassigned by route');
});

test('corrections override metrics and changed or removed sources require review', () => {
  const rows = normalized();
  const correction = { rowKey: rows[0].rowKey, active: true, values: { serviceHours: '9' }, baseline: rows[0].fingerprint, sourceRow: rows[0] };
  const effective = matchCompassRows(rows, [provider], [correction]);
  assert.equal(effective[0].serviceHours, '9');
  assert.equal(effective[0].original.serviceHours, '8');
  assert.equal(effective[0].conflict, false);
  assert.equal(matchCompassRows(normalized({ hours: 10 }), [provider], [correction])[0].conflict, true);
  assert.equal(matchCompassRows([], [provider], [correction])[0].missingFromSource, true);
  const changedRoute = compassFixture();
  changedRoute.analysis.records[0].route = '601';
  assert.equal(matchCompassRows(normalizeCompassPerformance(changedRoute.entries, changedRoute.analysis, options), [provider], [correction])[0].conflict, true);
});

test('Compass replaces overlapping file metrics, preserving other metrics without multiplying them across drivers', () => {
  const uploaded = [{ date: '2026-09-01', route: '600', trips: '100', serviceHours: '100', totalHours: '12', serviceMiles: '80' }];
  const single = mergeCompassRows(uploaded, matchCompassRows(normalized(), [provider]));
  assert.equal(single.length, 1);
  assert.equal(single[0].trips, '10');
  assert.equal(single[0].serviceHours, '8');
  assert.equal(single[0].totalHours, '12');
  const formatted = mergeCompassRows(uploaded.map((row) => ({ ...row, route: '6-00' })), matchCompassRows(normalized(), [provider]));
  assert.equal(formatted.length, 1, 'formatting differences must not duplicate file and Compass totals');
  assert.equal(formatted[0].totalHours, '12');
  const second = { ...provider, _id: 'p2', operators: [{ ...provider.operators[0], _id: 'o2', source: { externalId: 'external-op-2' } }] };
  const split = mergeCompassRows(uploaded, matchCompassRows(normalized({ split: true }), [provider, second]));
  assert.equal(split.length, 2);
  assert.ok(split.every((r) => r.totalHours === null && r.serviceMiles === null && r.supplementalAmbiguous));
});

test('retrieval uses inclusive single-day/source filters and rejects limit-sized responses', async () => {
  const calls = [];
  const fixture = compassFixture({ dates: ['2026-09-01', '2026-09-02'] });
  const input = { divisions: [{ _id: 'local-6', source: { system: 'COMPASS', externalId: 'external-6' } }], from: '2026-09-01', to: '2026-09-02' };
  const request = async (name, query) => { calls.push({ name, query }); return fixtureRequest(fixture)(name, query); };
  assert.equal((await fetchCompassPerformance({ ...input, request })).rows.length, 2);
  assert.equal(calls.filter((c) => c.name === 'entries').length, 8);
  assert.ok(calls.every((c) => c.query.division === 'external-6'));
  assert.ok(calls.filter((c) => c.name === 'entries').every((c) => c.query.from === c.query.to));
  await assert.rejects(fetchCompassPerformance({ ...input, request: async (name) => name === 'performance' ? fixture.analysis : { entries: Array(2000).fill({}) } }), /2,000-entry limit/);
});

test('negative source hours reconcile but cannot become payable hours or hide in an aggregate', () => {
  const fixture = compassFixture({ split: true });
  fixture.entries[0].components[0].reportedRevenueHours = -1.48;
  fixture.entries[0].metrics.reportedRevenueHours = 1.52;
  fixture.analysis.summary.revenueHours = 1.52;
  fixture.analysis.daily[0].revenueHours = 1.52;
  const rows = matchCompassRows(normalizeCompassPerformance(fixture.entries, fixture.analysis, options), [provider]);
  assert.ok(rows.some((r) => r.metricIssues.includes('revenueHours')));
  assert.ok(mergeCompassRows([], rows).some((r) => r.revenueHours === null));
  assert.throws(() => metricValue(-1.48, 'serviceHours'), /nonnegative/);
});

test('materialized Compass data cannot reappear as uploaded fallback after refresh', () => {
  const materialized = [{ date: '2026-09-01', route: '600', trips: '10', serviceHours: '8', compassDerived: true }];
  assert.deepEqual(mergeCompassRows(materialized, []), []);
  const rows = matchCompassRows(normalized(), [provider]).map((r) => ({ ...r, serviceHours: null }));
  assert.equal(mergeCompassRows(materialized, rows)[0].serviceHours, null);
});

test('Compass HTTP client handles authentication, retries, and malformed responses without exposing credentials', async (t) => {
  const oldBase = process.env.COMPASS_BASE_URL, oldToken = process.env.COMPASS_API_TOKEN;
  process.env.COMPASS_BASE_URL = 'https://compass.example.test'; process.env.COMPASS_API_TOKEN = 'test-only';
  t.after(() => { if (oldBase === undefined) delete process.env.COMPASS_BASE_URL; else process.env.COMPASS_BASE_URL = oldBase; if (oldToken === undefined) delete process.env.COMPASS_API_TOKEN; else process.env.COMPASS_API_TOKEN = oldToken; });
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
  await assert.rejects(requestCompass('performance'), (e) => e.details.code === 'COMPASS_AUTH_FAILED' && !e.message.includes('test-only'));
  assert.equal(mock.mock.callCount(), 1);
  let attempt = 0;
  mock.mock.mockImplementation(async () => ++attempt === 1 ? new Response('{}', { status: 429 }) : new Response('{"entries":[]}'));
  assert.deepEqual(await requestCompass('entries'), { entries: [] });
  assert.equal(attempt, 2);
  mock.mock.mockImplementation(async () => new Response('not json'));
  await assert.rejects(requestCompass('entries'), /not valid JSON/);
});
