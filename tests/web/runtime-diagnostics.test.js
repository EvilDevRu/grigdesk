import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';

import { api, setApiLogSink } from '../../web/src/shared/apiClient.ts';
import { resetApiDiagnostics } from '../../web/src/shared/apiDiagnostics.ts';
import { createWebLog } from '../../web/src/shared/webLog.ts';
import { compileModule, webFile } from './helpers/compile-vue.js';

/**
 * Настоящее ядро применяет проекцию и уровни к событиям всех новых наблюдателей.
 * Поддельные часы не требуют ожидания секунд и не меняют транспорт приложения.
 */
function fixture(t, level = 'verbose') {
  let clock = 0;
  const log = createWebLog({
    now: () => new Date(1_700_000_000_000 + clock),
    monotonicNow: () => clock,
    pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb',
    version: 'dev',
    context: () => ({
      route: '/chats',
      vis: 'visible',
      boot: null,
    }),
    level,
  });

  t.mock.method(performance, 'now', () => clock);
  setApiLogSink((event, data) => log.record(event, {
    ...data,
    path: '/api/providers',
  }), () => log.level() === 'verbose');
  t.after(() => setApiLogSink(null));

  return { log, at: (value) => clock = value };
}

test('обычный и потоковый JSON разделяют заголовки, тело, серверное время и refresh', async (t) => {
  const f = fixture(t);

  t.mock.method(globalThis, 'fetch', async () => {
    f.at(1100);

    const response = new Response('{}', { headers: { 'Server-Timing': 'grigdesk;dur=900.5' } });

    response.text = async () => {
      f.at(1400);

      return '{"private":"secret"}';
    };

    return response;
  });

  for (const options of [{}, { idleTimeoutMs: 30_000 }]) {
    f.at(0);

    // Потоковый reader использует настоящее тело; часы тела меняются только в text().
    // В обоих путях серверный ответ и признаки запроса остаются прежними.
    assert.deepEqual(await api.get('/api/providers?refresh=1&token=secret', options),
      options.idleTimeoutMs ? {} : { private: 'secret' });

    const event = f.log.snapshot().entries.filter((entry) => entry.ev === 'api.slow').at(-1);

    assert.equal(event.data.headersMs, 1100);
    assert.equal(event.data.bodyMs, options.idleTimeoutMs ? 0 : 300);
    assert.equal(event.data.parseMs, 0);
    assert.equal(event.data.serverMs, 900.5);
    assert.equal(event.data.refresh, true);
    assert.equal(event.data.phase, 'done');
  }

  assert.doesNotMatch(JSON.stringify(f.log.snapshot()), /secret|token|private/u);
});

test('незавершённая попытка оставляет одну отметку и убирает таймер при завершении', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const f = fixture(t);
  let complete;

  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => complete = resolve));

  const pending = api.post('/api/providers', {});

  f.at(3000);
  t.mock.timers.tick(3000);
  f.at(9000);
  t.mock.timers.tick(6000);

  const entries = f.log.snapshot().entries.filter((entry) => entry.ev === 'api.pending');

  assert.equal(entries.length, 1);
  assert.equal(entries[0].data.phase, 'headers');
  complete(new Response('{}'));
  await pending;
  t.mock.timers.tick(30_000);

  const slow = f.log.snapshot().entries.find((entry) => entry.ev === 'api.slow');

  assert.equal(slow.data.request, entries[0].data.request);
  assert.equal(f.log.snapshot().entries.filter((entry) => entry.ev === 'api.pending').length, 1);
});

test('отмена во время чтения тела снимает отметку ожидания', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const f = fixture(t);
  const cancel = new AbortController();
  let abortBody;

  t.mock.method(globalThis, 'fetch', async () => ({
    status: 200,
    ok: true,
    headers: new Headers(),
    text: () => new Promise((_resolve, reject) => {
      abortBody = () => reject(cancel.signal.reason);
      cancel.signal.addEventListener('abort', abortBody, { once: true });
    }),
  }));

  const pending = api.get('/api/providers', { signal: cancel.signal, timeoutMs: 0 });

  await Promise.resolve();
  await Promise.resolve();
  f.at(3000);
  t.mock.timers.tick(3000);
  assert.equal(f.log.snapshot().entries.find((entry) => entry.ev === 'api.pending').data.phase, 'body');
  cancel.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  cancel.signal.removeEventListener('abort', abortBody);
  f.log.clear();
  t.mock.timers.tick(30_000);
  assert.equal(f.log.snapshot().entries.length, 0);
});

test('повторное включение диагностики не возрождает таймер и подробности прежнего запроса', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const f = fixture(t);
  const stop = f.log.subscribeLevel(resetApiDiagnostics);
  let complete;

  t.after(stop);
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => complete = resolve));

  const pending = api.post('/api/providers');

  f.log.setLevel('off');
  f.log.setLevel('verbose');
  f.at(5000);
  t.mock.timers.tick(5000);
  assert.equal(f.log.snapshot().entries.length, 0);
  complete(new Response('{}'));
  await pending;

  const slow = f.log.snapshot().entries.find((entry) => entry.ev === 'api.slow');

  assert.equal(slow.data.request, undefined);
  assert.equal(slow.data.headersMs, undefined);
});

test('ошибка JSON называет этап и не раскрывает ответ, отключение не оставляет отметок', async (t) => {
  const f = fixture(t);

  t.mock.method(globalThis, 'fetch', async () => new Response('secret-invalid-json'));
  await assert.rejects(api.get('/api/providers'), SyntaxError);

  const failure = f.log.snapshot().entries.find((entry) => entry.ev === 'api.fail');

  assert.equal(failure.data.phase, 'parse');
  assert.equal(failure.data.name, 'SyntaxError');
  assert.doesNotMatch(JSON.stringify(f.log.snapshot()), /secret-invalid-json/u);
  f.log.setLevel('off');
  await assert.rejects(api.get('/api/providers'), SyntaxError);
  assert.equal(f.log.snapshot().entries.length, 0);
});

test('ограничение сетевых отказов Б24 не скрывает неправильный JSON', async (t) => {
  const f = fixture(t);

  t.mock.method(globalThis, 'fetch', async () => new Response('private-invalid-json'));

  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(api.get('/api/tracker/task/private-id', { retry: false }), SyntaxError);
  }

  const failures = f.log.snapshot().entries.filter((entry) => entry.ev === 'api.fail');

  assert.equal(failures.length, 2);
  assert.ok(failures.every((entry) => entry.data.name === 'SyntaxError'));
  assert.doesNotMatch(JSON.stringify(f.log.snapshot()), /private-/u);
});

test('реестр пишет причины, объединение, поздние ответы и опустошение без данных моделей', async (t) => {
  const module = await compileModule(webFile('../tests/web/helpers/runtimeDiagnosticsEntry.ts'));
  const f = fixture(t);
  const replies = [];

  setActivePinia(createPinia());
  module.setWebDiagnosticSink((event, data) => f.log.record(event, data));
  t.after(() => module.setWebDiagnosticSink(null));
  t.mock.method(api, 'get', () => new Promise((resolve) => replies.push(resolve)));

  const store = module.useProvidersStore();

  store.providers = [{ id: 'private-provider' }];

  const old = store.load(false, { reason: 'startup' });
  const joined = store.load(false, { reason: 'mount' });
  const fresh = store.load(false, { invalidate: true, reason: 'sse' });

  replies[0]({ providers: [{ id: 'private-stale' }] });
  await old;
  replies[1]({ providers: [] });
  await Promise.all([joined, fresh]);

  const events = f.log.snapshot().entries;
  const registry = events.filter((entry) => entry.ev === 'providers.registry').map((entry) => entry.data);

  assert.ok(registry.some((entry) => entry.reason === 'mount' && entry.outcome === 'joined'));
  assert.ok(registry.some((entry) => entry.outcome === 'discarded'));
  assert.ok(registry.some((entry) => entry.reason === 'sse' && entry.outcome === 'applied'));
  assert.ok(events.some((entry) => entry.ev === 'state.anomaly' && entry.data.kind === 'empty-snapshot'));
  assert.doesNotMatch(JSON.stringify(events), /private-provider|private-stale/u);
  f.log.setLevel('errors');

  const invalid = store.load(false, { reason: 'manual' });

  replies[2]({ providers: 'private-invalid' });
  await invalid;
  assert.equal((await store.whenRegistryReady()).ok, false);
  assert.ok(f.log.snapshot().entries.some((entry) => entry.ev === 'state.anomaly'
    && entry.data.kind === 'invalid-snapshot'));
  assert.doesNotMatch(JSON.stringify(f.log.snapshot()), /private-invalid/u);
});

test('повторы аномалий и ошибок подписчиков ограничены и не принимают неизвестные строки', (t) => {
  const f = fixture(t);

  for (let index = 0; index < 20; index += 1) {
    f.log.record('sse.fault', {
      signal: 'private-signal',
      phase: 'subscriber',
      name: 'TypeError',
    });
    f.log.record('state.anomaly', {
      store: 'providers',
      action: 'load',
      kind: 'empty-snapshot',
      request: index,
      previous: 3,
      count: 0,
    });
  }

  const events = f.log.snapshot().entries;

  assert.equal(events.filter((entry) => entry.ev === 'sse.fault').length, 5);
  assert.equal(events.filter((entry) => entry.ev === 'state.anomaly').length, 5);
  assert.doesNotMatch(JSON.stringify(events), /private-signal/u);
});
