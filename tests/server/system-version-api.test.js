import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import systemModule from '../../server/src/modules/system/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

test('system version endpoints delegate local status and explicit remote check', async (t) => {
  let gets = 0;
  let checks = 0;
  let starts = 0;
  let stops = 0;
  let jobGets = 0;
  const releases = {
    async getStatus() { gets += 1; return { running: { version: '0.1.0' } }; },
    async checkRemote() { checks += 1; return { latest: { tag: 'v0.2.0' } }; },
    start() { starts += 1; },
    stop() { stops += 1; },
  };
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(systemModule, {
    system: { read: () => ({}) },
    config: { rootDir: '/tmp/noop', cockpitUpdateStatePath: '/tmp/noop-state' },
    releases,
    updates: {
      async getJob() { jobGets += 1; return null; },
      async assertIdle() {},
      async startApply() { return { id: 'apply-job' }; },
      async startUpdate() { return { id: 'update-job' }; },
    },
  });

  assert.equal((await app.inject('/api/system/version')).statusCode, 200);
  assert.equal(gets, 1);
  assert.equal(checks, 0, 'GET never starts a remote check');
  assert.equal((await app.inject({ method: 'POST', url: '/api/system/version/check' })).statusCode, 200);
  assert.equal(checks, 1);
  assert.equal((await app.inject('/api/system/update-job')).statusCode, 200);
  assert.equal(jobGets, 1);
  const sha = 'a'.repeat(40);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/system/apply', payload: { expectedCheckoutSha: sha },
  })).statusCode, 202);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/system/update', payload: { targetTag: 'v0.2.0', expectedCheckoutSha: sha },
  })).statusCode, 202);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/system/update', payload: { targetTag: '../../main', expectedCheckoutSha: sha },
  })).statusCode, 400);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/system/update',
    payload: { targetTag: 'v0.2.0', expectedCheckoutSha: sha, remote: 'attacker' },
  })).statusCode, 400);
  assert.equal(starts, 1);
  await app.close();
  assert.equal(stops, 1);
});

test('web rebuild runs in background and blocks conflicting lifecycle actions', async (t) => {
  let rebuildCalls = 0;
  let resolveRebuild = null;
  const releases = {
    async getStatus() { return { running: { version: '0.1.0' } }; },
    start() {},
    stop() {},
  };
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(systemModule, {
    system: { read: () => ({}) },
    config: { rootDir: '/tmp/noop', cockpitUpdateStatePath: '/tmp/noop-state' },
    releases,
    updates: {
      async getJob() { return null; },
      async assertIdle() {},
      async startApply() { return { id: 'apply-job' }; },
      async startUpdate() { return { id: 'update-job' }; },
    },
    webRebuilder: () => {
      rebuildCalls += 1;
      return new Promise((resolve) => { resolveRebuild = resolve; });
    },
  });

  const flush = () => new Promise((r) => { setImmediate(r); });

  // Старт фоном: 202 сразу, статус running.
  assert.equal((await app.inject({ method: 'POST', url: '/api/system/web-rebuild' })).statusCode, 202);
  assert.equal(rebuildCalls, 1);
  let res = await app.inject('/api/system/web-rebuild');
  assert.equal(res.json().rebuild.status, 'running');

  // Пока идёт сборка: повтор, рестарт и применения заблокированы.
  assert.equal((await app.inject({ method: 'POST', url: '/api/system/web-rebuild' })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/system/restart' })).statusCode, 409);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/system/apply', payload: { expectedCheckoutSha: 'a'.repeat(40) },
  })).statusCode, 409);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/system/update', payload: { targetTag: 'v0.2.0', expectedCheckoutSha: 'a'.repeat(40) },
  })).statusCode, 409);
  assert.equal(rebuildCalls, 1);

  // Ошибка сборки → failed с кодом и сообщением; блокировки сняты.
  resolveRebuild({ code: 'web_build_failed', message: 'vite build завершился ошибкой.' });
  await flush();
  res = await app.inject('/api/system/web-rebuild');
  assert.equal(res.json().rebuild.status, 'failed');
  assert.equal(res.json().rebuild.error.code, 'web_build_failed');
  assert.ok(res.json().rebuild.finishedAt);

  // После завершения можно пересобрать снова; успех → done без ошибки.
  assert.equal((await app.inject({ method: 'POST', url: '/api/system/web-rebuild' })).statusCode, 202);
  assert.equal(rebuildCalls, 2);
  resolveRebuild(null);
  await flush();
  res = await app.inject('/api/system/web-rebuild');
  assert.equal(res.json().rebuild.status, 'done');
  assert.equal(res.json().rebuild.error, null);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/system/apply', payload: { expectedCheckoutSha: 'a'.repeat(40) },
  })).statusCode, 202);
});
