import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../../web/src/shared/apiClient.ts';
import { drain, loadClock } from './helpers/chat-load.js';

test('GET-DEFAULT-01', async (t) => {
  const clock = loadClock(t);
  const signals = [];

  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));

  const outcome = api.get('/api/ordinary').catch((error) => error);

  await clock.tick(29999);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  await clock.tick(1);
  assert.equal(signals[0].aborted, true);
  await clock.tick(699);
  assert.equal(signals.length, 1);
  await clock.tick(1);
  assert.equal(signals.length, 2);
  await clock.tick(30000);
  assert.equal((await outcome).name, 'TimeoutError');
  await clock.tick(60000);
  assert.equal(signals.length, 2);
});

test('GET-DEFAULT-02', async (t) => {
  for (const status of [503, 401]) {
    await t.test(`HTTP ${status}`, async (sub) => {
      const notices = [];
      const stop = api.onUnauthorized((data) => notices.push(data));
      let count = 0;

      sub.after(stop);
      sub.mock.method(globalThis, 'fetch', async () => {
        count += 1;

        return new Response('{"error":"fixture"}', { status });
      });
      await assert.rejects(api.get('/api/ordinary'), { status });
      assert.equal(count, 1);
      assert.deepEqual(notices, status === 401 ? [{ error: 'fixture' }] : []);
    });
  }

  await t.test('мутации не повторяются', async (sub) => {
    const clock = loadClock(sub);
    let count = 0;

    sub.mock.method(globalThis, 'fetch', async () => {
      count += 1;

      throw new TypeError('Сеть недоступна');
    });

    for (const run of [() => api.put('/api/ordinary', {}), () => api.post('/api/ordinary', {}),
      () => api.del('/api/ordinary')]) {
      await assert.rejects(run(), TypeError);
    }

    await clock.tick(60000);
    assert.equal(count, 3);
  });

  await t.test('отмена потребителя сильнее deadline', async (sub) => {
    const clock = loadClock(sub);
    const consumer = new AbortController();
    const reason = new DOMException('Ушли со страницы', 'AbortError');
    let count = 0;

    sub.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
      count += 1;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

    const outcome = api.get('/api/ordinary', { signal: consumer.signal }).catch((error) => error);

    consumer.abort(reason);
    assert.equal(await outcome, reason);
    await clock.tick(60000);
    await drain();
    assert.equal(count, 1);
  });
});
