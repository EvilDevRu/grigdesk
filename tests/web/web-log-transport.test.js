import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWebLog } from '../../web/src/shared/webLog.ts';
import { attachTransport } from '../../web/src/shared/webLogTransport.ts';

function makeLog(page = 'page-aaaaaaaaaaaaaaaa') {
  return createWebLog({ now: () => new Date('2026-09-23T01:00:00Z'),
    monotonicNow: () => 0, pageId: page, tabId: 'tab-bbbbbbbbbbbbbbbb', version: 'dev',
    context: () => ({ route: '/chats', vis: 'visible', boot: null }) });
}

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key), values };
}

const timers = { setInterval: () => 0, clearInterval: () => undefined,
  setTimeout, clearTimeout };

test('ACK удаляет только подтверждённую пачку и сохраняет новые записи', async () => {
  const log = makeLog();
  const queueStorage = storage();
  const authState = { ready: true, authenticated: true, epoch: 0, confirmation: 1 };
  let resolveFetch;
  const deliveries = [];
  const transport = attachTransport(log, {
    fetch: () => new Promise((resolve) => { resolveFetch = resolve; }),
    url: '/api/web-log', storage: queueStorage, auth: () => authState, timers,
    now: () => 0, beacon: () => false,
  });
  transport.subscribeDelivery((event) => deliveries.push(event));
  const first = log.record('app.pagehide', { persisted: false });
  const sending = transport.flush();
  const second = log.mark('Сбой', null);
  resolveFetch(new Response(JSON.stringify({ accepted: 1, dropped: 0, reason: null }),
    { status: 200 }));
  await sending;

  assert.deepEqual(transport.snapshot().pending.map((item) => item.seq), [second.seq]);
  assert.ok(deliveries.some((event) => event.key.seq === first.seq && event.status === 'ack'));
  assert.ok(queueStorage.values.get('grigdesk-web-log-queue-v1').includes('"seq":2'));
  transport.dispose();
});

test('недоступность, F5 и повторная отправка сохраняют исходный ключ', async () => {
  const queueStorage = storage();
  const authState = { ready: true, authenticated: true, epoch: 0, confirmation: 1 };
  const firstLog = makeLog();
  const first = attachTransport(firstLog, {
    fetch: async () => { throw new Error('offline'); }, url: '/api/web-log',
    storage: queueStorage, auth: () => authState, timers, now: () => 0, beacon: () => true,
  });
  const key = firstLog.mark('После сбоя', null);
  await first.flush();
  assert.equal(first.snapshot().pending.length, 1);
  first.onHidden();
  assert.equal(first.snapshot().pending.length, 1);
  first.dispose();

  const nextLog = makeLog('page-cccccccccccccccc');
  const second = attachTransport(nextLog, {
    fetch: async () => new Response(JSON.stringify({ accepted: 1, dropped: 0, reason: null }),
      { status: 200 }), url: '/api/web-log', storage: queueStorage,
    auth: () => authState, timers, now: () => 10_000, beacon: () => false,
  });
  assert.deepEqual(second.snapshot().pending.map((item) => ({ page: item.page, seq: item.seq })),
    [key]);
  await second.flush();
  assert.equal(second.snapshot().pending.length, 0);
  second.dispose();
});

test('401 ждёт нового подтверждения auth, logout игнорирует поздний ACK', async () => {
  const queueStorage = storage();
  const authState = { ready: true, authenticated: true, epoch: 0, confirmation: 1 };
  const log = makeLog();
  let calls = 0;
  let resolveLate;
  const transport = attachTransport(log, {
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 401 });
      return new Promise((resolve) => { resolveLate = resolve; });
    }, url: '/api/web-log', storage: queueStorage, auth: () => authState,
    timers, now: () => 0, beacon: () => false,
  });
  log.mark('Сбой', null);
  await transport.flush();
  assert.equal(transport.snapshot().paused, true);
  await transport.flush();
  assert.equal(calls, 1);
  authState.confirmation = 2;
  transport.authChanged();
  const pending = transport.flush();
  authState.epoch = 1;
  authState.authenticated = false;
  transport.authChanged();
  resolveLate(new Response(JSON.stringify({ accepted: 1, dropped: 0, reason: null }),
    { status: 200 }));
  await pending;
  assert.equal(transport.snapshot().pending.length, 0);
  assert.equal(log.snapshot().entries.length, 0);
  transport.dispose();
});

test('поздний ACK сам замечает новую auth-эпоху до обработки ответа', async () => {
  const authState = { ready: true, authenticated: true, epoch: 0, confirmation: 1 };
  const log = makeLog();
  let resolveFetch;
  const transport = attachTransport(log, {
    fetch: () => new Promise((resolve) => { resolveFetch = resolve; }),
    url: '/api/web-log', storage: storage(), auth: () => authState, timers,
    now: () => 0, beacon: () => false,
  });
  log.mark('До выхода', null);
  const sending = transport.flush();

  authState.epoch = 1;
  authState.authenticated = false;
  resolveFetch(new Response(JSON.stringify({ accepted: 1, dropped: 0, reason: null }),
    { status: 200 }));
  await sending;

  assert.equal(transport.snapshot().pending.length, 0);
  assert.equal(log.snapshot().entries.length, 0);
  assert.equal(log.snapshot().seq, 1, 'logout не сбрасывает seq текущего документа');
  transport.dispose();
});

test('429 и 503 держат очередь и соблюдают Retry-After и backoff', async () => {
  const authState = { ready: true, authenticated: true, epoch: 0, confirmation: 1 };
  const log = makeLog();
  let clock = 0;
  let calls = 0;
  const transport = attachTransport(log, {
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 429,
        headers: { 'Retry-After': '20' } });
      return new Response('', { status: 503 });
    },
    url: '/api/web-log', storage: storage(), auth: () => authState, timers,
    now: () => clock, random: () => 0.5, beacon: () => false,
  });
  log.record('app.pagehide', { persisted: false });
  await transport.flush();
  assert.equal(transport.snapshot().retryAt, 20_000);
  assert.equal(transport.snapshot().pending.length, 1);
  clock = 19_999;
  await transport.flush();
  assert.equal(calls, 1);
  clock = 20_000;
  await transport.flush();
  assert.equal(calls, 2);
  assert.equal(transport.snapshot().retryAt, 30_000);
  assert.equal(transport.snapshot().pending.length, 1);
  transport.dispose();
});
