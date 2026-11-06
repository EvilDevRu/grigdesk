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

test('исчерпанные окна Z.ai распознаются даже с кодом Harness RATE_LIMIT', () => {
  for (const code of ['1308', '1310', '1316', '1317', '1318', '1319', '1320', '1321']) {
    for (const value of [code, Number(code)]) {
      const error = classifyGlmModelError({
        code: 'RATE_LIMIT',
        message: `429 ${JSON.stringify({ error: {
          code: value,
          message: 'secret-key person@example.test /private/fixture',
        } })}`,
      });

      assert.equal(error?.code, 'glm_quota_exhausted', `код Z.ai ${value}`);
      assert.ok(error.message.includes(`HTTP 429, код ${code}`));
      assert.match(error.message, /исчерпан лимит использования/iu);
      assert.match(error.message, /дождитесь сброса/iu);
      assert.doesNotMatch(error.message, /secret-key|person@|\/private\/fixture/u);
    }
  }
});

test('недельный лимит получает понятную причину на обоих языках', () => {
  const failure = {
    code: 'RATE_LIMIT',
    message: '429 {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted."}}',
  };
  const english = classifyGlmModelError(failure, 'en');

  assert.equal(english?.code, 'glm_quota_exhausted');
  assert.match(english.message, /HTTP 429, code 1310/u);
  assert.match(english.message, /usage limit.*exhausted/iu);
  assert.match(english.message, /wait.*reset/iu);
});

test('1113 с кодом Harness RATE_LIMIT сохраняет отдельное пояснение о балансе', () => {
  const error = classifyGlmModelError({
    code: 'RATE_LIMIT',
    message: '429 {"error":{"code":"1113","message":"hidden"}}',
  });

  assert.equal(error?.code, 'glm_quota_exhausted');
  assert.match(error.message, /код 1113/u);
  assert.match(error.message, /не подтверждает исчерпание подписки/u);
});

test('частота, перегрузка и упоминание числа в тексте не означают исчерпанную квоту', () => {
  for (const code of ['1302', '1305', 'unknown']) {
    assert.equal(classifyGlmModelError({
      code: 'RATE_LIMIT',
      message: `429 ${JSON.stringify({ error: { code, message: 'request 1310' } })}`,
    }), null);
  }

  assert.equal(classifyGlmModelError({ code: 'RATE_LIMIT', message: '429 request 1310' }), null);
});

test('AUTH сохраняет публичный код, а транзиентные сбои остаются общему runner-у', () => {
  const auth = classifyGlmModelError({ code: 'AUTH', message: 'secret-key' });

  assert.equal(auth.code, 'glm_auth_failed');
  assert.doesNotMatch(auth.message, /secret-key/u);
  assert.equal(classifyGlmModelError({
    code: 'AUTH',
    message: '{"error":{"code":"1310"}}',
  }).code, 'glm_auth_failed');

  for (const code of ['RATE_LIMIT', 'TRANSPORT', 'SERVER', 'TIMEOUT', 'PI_AI_ERROR', '']) {
    assert.equal(classifyGlmModelError({ code, message: '{"code":"1302"}' }), null);
  }
});
