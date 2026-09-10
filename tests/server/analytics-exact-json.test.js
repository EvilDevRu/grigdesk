// Проверяет строгий разбор JSON и точное преобразование числовых лексем.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnalyticsExactJsonError,
  decimalFromJsonNumber,
  exactJsonNumber,
  exactUnsignedInteger,
  parseExactJson,
} from '../../server/src/lib/analytics/exactJson.ts';

test('exact JSON сохраняет исходный numeric lexeme без IEEE-754', () => {
  const value = parseExactJson(
    '{"cost":2.9725482000000008,"small":3.701e-3,"big":9007199254740993}',
  );

  assert.equal(exactJsonNumber(value.cost), '2.9725482000000008');
  assert.equal(decimalFromJsonNumber(value.cost), '2.9725482000000008');
  assert.equal(decimalFromJsonNumber(value.small), '0.003701');
  assert.equal(exactUnsignedInteger(value.big), '9007199254740993');
});

test('decimal conversion канонизирует exponent, trailing zeros и exact zero', () => {
  for (const [raw, expected] of [
    ['0', '0'],
    ['0.000', '0'],
    ['1.2300', '1.23'],
    ['12e3', '12000'],
    ['1200e-3', '1.2'],
    ['1e-18', '0.000000000000000001'],
  ]) {
    assert.equal(decimalFromJsonNumber(parseExactJson(raw)), expected);
  }
  assert.throws(
    () => decimalFromJsonNumber(parseExactJson('-0')),
    /non-negative/i,
  );
  assert.throws(
    () => exactUnsignedInteger(parseExactJson('1.5')),
    /integer/i,
  );
});

test('exact JSON fail-closed отвергает duplicate keys, lone surrogates и garbage', () => {
  for (const raw of [
    '{"a":1,"a":2}',
    '"\\ud800"',
    '{"a":1} trailing',
    '[1,]',
    '01',
  ]) {
    assert.throws(() => parseExactJson(raw), AnalyticsExactJsonError);
  }
});

test('exact JSON применяет byte/depth/value/numeric bounds', () => {
  assert.throws(() => parseExactJson('"long"', { bytes: 4 }), /bytes/i);
  assert.throws(() => parseExactJson('[[[0]]]', { depth: 2 }), /depth/i);
  assert.throws(() => parseExactJson('[0,1,2]', { values: 3 }), /values/i);
  assert.throws(() => parseExactJson('1e9999'), /exponent/i);
});
