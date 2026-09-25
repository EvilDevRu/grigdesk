import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import authPlugin from '../../server/src/plugins/auth.ts';
import webLogModule from '../../server/src/modules/web-log/index.ts';
import { createApiRouteRegistry } from '../../server/src/lib/webLog/apiRoutes.ts';
import { createWebLog } from '../../web/src/shared/webLog.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

test('приёмник закрыт auth guard и пишет только очищенные поля', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-web-log-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(authPlugin, { authStore: {
    isConfigured: () => true, isValidSession: (id) => id === 'test-session',
  }, tlsEnabled: true });
  await app.register(webLogModule, { dir, policy: { level: async () => 'verbose' },
    now: () => new Date('2026-09-23T11:00:00Z') });

  const log = createWebLog({ now: () => new Date(), monotonicNow: () => 0,
    pageId: 'page-aaaaaaaaaaaaaaaa', tabId: 'tab-bbbbbbbbbbbbbbbb', version: 'dev',
    context: () => ({ route: '/projects/private?token=secret', vis: 'visible', boot: null }) });
  log.record('app.pagehide', { persisted: false });
  const entry = log.snapshot().entries[0];
  const body = { v: 1, entries: [{ ...entry, injected: 'secret',
    data: { persisted: false, private: 'secret' } }] };

  assert.equal((await app.inject({ method: 'POST', url: '/api/web-log', payload: body })).statusCode, 401);
  const authorized = { cookie: 'cockpit_sid=test-session' };
  const posted = await app.inject({ method: 'POST', url: '/api/web-log',
    headers: authorized, payload: body });
  assert.equal(posted.statusCode, 200);
  assert.deepEqual(posted.json(), { accepted: 1, dropped: 0, reason: null });

  const file = await readFile(path.join(dir, '2026-09-23.ndjson'), 'utf8');
  assert.doesNotMatch(file, /secret|private|injected/u);
  assert.equal(JSON.parse(file).route, '/projects/:id?');
  const download = await app.inject({ method: 'GET', url: '/api/web-log/download?day=2026-09-23',
    headers: authorized });
  assert.equal(download.statusCode, 200);
  assert.match(download.headers['content-disposition'], /attachment/u);
  assert.equal(download.body, file);
  assert.equal((await app.inject({ method: 'GET',
    url: '/api/web-log/download?day=2026-09-23' })).statusCode, 401);
});

test('приёмник отвергает неверную пачку целиком', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-web-log-api-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(authPlugin, { authStore: {
    isConfigured: () => true, isValidSession: () => true,
  }, tlsEnabled: true });
  await app.register(webLogModule, { dir, policy: { level: async () => 'verbose' } });

  const headers = { cookie: 'cockpit_sid=test-session' };
  const invalid = await app.inject({ method: 'POST', url: '/api/web-log', headers,
    payload: { v: 2, entries: [] } });
  assert.equal(invalid.statusCode, 400);
  assert.equal((await app.inject({ method: 'GET',
    url: '/api/web-log/download?day=../../etc/passwd', headers })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET',
    url: '/api/web-log/download?day=2026-09-23', headers })).statusCode, 404);
});

test('сервер проверяет глобальный уровень для корня и вложенной предыстории', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-web-log-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  let level = 'off';

  await app.register(authPlugin, { authStore: {
    isConfigured: () => true, isValidSession: () => true,
  }, tlsEnabled: true });
  await app.register(webLogModule, { dir, policy: { level: async () => level },
    now: () => new Date('2026-09-23T11:00:00Z') });

  const log = createWebLog({ now: () => new Date('2026-09-23T10:00:00Z'),
    monotonicNow: () => 0, pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb', version: 'dev',
    context: () => ({ route: '/chats', vis: 'visible', boot: null }) });
  log.record('ui.focus', { target: { tag: 'INPUT', context: 'other' } });
  log.mark('Сбой', null);
  const entries = log.snapshot().entries;
  const headers = { cookie: 'cockpit_sid=test-session' };
  const post = (entry) => app.inject({ method: 'POST', url: '/api/web-log', headers,
    payload: { v: 1, entries: [entry] } });

  const disabled = await post(entries[1]);
  assert.equal(disabled.statusCode, 409);
  assert.equal(disabled.json().level, 'off');

  level = 'errors';
  const nested = await post(entries[1]);
  assert.equal(nested.statusCode, 409);
  assert.equal(nested.json().level, 'errors');

  const withoutDetail = { ...entries[1], dump: { entries: [], omitted: 1,
    from: null, to: null } };
  assert.equal((await post(withoutDetail)).statusCode, 200);
  assert.equal((await post(entries[0])).statusCode, 409);
  const file = await readFile(path.join(dir, '2026-09-23.ndjson'), 'utf8');
  assert.equal(file.trim().split('\n').length, 1);
  assert.doesNotMatch(file, /ui.focus/u);
});

test('каталог шаблонов /api закрыт auth guard, а приёмник сверяет с ним пути', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-web-log-routes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  const apiRoutes = createApiRouteRegistry();

  app.addHook('onRoute', (route) => apiRoutes.add(route.url));
  await app.register(authPlugin, { authStore: {
    isConfigured: () => true, isValidSession: (id) => id === 'test-session',
  }, tlsEnabled: true });
  app.get('/api/tasks/:id/graph', async () => ({}));
  app.get('/outside', async () => ({}));
  await app.register(webLogModule, { dir, policy: { level: async () => 'verbose' }, apiRoutes,
    now: () => new Date('2026-09-23T11:00:00Z') });

  const headers = { cookie: 'cockpit_sid=test-session' };
  assert.equal((await app.inject({ method: 'GET', url: '/api/web-log/routes' })).statusCode, 401);
  const listed = await app.inject({ method: 'GET', url: '/api/web-log/routes', headers });
  assert.equal(listed.statusCode, 200);
  assert.ok(listed.json().routes.includes('/api/tasks/:id/graph'));
  assert.ok(listed.json().routes.includes('/api/web-log/routes'));
  assert.equal(listed.json().routes.includes('/outside'), false);

  const log = createWebLog({ now: () => new Date(), monotonicNow: () => 0,
    pageId: 'page-aaaaaaaaaaaaaaaa', tabId: 'tab-bbbbbbbbbbbbbbbb', version: 'dev',
    context: () => ({ route: '/chats', vis: 'visible', boot: null }) });
  for (const path of ['/api/tasks/:id/graph', '/api/tasks/12345/graph']) {
    log.record('api.fail', { method: 'GET', path, status: 502, ms: 3, attempt: 1, willRetry: false });
  }
  const posted = await app.inject({ method: 'POST', url: '/api/web-log', headers,
    payload: { v: 1, entries: log.snapshot().entries } });
  assert.equal(posted.statusCode, 200);

  const stored = (await readFile(path.join(dir, '2026-09-23.ndjson'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line).data.path);
  assert.deepEqual(stored, ['/api/tasks/:id/graph', 'other']);
});
