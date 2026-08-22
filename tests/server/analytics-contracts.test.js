// Проверяет канонизацию JSON, точную десятичную арифметику и идентичности контрактов аналитики.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnalyticsCanonicalError,
  canonicalJson,
  lifecycleEventHash,
  sha256Canonical,
} from '../../server/src/lib/analytics/canonical.js';
import {
  addDecimals,
  canonicalDecimal,
  multiplyDivideDecimal,
  roundDecimal,
} from '../../server/src/lib/analytics/decimal.js';
import {
  ANALYTICS_ENUMS,
  analyticsId,
  assertAnalyticsIdentity,
} from '../../server/src/lib/analytics/contracts.js';

test('RFC 8785 subset имеет общий UTF-16 порядок ключей и byte-stable hash', () => {
  const value = {
    '\uE000': 'bmp',
    '\u{1F600}': 'astral',
    'é': 'значение',
    a: [null, true, 2, 'x'],
  };
  const expected = '{"a":[null,true,2,"x"],"é":"значение","😀":"astral","":"bmp"}';
  assert.equal(canonicalJson(value), expected);
  assert.equal(
    sha256Canonical(value),
    'f37ffc341845cbfe9345df5ce828db30c4db9c0beef707a9884860605ee6826b',
  );
});

test('canonical JSON fail-closed отвергает числа и строки вне общего контракта', () => {
  for (const value of [1.25, Number.MAX_SAFE_INTEGER + 1, -0, NaN, Infinity]) {
    assert.throws(() => canonicalJson(value), AnalyticsCanonicalError);
  }
  assert.throws(() => canonicalJson('\ud800'), /surrogate/i);
  assert.throws(() => canonicalJson({ value: undefined }), /JSON-safe/i);
  assert.throws(() => canonicalJson(Object.create({ inherited: true })), /plain JSON object/i);
});

test('eventHash исключает только eventHash и не включает завершающий LF', () => {
  const event = {
    sequence: 1,
    previousEventHash: null,
    eventHash: 'ignored',
    a: 1,
  };
  assert.equal(
    lifecycleEventHash(event),
    '5218af582a599d12fcce5231f68a5004aeb906ce11e50c7daf0cbb294c8c3c73',
  );
  assert.notEqual(
    lifecycleEventHash(event),
    '06d957322606dc0a8f8446c4aaa846d6524bb3223f22548ca8b681ac1c0fb278',
  );
});

test('decimal arithmetic не проходит через IEEE-754 и округляет half-even', () => {
  assert.equal(
    addDecimals('0.003701', '2.9725482000000008'),
    '2.9762492000000008',
  );
  assert.equal(multiplyDivideDecimal('3', '0.005', '1', { scale: 2 }), '0.02');
  assert.equal(multiplyDivideDecimal('1', '0.005', '1', { scale: 2 }), '0');
  assert.equal(roundDecimal('2.345', 2), '2.34');
  assert.equal(roundDecimal('2.355', 2), '2.36');
  assert.equal(canonicalDecimal('0001'), null);
  assert.equal(canonicalDecimal('1.2300'), null);
  assert.equal(canonicalDecimal('0'), '0');
});

test('entity ids и reason enums едины для ledger/index/API', () => {
  assert.deepEqual(ANALYTICS_ENUMS.visitReason, [
    'initial',
    'forward_transition',
    'route_rewind',
    'gate_rejected',
    'human_rewind',
    'recovery',
  ]);
  assert.deepEqual(ANALYTICS_ENUMS.executionReason, [
    'initial', 'no_result', 'product_failure', 'manual_resume',
  ]);
  assert.deepEqual(ANALYTICS_ENUMS.runReason, [
    'primary', 'provider_failover', 'model_fallback', 'manual_switch',
  ]);

  assert.equal(assertAnalyticsIdentity('taskId', 't42'), 't42');
  assert.equal(
    assertAnalyticsIdentity('attemptId', 'a_0123456789abcdef0123456789abcdef'),
    'a_0123456789abcdef0123456789abcdef',
  );
  assert.throws(() => assertAnalyticsIdentity('taskId', '42'));

  const first = analyticsId('nodeVisitId', ['t42', 'a_0123456789abcdef0123456789abcdef', 7]);
  const second = analyticsId('nodeVisitId', ['t42', 'a_0123456789abcdef0123456789abcdef', 7]);
  assert.equal(first, second);
  assert.match(first, /^nv_[a-f0-9]{32}$/);
});
