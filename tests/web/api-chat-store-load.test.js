import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../../web/src/shared/apiClient.ts';
import { drain, loadClock, streamFetch } from './helpers/chat-load.js';

const OPTIONS = { idleTimeoutMs: 30000, retry: false };

test('STORE-HTTP-01', async (t) => {
  const clock = loadClock(t);
  const requests = streamFetch(t);
  const expected = {
    sessions: [{
      id: 'c1',
      title: 'Я🦊',
      messages: [],
    }],
    archived: [],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(expected));
  const first = bytes.indexOf(0xd0) + 1;
  const second = bytes.indexOf(0xf0) + 2;
  const outcome = api.get('/api/chat/store', OPTIONS).catch((error) => error);

  requests[0].push(bytes.slice(0, first));
  await clock.tick(20000);
  requests[0].push(bytes.slice(first, second));
  await clock.tick(20000);
  requests[0].push(bytes.slice(second));
  await clock.tick(20000);
  requests[0].end();

  assert.deepEqual(await outcome, expected, 'живой поток дольше 30 с сохраняет UTF-8');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, false);
});

test('STORE-HTTP-02', async (t) => {
  await t.test('нет заголовков', async (sub) => {
    const clock = loadClock(sub);
    let signal;

    sub.mock.method(globalThis, 'fetch', (_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

    const outcome = api.get('/api/chat/store', OPTIONS).catch((error) => error);

    await clock.tick(29999);
    assert.equal(signal.aborted, false);
    await clock.tick(1);
    assert.equal((await outcome).name, 'TimeoutError');
  });

  for (const hasFirstByte of [false, true]) {
    await t.test(hasFirstByte ? 'тишина после части' : 'нет первого байта', async (sub) => {
      const clock = loadClock(sub);
      const requests = streamFetch(sub);
      const outcome = api.get('/api/chat/store', OPTIONS).catch((error) => error);

      await drain();

      if (hasFirstByte) {
        await clock.tick(10000);
        requests[0].push(new TextEncoder().encode('{'));
        await drain();
      }

      await clock.tick(20000);
      requests[0].push(new Uint8Array());
      await clock.tick(9999);
      assert.equal(requests[0].signal.aborted, false, 'предел считается от последнего байта');
      await clock.tick(1);
      assert.equal((await outcome).name, 'TimeoutError');
      assert.equal(requests.length, 1, 'opt-in GET не повторяется внутри apiClient');
    });
  }
});

test('STORE-HTTP-03', async (t) => {
  await t.test('отмена потребителя прекращает body', async (sub) => {
    const clock = loadClock(sub);
    const requests = streamFetch(sub);
    const controller = new AbortController();
    const reason = new DOMException('Закрыли экран', 'AbortError');
    const outcome = api.get('/api/chat/store', { ...OPTIONS, signal: controller.signal })
      .catch((error) => error);

    await drain();
    controller.abort(reason);
    assert.equal(await outcome, reason);
    assert.equal(requests[0].signal.aborted, true);
    await clock.tick(60000);
    assert.equal(requests.length, 1);
    assert.equal(clock.pending(), 0);
  });

  for (const body of ['{}', '{broken']) {
    await t.test(body, async (sub) => {
      const clock = loadClock(sub);
      const requests = streamFetch(sub);
      const outcome = api.get('/api/chat/store', OPTIONS).catch((error) => error);

      requests[0].push(new TextEncoder().encode(body));
      requests[0].end();
      await outcome;
      assert.equal(clock.pending(), 0, 'EOF/ошибка разбора снимает watchdog');
      await clock.tick(60000);
      assert.equal(requests[0].signal.aborted, false);
    });
  }
});

test('STORE-HTTP-04', async (t) => {
  for (const status of [503, 401]) {
    await t.test(`HTTP ${status}`, async (sub) => {
      const notices = [];
      const stop = api.onUnauthorized((data) => notices.push(data));
      let count = 0;

      sub.after(stop);
      sub.mock.method(globalThis, 'fetch', async () => {
        count += 1;

        return new Response(status === 503 ? '<html>Unavailable</html>' : '{"error":"unauthorized"}',
          { status });
      });
      await assert.rejects(api.get('/api/chat/store', OPTIONS), { name: 'ApiError', status });
      assert.equal(count, 1);
      assert.equal(notices.length, status === 401 ? 1 : 0);
    });
  }
});

test('STORE-HTTP-05: read POST измеряет тишину, а не общую длительность', async (t) => {
  for (const idle of [false, true]) {
    await t.test(idle ? '30 секунд тишины' : 'живой поток дольше 30 секунд', async (sub) => {

      const clock = loadClock(sub);

      const requests = streamFetch(sub);

      const result = api.post('/api/chat/store/changes', { known: {} }, OPTIONS)
        .catch((error) => error);

      sub.after(() => requests[0]?.end());
      await drain();
      assert.ok(requests[0].signal, 'read POST с idleTimeoutMs создаёт watchdog и сигнал отмены');
      requests[0].push(new TextEncoder().encode('{"sessions":'));
      await clock.tick(20000);

      if (idle) {
        await clock.tick(10000);
        assert.equal(requests[0].signal.aborted, true);
        assert.equal((await result).name, 'TimeoutError');
      } else {
        requests[0].push(new TextEncoder().encode('[],"archived":[]'));
        await clock.tick(20000);
        requests[0].push(new TextEncoder().encode(',"gone":[]}'));
        requests[0].end();
        assert.deepEqual(await result, {
          sessions: [],
          archived: [],
          gone: [],
        });
        assert.equal(requests[0].signal.aborted, false);
      }

      assert.equal(requests.length, 1, 'read POST не повторяется автоматически');
      assert.equal(clock.pending(), 0);
    });
  }
});
