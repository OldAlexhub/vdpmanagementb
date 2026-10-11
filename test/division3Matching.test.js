import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { matchDivision3Drivers } from '../src/services/division3ImportService.js';

const divisions = [
  { _id: 'division-3', divisionNumber: '3' },
  { _id: 'division-3gl', divisionNumber: '3GL' },
];

const provider = (id, divisionId, operatorName, operatorId = `${id}-operator`) => ({
  _id: id,
  divisionId,
  name: `${operatorName} Provider`,
  status: 'ACTIVE',
  operators: [{ _id: operatorId, name: operatorName, status: 'ACTIVE', routes: [] }],
});

const dutyImport = (rows) => ({
  kind: 'DIV3_GOLINK',
  originalFileName: 'duty.xlsx',
  division3DutyRows: rows.map(({ driverName, service }) => ({ driverName, service, date: '2026-09-08' })),
  division3FareRows: [],
  division3DriverMatches: [],
  division3DriverExclusions: [],
});

describe('Division 3 smart driver matching', () => {
  test('uses the source service to choose between duplicated DIV 3 and DIV 3GL rosters', () => {
    const providers = [
      provider('ada-provider', 'division-3', 'Adem Seid'),
      provider('golink-provider', 'division-3gl', 'Adem Seid'),
    ];
    const matches = matchDivision3Drivers(
      [dutyImport([
        { driverName: 'Adem Seid', service: 'ADA' },
        { driverName: 'Adem Seid', service: 'GOLINK' },
      ])],
      providers,
      null,
      divisions,
    );
    assert.equal(matches.length, 2);
    assert.equal(matches.every((match) => match.status === 'MATCHED'), true);
    assert.equal(matches.find((match) => match.service === 'ADA').providerId, 'ada-provider');
    assert.equal(matches.find((match) => match.service === 'GOLINK').providerId, 'golink-provider');
    assert.equal(matches.every((match) => match.matchMethod === 'AUTO_EXACT_NAME'), true);
  });

  test('safely matches omitted middle names and documented spelling aliases', () => {
    const providers = [
      provider('alison-provider', 'division-3gl', 'Alison Grace Greene'),
      provider('amelia-provider', 'division-3gl', 'Amelia Bailey'),
    ];
    const matches = matchDivision3Drivers([dutyImport([
      { driverName: 'Alison Greene', service: 'GOLINK' },
      { driverName: 'Ameila Bailey', service: 'GOLINK' },
    ])], providers, null, divisions);
    assert.deepEqual(matches.map((match) => match.status), ['MATCHED', 'MATCHED']);
    assert.equal(matches[0].operatorName, 'Alison Grace Greene');
    assert.equal(matches[0].matchMethod, 'AUTO_SMART_NAME');
    assert.equal(matches[1].operatorName, 'Amelia Bailey');
  });

  test('leaves a genuinely duplicated operator name for manual review', () => {
    const providers = [
      provider('north-provider', 'division-3gl', 'Alex Smith', 'north-alex'),
      provider('south-provider', 'division-3gl', 'Alex Smith', 'south-alex'),
    ];
    const [match] = matchDivision3Drivers(
      [dutyImport([{ driverName: 'Alex Smith', service: 'GOLINK' }])],
      providers,
      null,
      divisions,
    );
    assert.equal(match.status, 'UNMATCHED');
  });

  test('does not cross-match a driver when the relevant service roster is missing', () => {
    const [match] = matchDivision3Drivers(
      [dutyImport([{ driverName: 'Adem Seid', service: 'ADA' }])],
      [provider('golink-provider', 'division-3gl', 'Adem Seid')],
      null,
      divisions,
    );
    assert.equal(match.status, 'UNMATCHED');
  });

  test('keeps a cycle-specific set-aside driver out of automatic matching', () => {
    const uploaded = dutyImport([{ driverName: 'Adem Seid', service: 'GOLINK' }]);
    uploaded.division3DriverExclusions.push({
      sourceName: 'Adem Seid',
      service: 'GOLINK',
      reason: 'Set aside for this VDP cycle',
      excludedBy: { name: 'Accounting' },
      excludedAt: new Date('2026-09-21T12:00:00Z'),
    });
    const [match] = matchDivision3Drivers(
      [uploaded],
      [provider('golink-provider', 'division-3gl', 'Adem Seid')],
      null,
      divisions,
    );
    assert.equal(match.status, 'SET_ASIDE');
    assert.equal(match.operatorId, undefined);
    assert.equal(match.setAsideBy.name, 'Accounting');
  });
});
