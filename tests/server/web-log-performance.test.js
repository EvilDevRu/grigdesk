import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import authPlugin from '../../server/src/plugins/auth.ts';
import webLogModule from '../../server/src/modules/web-log/index.ts';
import { createWebLog } from '../../web/src/shared/webLog.ts';
import { createChatPerformanceRecorder } from '../../web/src/shared/chatPerformance.ts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');

test('замеры проходят ядро окна, auth, серверную политику и очищенную запись на диск', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'web-performance-log-'));
  const app = Fastify({ logger: false });

  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  let level = 'verbose';
  let clock = 0;

  await app.register(authPlugin, {
    authStore: {
      isConfigured: () => true,
      isValidSession: (id) => id === 'test-session',
    },
  });
  await app.register(webLogModule, {
    dir,
    policy: { level: async () => level },
    now: () => new Date('2026-10-29T12:00:00Z'),
  });

  const log = createWebLog({
    now: () => new Date('2026-10-29T12:00:00Z'),
    monotonicNow: () => clock,
    pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb',
    version: 'dev',
    context: () => ({
      route: '/chats',
      vis: 'visible',
      boot: null,
    }),
  });
  const recorder = createChatPerformanceRecorder({
    now: () => clock,
    view: () => '/chats',
    emit: (event, data) => log.record(event, data),
    afterFlush: (callback) => callback(),
  });

  log.record('perf.ready', {
    tag: 'chat-perf',
    longTasks: true,
    longFrames: false,
  });

  const finish = recorder.start('chat.snapshot', () => ({ chats: 80, chars: 500_000 }));

  clock = 140;
  finish();
  recorder.block('longtask', 0, 150);
  recorder.flush();
  log.record('api.pending', {
    method: 'GET',
    path: '/api/web-log/routes',
    ms: 3000,
    attempt: 1,
    request: 1,
    phase: 'headers',
  });
  log.record('sse.fault', {
    signal: 'providers-update',
    phase: 'subscriber',
    name: 'TypeError',
  });
  log.record('state.anomaly', {
    store: 'providers',
    action: 'load',
    kind: 'empty-snapshot',
    request: 1,
    previous: 3,
    count: 0,
  });


log.record('perf.surface', {
  surface: 7,
  kind: 'route',
  target: 'chats',
  view: '/chats',
  phase: 'ready',
  origin: 'navigation',
  first: true,
  ms: 150,
  pending: 0,
});
log.record('api.complete', {
  method: 'GET',
  path: '/api/web-log/routes',
  ms: 100,
  attempt: 1,
  surface: 7,
  request: 5,
  outcome: 'success',
  serverMs: 80,
  pipeMs: 95,
  serverRequest: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
});
log.record('api.summary', {
  method: 'GET',
  path: '/api/web-log/routes',
  count: 20,
  totalMs: 100,
  maxMs: 10,
  periodMs: 10000,
});
log.record('perf.shell', {
  operation: 'connect',
  phase: 'success',
  ms: 50
});

  const entries = log.snapshot().entries.map((entry) => ({
    ...entry,
    data: { ...entry.data, privateText: 'Содержимое не должно сохраняться' },
  }));
  const payload = { v: 1, entries };
  const headers = { cookie: 'grigdesk_sid=test-session' };
  const unauthorized = await app.inject({
    method: 'POST',
    url: '/api/web-log',
    payload,
  });

  assert.equal(unauthorized.statusCode, 401);

  const response = await app.inject({
    method: 'POST',
    url: '/api/web-log',
    headers,
    payload,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().accepted, 10);

  const text = await readFile(path.join(dir, '2026-10-29.ndjson'), 'utf8');
  const saved = text.trim().split('\n').map((line) => JSON.parse(line));

  assert.deepEqual(saved.map((entry) => entry.ev), [
    'perf.ready', 'perf.operation', 'perf.block', 'api.pending', 'sse.fault', 'state.anomaly',
    'perf.surface', 'api.complete', 'api.summary', 'perf.shell',
  ]);
  assert.equal(saved[1].data.ms, 140);
  assert.equal(saved[2].data.operation, 'chat.snapshot');
assert.equal(saved[6].data.surface, 7);
assert.equal(saved[7].data.serverRequest, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
assert.equal(saved[7].data.pipeMs, 95);
assert.equal(saved[8].data.count, 20);
assert.equal(saved[9].data.operation, 'connect');

  assert.doesNotMatch(text, /privateText|Содержимое/u);
  level = 'errors';

  const rejected = await app.inject({
    method: 'POST',
    url: '/api/web-log',
    headers,
    payload,
  });

  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().error, 'logging_policy_changed');
  assert.equal(await readFile(path.join(dir, '2026-10-29.ndjson'), 'utf8'), text);
});
