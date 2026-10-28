import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyGlmModelError } from '../../server/src/lib/glm/modelErrors.ts';

test('1113 показывает причину и HTTP-код без тела, ключей и личных данных провайдера', () => {
  const error = classifyGlmModelError({
    code: 'QUOTA',
    message: '429 {"error":{"code":"1113","message":"secret-key person@example.test /private/fixture"}}',
  });

  assert.equal(error.code, 'glm_quota_exhausted');
  assert.match(error.message, /HTTP 429, код 1113/u);
  assert.match(error.message, /недостаточно средств или отсутствует пакет ресурсов/u);
  assert.match(error.message, /не подтверждает исчерпание подписки/u);
  assert.doesNotMatch(error.message, /secret-key|person@|\/private\/fixture/u);
});

test('номер 1113 и HTTP-статус не выдумываются по одному тексту о балансе', () => {
  const generic = classifyGlmModelError({ code: 'QUOTA', message: 'Insufficient balance' });

  assert.equal(generic.code, 'glm_quota_exhausted');
  assert.doesNotMatch(generic.message, /1113|HTTP/u);
  assert.match(generic.message, /ограничении квоты, баланса или пакета/u);

  const english = classifyGlmModelError({
    code: 'QUOTA', message: '{"code":1113,"message":"hidden"}',
  }, 'en');

  assert.match(english.message, /Z.ai \(code 1113\)/u);
  assert.doesNotMatch(english.message, /HTTP|hidden/u);
});

test('AUTH сохраняет публичный код, а транзиентные сбои остаются общему runner-у', () => {
  const auth = classifyGlmModelError({ code: 'AUTH', message: 'secret-key' });

  assert.equal(auth.code, 'glm_auth_failed');
  assert.doesNotMatch(auth.message, /secret-key/u);

  for (const code of ['RATE_LIMIT', 'TRANSPORT', 'SERVER', 'TIMEOUT', 'PI_AI_ERROR', '']) {
    assert.equal(classifyGlmModelError({ code, message: '{"code":"1113"}' }), null);
  }
});
