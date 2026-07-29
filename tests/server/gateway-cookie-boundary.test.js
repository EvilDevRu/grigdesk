import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { AuthStore } from '../../server/src/lib/auth-store.js';
import authModule from '../../server/src/modules/auth/index.js';
import authPlugin, {
  GATEWAY_COOKIE,
  SESSION_COOKIE,
  clearDomainCookie,
  gatewayCookie,
  sessionCookie,
} from '../../server/src/plugins/auth.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function temporaryAuthStore(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-gateway-auth.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new AuthStore({
    accountPath: path.join(root, 'account.json'),
    sessionsPath: path.join(root, 'sessions.json'),
  });
}

test('SEC-COOKIE-01: gateway token не является сессией Cockpit', async (t) => {
  const store = await temporaryAuthStore(t);
  const session = store.createSession();
  const gatewayToken = store.gatewayTokenForSession(session.id);

  assert.match(gatewayToken, /^[a-f0-9]{64}$/);
  assert.notEqual(gatewayToken, session.id);
  assert.equal(store.isValidGatewayToken(gatewayToken), true);
  assert.equal(store.isValidSession(gatewayToken), false);

  store.dropSession(session.id);
  assert.equal(store.isValidGatewayToken(gatewayToken), false);
});

test('SEC-COOKIE-02: полная session cookie host-only, Domain получает только gateway token', () => {
  const full = sessionCookie('full-session', {
    maxAgeSec: 60,
    secure: true,
    domain: 'example.test',
  });
  const gateway = gatewayCookie('limited-token', {
    maxAgeSec: 60,
    secure: true,
    domain: 'example.test',
  });

  assert.match(full, /^cockpit_sid=full-session;/);
  assert.doesNotMatch(full, /Domain=/i);
  assert.match(full, /Secure/);
  assert.match(gateway, /^cockpit_gateway=limited-token;/);
  assert.match(gateway, /Domain=example\.test/);
  assert.match(
    clearDomainCookie(SESSION_COOKIE, { secure: true, domain: 'example.test' }),
    /cockpit_sid=.*Max-Age=0.*Domain=example\.test/,
  );
});

test('SEC-COOKIE-03: gateway cookie открывает только forward_auth, но не review API', async (t) => {
  const store = await temporaryAuthStore(t);
  const session = store.createSession();
  const gatewayToken = store.gatewayTokenForSession(session.id);
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(authPlugin, {
    authStore: store,
    tlsEnabled: false,
    trustProxy: '',
    internalToken: '',
    cliToken: '',
  });
  app.get('/api/gateway/authz', async (_request, reply) => reply.code(204).send());
  app.get('/api/reviews/probe', async () => ({ ok: true }));

  const gatewayAuth = await app.inject({
    method: 'GET',
    url: '/api/gateway/authz',
    headers: { cookie: `${GATEWAY_COOKIE}=${gatewayToken}` },
  });
  assert.equal(gatewayAuth.statusCode, 204);

  const wrongAudience = await app.inject({
    method: 'GET',
    url: '/api/reviews/probe',
    headers: { cookie: `${GATEWAY_COOKIE}=${gatewayToken}` },
  });
  assert.equal(wrongAudience.statusCode, 401);

  const fullSessionOnGateway = await app.inject({
    method: 'GET',
    url: '/api/gateway/authz',
    headers: { cookie: `${SESSION_COOKIE}=${session.id}` },
  });
  assert.equal(fullSessionOnGateway.statusCode, 401);

  const cockpitApi = await app.inject({
    method: 'GET',
    url: '/api/reviews/probe',
    headers: { cookie: `${SESSION_COOKIE}=${session.id}` },
  });
  assert.equal(cockpitApi.statusCode, 200);
});

test('SEC-COOKIE-04: auth/state мигрирует старую Domain-cookie без повторного логина', async (t) => {
  const store = await temporaryAuthStore(t);
  const session = store.createSession();
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(authPlugin, {
    authStore: store,
    tlsEnabled: false,
    trustProxy: '',
    internalToken: '',
    cliToken: '',
  });
  await app.register(authModule, {
    authStore: store,
    config: { publicDomain: 'example.test' },
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/auth/state',
    headers: {
      host: 'example.test',
      cookie: `${SESSION_COOKIE}=${session.id}`,
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().authenticated, true);
  const values = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie']
    : [response.headers['set-cookie']];
  assert.ok(values.some((value) => (
    value.startsWith(`${SESSION_COOKIE}=${session.id};`) && !/Domain=/i.test(value)
  )));
  assert.ok(values.some((value) => (
    value.startsWith(`${SESSION_COOKIE}=;`) && /Domain=example\.test/i.test(value)
  )));
  assert.ok(values.some((value) => (
    value.startsWith(`${GATEWAY_COOKIE}=`) && /Domain=example\.test/i.test(value)
  )));
});

test('SEC-COOKIE-05: Caddy вырезает служебные cookies перед backend стенда', async () => {
  const source = await readFile(
    new URL('../../deploy/gateway/bootstrap.sh', import.meta.url),
    'utf8',
  );
  assert.match(source, /header_up Cookie "[^"]*cockpit_sid=\[\^;\]\*" ""/);
  assert.match(source, /header_up Cookie "[^"]*cockpit_gateway=\[\^;\]\*" ""/);
});
