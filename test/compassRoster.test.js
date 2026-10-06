import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeCompassSnapshot, compassDivisionNumber, normalizeCompassSnapshot } from '../src/services/compassRosterService.js';

test('Compass division codes map to VDP division numbers', () => {
  assert.equal(compassDivisionNumber('DIV_10'), '10');
  assert.equal(compassDivisionNumber('DIV-3GL'), '3GL');
  assert.equal(compassDivisionNumber('6'), '6');
});

test('Compass operators are grouped by provider and division with active run-cut routes', () => {
  const normalized = normalizeCompassSnapshot({
    retrievedAt: new Date('2026-10-06T12:00:00Z'),
    divisions: [{ _id: 'd10', code: 'DIV_10', name: 'Portland', timezone: 'America/Los_Angeles', active: true, type: 'standard' }],
    providers: [{ _id: 'p1', name: 'Example Transit LLC', active: true }],
    operators: [
      { _id: 'o1', employeeId: '100', name: 'One Driver', active: true, division: { _id: 'd10' }, provider: { _id: 'p1' } },
      { _id: 'o2', employeeId: '101', name: 'Two Driver', active: false, division: { _id: 'd10' }, provider: { _id: 'p1' } },
    ],
    runCuts: [
      { status: 'active', operator: { _id: 'o1' }, route: { code: '918' }, vehicle: { code: 'V1' } },
      { status: 'active', operator: { _id: 'o1' }, route: { code: '919' }, vehicle: { code: 'V1' } },
      { status: 'unassigned', operator: null, route: { code: '920' }, vehicle: null },
    ],
  });
  assert.equal(normalized.divisions[0].divisionNumber, '10');
  assert.equal(normalized.divisions[0].providers.length, 1);
  assert.deepEqual(normalized.divisions[0].providers[0].operators[0].routes, ['918', '919']);
  assert.equal(normalized.divisions[0].providers[0].operators[0].vehicleUnit, 'V1');
  assert.equal(normalized.unassignedRunCuts, 1);
});

test('providers without operators remain a reported data-quality gap', () => {
  const normalized = normalizeCompassSnapshot({
    retrievedAt: new Date(), divisions: [], operators: [], runCuts: [],
    providers: [{ _id: 'p1', name: 'Unassigned Provider', active: true }],
  });
  assert.equal(normalized.providersWithoutOperators, 1);
  assert.equal(normalized.providerDivisionRecords, 0);
});

test('an incomplete Compass snapshot is rejected before roster writes', () => {
  const normalized = normalizeCompassSnapshot({
    retrievedAt: new Date(),
    divisions: [{ _id: 'd10', code: 'DIV_10', name: 'Portland', active: true }],
    providers: [], operators: [], runCuts: [],
  });
  assert.throws(
    () => assertSafeCompassSnapshot(normalized),
    (error) => error.status === 400 && error.details?.code === 'COMPASS_INCOMPLETE_ROSTER',
  );
});
