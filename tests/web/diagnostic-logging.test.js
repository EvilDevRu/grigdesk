import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allowsWebLogEvent } from '../../shared/web-log/diagnosticLogging.ts';
import { createWebLog } from '../../web/src/shared/webLog.ts';
import { attachTransport } from '../../web/src/shared/webLogTransport.ts';

function makeLog(level = 'verbose') {
  return createWebLog({
    now: () => new Date('2026-09-23T01:00:00Z'),
    monotonicNow: () => 0,
    pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb',
    version: 'dev',
    context: () => ({ route: '/chats', vis: 'visible', boot: null }),
    level,
  });
}

function storage() {
  const values = new Map();

  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
}

const timers = {
  setInterval: () => 0,
  clearInterval: () => undefined,
  setTimeout,
  clearTimeout,
};

test('общий порог оставляет ошибки при errors, контекст при decisions', () => {
  assert.equal(allowsWebLogEvent('off', 'vue.error'), false);
  assert.equal(allowsWebLogEvent('off', 'mark'), false);
  assert.equal(allowsWebLogEvent('errors', 'vue.error'), true);
  assert.equal(allowsWebLogEvent('errors', 'mark'), true);
  assert.equal(allowsWebLogEvent('errors', 'router.nav'), false);
  assert.equal(allowsWebLogEvent('decisions', 'router.nav'), true);
  assert.equal(allowsWebLogEvent('decisions', 'ui.layer'), true);
  assert.equal(allowsWebLogEvent('decisions', 'ui.focus'), false);
  assert.equal(allowsWebLogEvent('verbose', 'ui.focus'), true);
});

test('ранние ошибки очищаются в памяти и получают исходное время после загрузки уровня', () => {
  let at = 0;
  const log = createWebLog({
    now: () => new Date(1_700_000_000_000 + at),
    monotonicNow: () => at,
    pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb',
    version: 'dev',
    context: () => ({ route: '/chats', vis: 'visible', boot: null }),
    level: null,
  });

  assert.equal(log.record('app.start', {}), null);
  at = 1000;
  assert.equal(log.record('js.error', { error: {
    name: 'Error', message: 'private error text',
  } }), null);
  assert.equal(log.mark('Неизвестный уровень', null), null);
  assert.equal(log.snapshot().entries.length, 0);
  at = 2000;
  log.setLevel('errors');

  assert.deepEqual(log.snapshot().entries.map((entry) => entry.ev), ['js.error']);
  assert.equal(log.snapshot().entries[0].t, new Date(1_700_000_001_000).toISOString());
  assert.equal(log.snapshot().entries[0].data.error.message, 'unclassified');
  assert.equal(log.snapshot().seq, 1);
});

test('понижение уровня чистит кольцо, плоский дамп и pending без сброса seq', () => {
  const log = makeLog();
  const queueStorage = storage();
  const transport = attachTransport(log, {
    fetch: async () => { throw new Error('offline'); },
    url: '/api/web-log',
    storage: queueStorage,
    auth: () => ({ ready: true, authenticated: true, epoch: 0, confirmation: 1 }),
    timers,
    beacon: () => false,
  });
  const deliveries = [];

  transport.subscribeDelivery((event) => deliveries.push(event));
  const context = log.record('app.start', {});
  const detail = log.record('ui.focus', { target: { tag: 'INPUT', context: 'other' } });
  const mark = log.mark('Сбой', null);

  assert.ok(context && detail && mark);
  assert.equal(log.snapshot().entries.at(-1).dump.entries.length, 2);
  log.setLevel('errors');

  assert.deepEqual(log.snapshot().entries.map((entry) => entry.ev), ['mark']);
  assert.equal(log.snapshot().entries[0].dump.entries.length, 0);
  assert.deepEqual(transport.snapshot().pending.map((entry) => entry.seq), [mark.seq]);
  assert.equal(transport.snapshot().pending[0].dump.entries.length, 0);
  assert.ok(deliveries.some((item) => item.key.seq === context.seq && item.status === 'drop'));
  assert.ok(queueStorage.values.get('grigdesk-web-log-queue-v1').includes('"seq":3'));

  log.setLevel('off');
  assert.equal(log.mark('Выключено', null), null);
  assert.equal(transport.snapshot().pending.length, 0);
  assert.equal(log.snapshot().seq, mark.seq);
  transport.dispose();
});

test('приёмник сообщает новый уровень: клиент очищает очередь и прекращает отправку', async () => {
  const log = makeLog();
  let sends = 0;
  const transport = attachTransport(log, {
    fetch: async () => {
      sends += 1;

      return new Response(JSON.stringify({ error: 'logging_policy_changed', level: 'off' }),
        { status: 409 });
    },
    url: '/api/web-log',
    storage: storage(),
    auth: () => ({ ready: true, authenticated: true, epoch: 0, confirmation: 1 }),
    timers,
    beacon: () => false,
  });

  log.mark('Сбой', null);
  await transport.flush();
  await transport.flush();
  assert.equal(log.level(), 'off');
  assert.equal(transport.snapshot().pending.length, 0);
  assert.equal(sends, 1);
  transport.dispose();
});

test('поздний 409 старого POST не отменяет новую политику окна', async () => {
  const log = makeLog('verbose');
  let answer;
  const transport = attachTransport(log, {
    fetch: () => new Promise((resolve) => { answer = resolve; }),
    url: '/api/web-log',
    storage: storage(),
    auth: () => ({ ready: true, authenticated: true, epoch: 0, confirmation: 1 }),
    timers,
    beacon: () => false,
  });

  log.mark('Сбой', null);
  const sending = transport.flush();
  log.setLevel('errors');
  answer(new Response(JSON.stringify({ error: 'logging_policy_changed', level: 'off' }),
    { status: 409 }));
  await sending;

  assert.equal(log.level(), 'errors');
  assert.equal(transport.snapshot().pending.length, 1);
  transport.dispose();
});
