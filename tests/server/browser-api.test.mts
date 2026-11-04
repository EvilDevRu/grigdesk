import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { AuthStore } from '../../server/src/lib/authStore.ts';
import { createBrowserBroker } from '../../server/src/lib/browser/browserBroker.ts';
import { createBrowserAccess } from '../../server/src/lib/browser/browserAccess.ts';
import { createBrowserOwners } from '../../server/src/lib/browser/browserOwners.ts';
import browserModule from '../../server/src/modules/browser/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import { createBrowserHostHttp } from '../../web/src/shared/browser/browserHostHttp.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');

/**
 * Настоящий общий auth guard отличает session от CLI/internal bearer.
 * Native эффект подменён broker poll/result; сеть, Electron и модели не запускаются.
 */
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-api-'));
  const authStore = new AuthStore({
    sessionsPath: path.join(root, 'sessions.json'), legacyAccountPath: path.join(root, 'account.json'),
  });
  const app = Fastify({ logger: false });
  const cookie = `grigdesk_sid=${authStore.createSession().id}`;
  const owners = createBrowserOwners();
  const owner = JSON.stringify(['chat', null, 'own', null]);
  let present = true;

  owners.register('chat', async () => present ? [{ owner, label: 'Чат own' }] : []);

  const broker = createBrowserBroker({ validateOwner: owners.exists });
  const access = createBrowserAccess({
    generation: broker.generation,
    exists: owners.exists,
    queue: (key, input, options) => broker.invoke(key, input, options.signal, options.authorize,
      { grantEpoch: options.grantEpoch }),
  });
  let mode: 'legacy' | 'grigdesk' = 'legacy';
  const routing = { mode: () => mode, set: (value: typeof mode) => {
    mode = value;
  } };

  await app.register(authPlugin, {
    authStore,
    internalToken: 'internal',
    cliToken: 'cli'
  });
  await app.register(browserModule, {
    broker,
    access,
    owners,
    routing
  });
  app.addHook('onClose', async () => broker.close());
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    app,
    cookie,
    broker,
    access,
    owner,
    owners,
    routing,
    remove: () => {
    present = false;
  }
  };
}

test('API-host-delete: HTTP клиента снимает host без JSON body и освобождает регистрацию', async (t) => {
  const f = await fixture(t);
  const request = createBrowserHostHttp({
    unauthorized: () => assert.fail('session fixture авторизована'),
    fetch: async (input, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers));
      const response = await f.app.inject({
        method: init?.method,
        url: String(input),
        headers: { ...headers, cookie: f.cookie },
        ...(init?.body === undefined ? {} : { payload: init.body }),
      });

      return new Response(response.body, { status: response.statusCode });
    },
  });
  const host = await request('POST', '/hosts', {}, null) as {
    id: string;
    token: string;
    hostEpoch: number;
    leaseMs: number;
  };

  assert.deepEqual(await request('DELETE', '/hosts/' + host.id, undefined, host), { accepted: true });
  assert.equal(f.broker.available(), false);
  assert.ok(await request('POST', '/hosts', {}, null), 'новый host не ждёт истечения чужого lease');
});

test('API01: 401/CLI/internal отказ, одна session host и явный takeover', async (t) => {
  const f = await fixture(t);
  const call = (headers = {}, payload = {}) => f.app.inject({
    method: 'POST',
    url: '/api/browser/hosts',
    headers,
    payload,
  });

  assert.equal((await call()).statusCode, 401);
  assert.equal((await call({ 'x-grigdesk-token': 'cli' })).statusCode, 403);
  assert.equal((await call({ 'x-grigdesk-internal': 'internal' })).statusCode, 403);
  assert.equal((await call({ cookie: f.cookie }, { forged: true })).statusCode, 400);

  const host = await call({ cookie: f.cookie });

  assert.equal(host.statusCode, 200);
  assert.equal(host.json().leaseMs, 15000);
  assert.equal(f.routing.mode(), 'grigdesk');
  assert.equal((await call({ cookie: f.cookie })).statusCode, 409);
  assert.equal((await call({ cookie: f.cookie }, { takeover: true })).statusCode, 200);
});

test('API02: poll/result token, request id и durable disable ACK', async (t) => {
  const f = await fixture(t);
  const host = f.broker.register();
  const headers = { cookie: f.cookie, 'x-grigdesk-browser-host': host.token };
  const pending = f.access.invoke(f.owner, { action: 'open', url: 'https://stand.invalid/' });
  const poll = await f.app.inject({
    method: 'POST',
    url: `/api/browser/hosts/${host.id}/poll`,
    headers,
    payload: {},
  });
  const command = poll.json();

  assert.equal(command.owner, f.owner);

  const result = {
    ok: true,
    tabId: 'tab',
    url: 'https://stand.invalid/',
    grantEpoch: 1
  };
  const resultUrl = `/api/browser/hosts/${host.id}/result`;
  const denied = await f.app.inject({
    method: 'POST',
    url: resultUrl,
    payload: { requestId: command.requestId, result },
    headers: { ...headers, 'x-grigdesk-browser-host': 'foreign' },
  });

  assert.equal(denied.statusCode, 403);

  const accepted = await f.app.inject({
    method: 'POST',
    url: resultUrl,
    headers,
    payload: { requestId: command.requestId, result },
  });

  assert.deepEqual(accepted.json(), { accepted: true });
  assert.deepEqual(await pending, result);

  const off = await f.app.inject({
    method: 'POST',
    url: '/api/browser/mode',
    headers,
    payload: { enabled: false },
  });

  assert.deepEqual(off.json(), { enabled: false });
  assert.equal(f.routing.mode(), 'legacy');
  assert.equal(f.broker.available(), false);
});

test('API03: opaque owner не восстанавливает удалённый чат; grant требует native ACK', async (t) => {
  const f = await fixture(t);
  const host = f.broker.register();
  const headers = { cookie: f.cookie, 'x-grigdesk-browser-host': host.token };
  const rows = await f.owners.list();

  assert.notEqual(rows[0]!.id, f.owner);

  const grant = Promise.resolve(f.app.inject({
    method: 'POST',
    url: '/api/browser/grants',
    headers,
    payload: {
      tabId: 'human',
      ownerId: rows[0]!.id,
      pageEpoch: 2,
      grantEpoch: 1
    },
  }));
  const command = await f.broker.poll(host.id, host.token);

  assert.ok(command);
  assert.equal(command.action, 'grant');
  await f.broker.result(host.id, host.token, command.requestId, { tabs: [{
    id: 'human',
    url: 'https://stand.invalid/',
    grantEpoch: 2,
  }] });
  assert.equal((await grant).statusCode, 200);
  f.remove();
  await assert.rejects(() => f.owners.resolve(rows[0]!.id), /browser_owner_forbidden/u);
  await assert.rejects(() => f.access.invoke(f.owner, { action: 'snapshot', tabId: 'human' }),
    /browser_access_denied/u);
});
