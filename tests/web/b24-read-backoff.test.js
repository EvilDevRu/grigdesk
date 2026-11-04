import { setPerformanceSurface } from '../../web/src/shared/performanceContext.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { api, isReportedApiError, setApiLogSink } from '../../web/src/shared/apiClient.ts';
import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { useBoardStore } from '../../web/src/stores/board.ts';

/**
 * Продолжения fetch и очереди успевают пройти между шагами управляемых часов.
 * Нативный immediate не зависит от подменённых таймеров повторных попыток.
 */
async function flush() {
  await setImmediate();
  await setImmediate();
}

/**
 * Фикстура собирает реальные попытки и события общего API, не обращаясь к порталу.
 * Часы позволяют проверить минутное окно без настоящего ожидания и выхода в сеть.
 */
function fixture(t, fetch) {
  const calls = [];
  const events = [];
  const completions = [];

  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    calls.push({
      path,
      at: Date.now(),
      options,
    });

    return fetch(path, options);
  });
  setApiLogSink((event, data) => {
    const row = {
      event,
      data,
      at: Date.now()
    };

    (event === 'api.complete' ? completions : events).push(row);
  });
  t.after(() => setApiLogSink(null));

  return {
    calls,
    events,
    completions
  };
}

test('Б24: общий backoff task/:id растёт до минуты, журнал не зависит от ms и query', async (t) => {
  const { calls, events, completions } = fixture(t, () => {
    return new Response('<h1>Bad gateway</h1>', { status: 502 });
  });
  const read = (id) => api.get(`/api/tracker/task/${id}?refresh=${id}`, {
    retry: false,
    timeoutMs: 0,
  }).catch((error) => error);

  assert.equal((await read(1)).status, 502);

  for (const [index, pause] of [2000, 4000, 8000, 16000, 32000, 60000, 60000].entries()) {
    const request = read(index + 2);

    await flush();
    assert.equal(calls.length, index + 1);
    t.mock.timers.tick(pause - 1);
    await flush();
    assert.equal(calls.length, index + 1);
    t.mock.timers.tick(1);

    const error = await request;

    assert.equal(error.status, 502);
    assert.equal(isReportedApiError(error), true);
  }

  assert.deepEqual(calls.map((call) => call.at - calls[0].at), [0, 2000, 6000, 14000,
    30000, 62000, 122000, 182000]);
  assert.equal(events.length, 4);

  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].at - events[index - 1].at >= 60_000);
  }

  // Другой маршрут получает собственную попытку, несмотря на паузу карточек.
  await assert.rejects(api.get('/api/tracker/dashboard', { retry: false, timeoutMs: 0 }), { status: 502 });
  assert.equal(calls.length, 9);
  assert.equal(completions.length, 9);
  assert.ok(completions.every((row) => row.data.outcome === 'error'));
  assert.equal(events.length, 5);
});

test('Б24: встроенный повтор 502 отменяется во время общей паузы', async (t) => {
  const { calls, events } = fixture(t, () => new Response('{}', { status: 502 }));
  const consumer = new AbortController();
  const request = api.get('/api/tracker/cancel-fixture', {
    signal: consumer.signal,
    timeoutMs: 0,
  }).catch((error) => error);

  await flush();
  assert.equal(calls.length, 1);
  assert.equal(events[0].data.willRetry, true);
  t.mock.timers.tick(1999);
  await flush();
  consumer.abort();
  assert.equal((await request).name, 'AbortError');
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(events.length, 1);
});

test('Б24: сетевой отказ, очередь потребителей и успех разделяют одну паузу', async (t) => {
  let available = false;
  const { calls, events } = fixture(t, () => {
    if (!available) {
      throw new TypeError('Сеть недоступна');
    }

    return new Response('{"ok":true}');
  });
  const route = '/api/tracker/network-fixture';

  await assert.rejects(api.get(route, { retry: false, timeoutMs: 0 }), TypeError);

  const abandoned = new AbortController();
  const cancelled = api.get(route, { signal: abandoned.signal }).catch((error) => error);
  const next = api.get(`${route}?other=1`, { timeoutMs: 0 });

  await flush();
  abandoned.abort();
  assert.equal((await cancelled).name, 'AbortError');
  available = true;
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await next, { ok: true });
  assert.deepEqual(await api.get(route, { timeoutMs: 0 }), { ok: true });
  assert.equal(calls.length, 3);
  assert.equal(events.length, 1);
});

test('остановка доски отменяет активный fetch и не сохраняет поздний снимок', async (t) => {
  setActivePinia(createPinia());

  const board = useBoardStore();
  let signal;
  let finish;

  t.mock.method(api, 'get', (_path, options) => {
    signal = options.signal;
    assert.equal(options.retry, false);

    return new Promise((resolve) => {
      finish = resolve;
    });
  });

  const reading = board.load();

  board.stopPolling();
  assert.equal(signal.aborted, true);
  finish({ tasks: [] });
  await reading;
  assert.equal(board.data, null);
  assert.equal(board.error, null);
  assert.equal(board.loading, false);
});

test('surface логического вызова сохраняется через реальную очередь/backoff', async (t) => {
  let online = false;
  const f = fixture(t, () => online ? Response.json({ ok: true })
    : new Response('{}', { status: 502 }));

  setPerformanceSurface(7);
  t.after(() => setPerformanceSurface());
  await assert.rejects(api.get('/api/tracker/context-surface?read=seed', {
    retry: false, timeoutMs: 0,
  }));

  const waiting = api.get('/api/tracker/context-surface?read=next', { retry: false, timeoutMs: 0 });

  await flush();
  assert.equal(f.calls.length, 1);
  setPerformanceSurface(8);
  online = true;
  t.mock.timers.tick(2000);
  await waiting;

  const complete = f.completions.at(-1);

  assert.equal(complete.data.surface, 7);
  assert.equal(complete.data.outcome, 'success');
});
