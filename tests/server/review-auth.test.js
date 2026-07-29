import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import authPlugin from '../../server/src/plugins/auth.js';
import ssePlugin from '../../server/src/plugins/sse.js';
import reviewsModule from '../../server/src/modules/reviews/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

test('API-SEC-01 RB-07: review GET, mutation и SSE закрыты общей авторизацией', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-auth.'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(stateDir, { recursive: true });
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  const authStore = {
    isConfigured: () => true,
    isValidSession: (sid) => sid === 'valid-session',
  };
  const reviews = {
    snapshot: async () => ({ pulls: [], summary: { count: 0 } }),
    summary: async () => ({ count: 0 }),
    setScope: async () => ({ ok: true }),
  };
  await app.register(authPlugin, {
    authStore,
    tlsEnabled: false,
    trustProxy: '',
    internalToken: 'internal-only',
    cliToken: 'cli-only',
  });
  app.post('/api/chat/permission-request', async () => ({ behavior: 'deny' }));
  app.get('/api/terminal', async () => ({ shell: true }));
  app.get('/api/b24/dashboard', async () => ({ ok: true }));
  await app.register(ssePlugin, { stateDir });
  await app.register(reviewsModule, { reviews });

  for (const request of [
    { method: 'GET', url: '/api/reviews' },
    {
      method: 'PUT',
      url: '/api/reviews/pulls/pr-1/scope',
      payload: { items: [] },
    },
    { method: 'GET', url: '/api/events' },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 401, `${request.method} ${request.url}`);
    assert.equal(response.json().error, 'unauthorized');
  }

  const allowed = await app.inject({
    method: 'GET',
    url: '/api/reviews',
    headers: { cookie: 'cockpit_sid=valid-session' },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers['cache-control'], 'no-store');

  const csrf = await app.inject({
    method: 'POST',
    url: '/api/reviews/pulls/pr-1/analyze',
    headers: {
      cookie: 'cockpit_sid=valid-session',
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: '',
  });
  assert.equal(csrf.statusCode, 403);
  assert.equal(csrf.json().error, 'csrf_json_required');

  const internalPermission = await app.inject({
    method: 'POST',
    url: '/api/chat/permission-request',
    headers: { 'x-cockpit-internal': 'internal-only' },
    payload: {},
  });
  assert.equal(internalPermission.statusCode, 200);

  const internalTerminal = await app.inject({
    method: 'GET',
    url: '/api/terminal',
    headers: { 'x-cockpit-internal': 'internal-only' },
  });
  assert.equal(internalTerminal.statusCode, 401);

  const cliB24 = await app.inject({
    method: 'GET',
    url: '/api/b24/dashboard',
    headers: { 'x-cockpit-token': 'cli-only' },
  });
  assert.equal(cliB24.statusCode, 200);

  const cliTerminal = await app.inject({
    method: 'GET',
    url: '/api/terminal',
    headers: { 'x-cockpit-token': 'cli-only' },
  });
  assert.equal(cliTerminal.statusCode, 401);

  for (const headers of [
    { 'x-cockpit-internal': 'internal-only' },
    { 'x-cockpit-token': 'cli-only' },
  ]) {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/reviews/pulls/pr-1/scope',
      headers,
      payload: { items: [] },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'unauthorized');
  }
});
