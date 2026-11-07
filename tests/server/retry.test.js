import assert from 'node:assert/strict';
import test from 'node:test';

import { withRetry } from '../../server/src/lib/retry.ts';
import { kimiUsageIsRetryable } from '../../server/src/lib/kimi/usage.ts';

// Общий повтор заведён 22.08.2026 вместо трёх разъехавшихся копий: у одной было две
// попытки подряд БЕЗ паузы (обе попадали в одно моргание сети), у другой повтора не было
// вовсе, третья не различала «сеть моргнула» и «аккаунт отказал».

test('withRetry sleeps between attempts instead of firing them into one blink', async () => {
  const naps = [];
  let attempts = 0;
  const value = await withRetry(() => {
    attempts += 1;
    return attempts < 3 ? { error: 'сеть' } : { ok: true };
  }, {
    retryWhen: (r) => !!r.error,
    sleep: async (ms) => { naps.push(ms); },
  });

  assert.deepEqual(value, { ok: true });
  assert.equal(attempts, 3);
  assert.deepEqual(naps, [400, 1200], 'пауза нарастает, повтор не мгновенный');
});

test('withRetry stops at the first final answer and never sleeps after the last try', async () => {
  const naps = [];
  let attempts = 0;
  const refused = await withRetry(() => {
    attempts += 1;
    return { error: 'нужен login' };
  }, {
    retryWhen: () => false,
    sleep: async (ms) => { naps.push(ms); },
  });
  assert.equal(attempts, 1, 'окончательный ответ повторять нечем');
  assert.deepEqual(naps, [], 'и задерживать человека паузой не за чем');
  assert.deepEqual(refused, { error: 'нужен login' });

  // Исчерпав попытки, отдаём последний ответ — но лишней паузы в хвосте нет.
  const exhausted = [];
  const last = await withRetry(() => ({ error: 'всё ещё сеть' }), {
    retryWhen: () => true,
    sleep: async (ms) => { exhausted.push(ms); },
  });
  assert.deepEqual(last, { error: 'всё ещё сеть' });
  assert.equal(exhausted.length, 2, 'на три попытки ровно две паузы');
});

test('withRetry retries a thrown transport error and rethrows the last one', async () => {
  let attempts = 0;
  const recovered = await withRetry(() => {
    attempts += 1;
    if (attempts < 2) throw new TypeError('fetch failed');
    return 'ок';
  }, { sleep: async () => {} });
  assert.equal(recovered, 'ок');

  await assert.rejects(
    () => withRetry(() => { throw new Error('связи нет'); }, { sleep: async () => {} }),
    /связи нет/,
    'когда не сработала ни одна попытка, ошибка не проглатывается',
  );

  //Брошенное можно и не повторять — например когда это не транспорт.
  let once = 0;
  await assert.rejects(() => withRetry(() => { once += 1; throw new Error('плохой ввод'); }, {
    retryOnError: () => false,
    sleep: async () => { throw new Error('паузы быть не должно'); },
  }), /плохой ввод/);
  assert.equal(once, 1);
});

test('Kimi usage retries only what waiting can fix — its broker restart is expensive', () => {
  // Брокер поднялся, споткнулся сам запрос: второй старт, скорее всего, тоже пройдёт.
  assert.equal(kimiUsageIsRetryable({ reason: 'request_failed' }), true);
  assert.equal(kimiUsageIsRetryable({ reason: 'response_rejected', status: 503 }), true);
  assert.equal(kimiUsageIsRetryable({ result: { kind: 'error', status: 502 } }), true);

  // 30 секунд уже потрачены — вторая попытка потратит столько же на пустую шапку.
  assert.equal(kimiUsageIsRetryable({ reason: 'startup_timeout' }), false);
  // Локальная поломка, а не сеть.
  assert.equal(kimiUsageIsRetryable({ reason: 'spawn_failed' }), false);
  assert.equal(kimiUsageIsRetryable({ reason: 'workspace_prepare_failed' }), false);
  // Отказ аккаунта и ограничение снимут не через секунду.
  assert.equal(kimiUsageIsRetryable({ result: { kind: 'error', status: 401 } }), false);
  assert.equal(kimiUsageIsRetryable({ result: { kind: 'error', status: 429 } }), false);
  assert.equal(kimiUsageIsRetryable({ reason: 'response_rejected', status: 401 }), false);
  // Успех повторять нечего.
  assert.equal(kimiUsageIsRetryable({ result: { kind: 'ok' } }), false);
});
