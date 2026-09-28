import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bestRouteMatches, routeKey, routeMatchScore } from '../src/services/routeMatching.js';
import { matchRoutes } from '../src/services/performanceService.js';

const provider = (id, name, routes, operators = []) => ({ _id: id, name, routes, operators, status: 'ACTIVE' });
const report = (...routes) => ({
  rows: routes.map((route, i) => ({ route, date: `2026-09-${String(i + 1).padStart(2, '0')}` })),
  routeResolutions: [],
});

describe('smart route identifiers', () => {
  test('normalizes case, spaces and punctuation', () => {
    assert.equal(routeKey(' Stby-2 '), 'STBY2');
    assert.equal(routeMatchScore('1037 A', '1037-A'), 3);
    assert.equal(routeMatchScore('stby 2', 'STBY-2'), 3);
  });

  test('allows a missing or different trailing letter without changing the route number', () => {
    assert.equal(routeMatchScore('1033X', '1033'), 2);
    assert.equal(routeMatchScore('1033', '1033X'), 2);
    assert.equal(routeMatchScore('1033X', '1033A'), 1);
    assert.equal(routeMatchScore('1033', '1034'), 0);
  });

  test('keeps only the strongest configured matches', () => {
    assert.deepEqual(bestRouteMatches('1033X', ['1033', '1033 X', '1033A']), {
      score: 3,
      matchType: 'NORMALIZED',
      routes: ['1033 X'],
    });
  });
});

describe('performance report route matching', () => {
  test('matches a report suffix to a unique base route on the provider profile', () => {
    const [match] = matchRoutes(report('1033X'), [provider('p1', 'XYZ LLC', ['1033'])]);
    assert.equal(match.status, 'MATCHED');
    assert.equal(match.providerName, 'XYZ LLC');
    assert.equal(match.matchType, 'BASE_ROUTE');
    assert.deepEqual(match.profileRoutes, ['1033']);
  });

  test('an exact normalized route wins over a base-route fallback', () => {
    const [match] = matchRoutes(report('1033 X'), [
      provider('p1', 'Base LLC', ['1033']),
      provider('p2', 'Exact LLC', ['1033X']),
    ]);
    assert.equal(match.status, 'MATCHED');
    assert.equal(match.providerName, 'Exact LLC');
  });

  test('does not guess when a bare route could mean two lettered routes', () => {
    const [match] = matchRoutes(report('1029'), [
      provider('p1', 'Route A LLC', ['1029A']),
      provider('p2', 'Route B LLC', ['1029B']),
    ]);
    assert.equal(match.status, 'AMBIGUOUS');
    assert.deepEqual(match.candidates.map((candidate) => candidate.name), ['Route A LLC', 'Route B LLC']);
  });

  test('does not fuzzy-match different route numbers', () => {
    const [match] = matchRoutes(report('1022'), [provider('p1', 'Other LLC', ['1021'])]);
    assert.equal(match.status, 'UNKNOWN');
  });

  test('matches a different letter only when that route number has one best owner', () => {
    const [match] = matchRoutes(report('1029A'), [provider('p1', 'Only Owner LLC', ['1029B'])]);
    assert.equal(match.status, 'MATCHED');
    assert.equal(match.providerName, 'Only Owner LLC');
    assert.equal(match.matchType, 'ROUTE_NUMBER');
  });

  test('uses smart matching when an operator transfer splits a route by date', () => {
    const importDoc = {
      rows: [
        { route: '1033 X', date: '2026-09-01' },
        { route: '1033 X', date: '2026-09-02' },
      ],
      routeResolutions: [],
    };
    const oldOwner = provider('p1', 'Old Owner LLC', ['1033'], [{
      _id: 'o1', name: 'Old Operator', routes: ['1033'], status: 'ACTIVE', endDate: '2026-09-01',
    }]);
    const newOwner = provider('p2', 'New Owner LLC', ['1033'], [{
      _id: 'o2', name: 'New Operator', routes: ['1033'], status: 'ACTIVE', startDate: '2026-09-02',
    }]);
    const [match] = matchRoutes(importDoc, [oldOwner, newOwner]);
    assert.equal(match.status, 'MATCHED');
    assert.deepEqual(match.split.map((part) => [part.providerName, part.from, part.to]), [
      ['Old Owner LLC', '2026-09-01', '2026-09-01'],
      ['New Owner LLC', '2026-09-02', '2026-09-02'],
    ]);
  });

  test('keeps a manual route decision when a corrected report only changes formatting', () => {
    const importDoc = report('1037 A');
    importDoc.routeResolutions = [{ route: '1037-A', action: 'IGNORE' }];
    const [match] = matchRoutes(importDoc, []);
    assert.equal(match.status, 'IGNORED');
  });
});
