import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { nameSimilarity, normalizeName, suggestOperator } from '../src/services/uberDriverMatching.js';

const candidate = (operatorName, providerName = `${operatorName} LLC`, id = operatorName) => ({
  providerId: `provider-${id}`,
  providerName,
  operatorId: `operator-${id}`,
  operatorName,
});

describe('Uber smart driver matching', () => {
  test('normalizes punctuation, case and accents', () => {
    assert.equal(normalizeName('  MARÍA O\'Neil  '), 'maria o neil');
  });

  test('suggests one exact operator name without treating the upload as master data', () => {
    const result = suggestOperator('MARY WITT', [candidate('Mary Witt'), candidate('Lisa Moore')]);
    assert.equal(result.suggestion.operatorName, 'Mary Witt');
    assert.equal(result.suggestion.confidence, 1);
  });

  test('matches reversed name order', () => {
    assert.equal(nameSimilarity('Mary Witt', 'Witt, Mary'), 0.99);
  });

  test('does not suggest when two operators are too close to distinguish safely', () => {
    const result = suggestOperator('Alex Smith', [candidate('Alex Smith', 'North LLC', 'north'), candidate('Alex Smith', 'South LLC', 'south')]);
    assert.equal(result.suggestion, null);
    assert.equal(result.candidates.length, 2);
  });

  test('can use a provider legal name when an operator spelling differs', () => {
    const result = suggestOperator('Mary Witt', [candidate('M. Witt', 'Mary Witt Transportation LLC')]);
    assert.equal(result.suggestion.providerName, 'Mary Witt Transportation LLC');
  });
});
