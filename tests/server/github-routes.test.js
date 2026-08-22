import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import githubModule from '../../server/src/modules/github/index.js';
import { GITHUB_WEBHOOK_BODY_LIMIT } from '../../server/src/lib/github/webhook.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const STATUS = {
  configured: true,
  state: 'connected',
  repositoryId: '123456',
  fullName: 'acme/support',
  connectedAt: 1786276800000,
  connection: 'connected',
  reason: null,
  cleanupPending: false,
};

async function fixture(t, { enabled = true, connectionOver = {}, projects = ['cockpit'] } = {}) {
  const calls = {
    status: 0,
    connect: [],
    recheck: 0,
    disconnect: 0,
    forceForget: [],
    webhook: [],
    rulesRead: 0,
    rulesWrite: [],
    agentSearchWrite: [],
    release: 0,
  };
  const events = [];
  const rules = [{
    repositoryId: '123456',
    project: 'cockpit',
    kind: 'bug',
    b24: { responsibleId: null, groupId: null, priority: 1 },
    autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
    agentSearch: false,
  }];
  const policyFingerprint = 'ghpol1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const connection = {
    async status() { calls.status += 1; return structuredClone(STATUS); },
    async connect(body) { calls.connect.push(body); return structuredClone(STATUS); },
    async recheck() { calls.recheck += 1; return structuredClone(STATUS); },
    async disconnect() { calls.disconnect += 1; return { ...STATUS, connection: 'disconnected' }; },
    async forceForget(body) { calls.forceForget.push(body); return { ...STATUS, connection: 'disconnected' }; },
    async handleWebhook(ingressRef, body, headers) {
      calls.webhook.push({ ingressRef, body, headers });
      return { accepted: true, kind: 'issues.opened', inserted: true };
    },
    acquireInboxLease() {
      return {
        context: {
          repositoryId: '123456',
          rules: {
            async read() { calls.rulesRead += 1; return structuredClone(rules); },
            async readPolicy() {
              calls.rulesRead += 1;
              return { rules: structuredClone(rules), policyFingerprint };
            },
            async write(value, options) {
              calls.rulesWrite.push({ value, options });
              return structuredClone(value);
            },
            async setAgentSearch(value) {
              calls.agentSearchWrite.push(value);
              return {
                rules: [{ ...structuredClone(rules[0]), agentSearch: value.enabled }],
                policyFingerprint: 'ghpol1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              };
            },
          },
        },
        isCurrent: () => true,
        release() { calls.release += 1; },
      };
    },
    ...connectionOver,
  };
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', (id) => id === 'github' && enabled);
  app.decorate('sse', { broadcast: (name, payload) => events.push({ name, payload }) });
  app.register(githubModule, { connection, listProjects: async () => projects });
  await app.ready();
  t.after(() => app.close());
  return { app, calls, events, connection };
}

test('status — direct fixed provider DTO без cache и credentials', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject({ method: 'GET', url: '/api/github/status' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json(), STATUS);
  assert.equal(calls.status, 1);
  for (const forbidden of ['token', 'secret', 'ingressRef', 'hookId', 'accountRef']) {
    assert.equal(response.body.includes(forbidden), false);
  }
});

test('connect принимает exact owner/repo/token и публикует lifecycle event после успеха', async (t) => {
  const { app, calls, events } = await fixture(t);
  const body = { owner: 'acme', repo: 'support', token: 'github_pat_secret_value_1234' };
  const response = await app.inject({ method: 'POST', url: '/api/github/connect', payload: body });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.connect, [body]);
  assert.deepEqual(events, [{
    name: 'inbox-changed',
    payload: { itemRef: null, channel: 'github', status: 'provider_connecting', taskId: null },
  }]);

  for (const invalid of [
    { ...body, unknown: true },
    { owner: 'acme', repository: 'support', token: body.token },
    null,
  ]) {
    const rejected = await app.inject({ method: 'POST', url: '/api/github/connect', payload: invalid });
    assert.equal(rejected.statusCode, 400);
  }
  assert.equal(calls.connect.length, 1);
});

test('recheck/disconnect требуют пустое exact body и делегируются раздельно', async (t) => {
  const { app, calls, events } = await fixture(t);
  assert.equal((await app.inject({ method: 'POST', url: '/api/github/recheck', payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/github/disconnect', payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/github/recheck', payload: { x: 1 } })).statusCode, 400);
  assert.equal(calls.recheck, 1);
  assert.equal(calls.disconnect, 1);
  assert.deepEqual(events.map((event) => event.payload.status), [
    'provider_rechecked', 'provider_disconnected',
  ]);
});

test('force-forget доступен только с exact явным подтверждением orphan hook', async (t) => {
  const { app, calls } = await fixture(t);
  for (const payload of [{}, { confirmOrphanHook: false }, { confirmOrphanHook: true, extra: 1 }]) {
    const response = await app.inject({ method: 'POST', url: '/api/github/force-forget', payload });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'github_force_forget_confirmation');
  }
  const accepted = await app.inject({
    method: 'POST', url: '/api/github/force-forget', payload: { confirmOrphanHook: true },
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(calls.forceForget, [{ confirmOrphanHook: true }]);
});

test('rules читаются offline с fingerprint, а запись требует connected и повторный generation check', async (t) => {
  let current = true;
  const { app, calls } = await fixture(t, {
    connectionOver: {
      acquireInboxLease() {
        return {
          context: {
            repositoryId: '123456',
            rules: {
              async readPolicy() {
                calls.rulesRead += 1;
                return {
                  rules: [],
                  policyFingerprint: 'ghpol1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                };
              },
              async write(value, options) {
                calls.rulesWrite.push({ value, options });
                current = false;
                return value;
              },
            },
          },
          isCurrent: () => current,
          release() { calls.release += 1; },
        };
      },
    },
  });
  const read = await app.inject({ method: 'GET', url: '/api/github/rules' });
  assert.deepEqual(read.json(), {
    rules: [],
    policyFingerprint: 'ghpol1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  const body = {
    repositoryId: '123456',
    rules: [{ repositoryId: '123456', project: 'cockpit', kind: 'bug' }],
  };
  const write = await app.inject({ method: 'PUT', url: '/api/github/rules', payload: body });
  assert.equal(write.statusCode, 409);
  assert.equal(write.json().error, 'github_account_changed');
  assert.deepEqual(calls.rulesWrite, [{ value: body.rules, options: { projects: ['cockpit'] } }]);
  assert.equal(calls.release, 2);
});

test('agentSearch имеет отдельный explicit CAS endpoint и не меняет human rule', async (t) => {
  const { app, calls, events } = await fixture(t);
  const payload = {
    repositoryId: '123456',
    expectedPolicyFingerprint: 'ghpol1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    enabled: true,
  };
  const response = await app.inject({
    method: 'PUT',
    url: '/api/github/rules/agent-search',
    payload,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().rules[0].agentSearch, true);
  assert.equal(
    response.json().policyFingerprint,
    'ghpol1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  );
  assert.deepEqual(calls.agentSearchWrite, [{
    enabled: true,
    expectedPolicyFingerprint: payload.expectedPolicyFingerprint,
  }]);
  assert.deepEqual(calls.rulesWrite, []);
  assert.equal(events.at(-1)?.payload?.status, 'agent_search');
});

test('agentSearch endpoint fail-closed отклоняет stale fingerprint и malformed opt-in', async (t) => {
  const stale = Object.assign(new Error('stale'), {
    code: 'github_rules_stale_policy',
    statusCode: 409,
  });
  const { app, calls } = await fixture(t, {
    connectionOver: {
      acquireInboxLease() {
        return {
          context: {
            repositoryId: '123456',
            rules: {
              async setAgentSearch(value) {
                calls.agentSearchWrite.push(value);
                throw stale;
              },
            },
          },
          isCurrent: () => true,
          release() { calls.release += 1; },
        };
      },
    },
  });
  const base = {
    repositoryId: '123456',
    expectedPolicyFingerprint: 'ghpol1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    enabled: false,
  };
  const response = await app.inject({
    method: 'PUT', url: '/api/github/rules/agent-search', payload: base,
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'github_rules_stale_policy');

  for (const payload of [
    { ...base, enabled: 'true' },
    { ...base, expectedPolicyFingerprint: 'bad' },
    { ...base, extra: true },
  ]) {
    const rejected = await app.inject({
      method: 'PUT', url: '/api/github/rules/agent-search', payload,
    });
    assert.equal(rejected.statusCode, 400);
  }
  assert.equal(calls.agentSearchWrite.length, 1);
});

test('human rules PUT не может пронести agentSearch в общий allowlist payload', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject({
    method: 'PUT',
    url: '/api/github/rules',
    payload: {
      repositoryId: '123456',
      rules: [{
        repositoryId: '123456',
        project: 'cockpit',
        kind: 'bug',
        agentSearch: true,
      }],
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'invalid_request');
  assert.deepEqual(calls.rulesWrite, []);
  assert.equal(calls.status, 0);
});

test('rules write запрещён disconnected до lease и store', async (t) => {
  const { app, calls } = await fixture(t, {
    connectionOver: {
      async status() { calls.status += 1; return { ...STATUS, connection: 'disconnected' }; },
    },
  });
  const response = await app.inject({
    method: 'PUT',
    url: '/api/github/rules',
    payload: { repositoryId: '123456', rules: [] },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'github_not_connected');
  assert.deepEqual(calls.rulesWrite, []);
  assert.equal(calls.release, 1);
});

test('stale repository CAS не может очистить rules нового account даже пустым массивом', async (t) => {
  const { app, calls } = await fixture(t, {
    connectionOver: {
      acquireInboxLease() {
        return {
          context: {
            repositoryId: '999999',
            rules: {
              async read() { return []; },
              async write(value, options) {
                calls.rulesWrite.push({ value, options });
                return value;
              },
            },
          },
          isCurrent: () => true,
          release() { calls.release += 1; },
        };
      },
    },
  });
  const response = await app.inject({
    method: 'PUT',
    url: '/api/github/rules',
    payload: { repositoryId: '123456', rules: [] },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'github_account_changed');
  assert.deepEqual(calls.rulesWrite, []);
  assert.equal(calls.status, 0, 'owner CAS проверяется до первого await control-plane');
  assert.equal(calls.release, 1);
});

test('webhook получает raw Buffer, остаётся публичным path и отвечает 202', async (t) => {
  const { app, calls } = await fixture(t);
  const raw = Buffer.from('{"action":"opened","body":"точные байты"}', 'utf8');
  const response = await app.inject({
    method: 'POST',
    url: '/hooks/github/opaque-ref',
    headers: { 'content-type': 'application/json', 'x-test': 'yes' },
    payload: raw,
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { accepted: true, kind: 'issues.opened', inserted: true });
  assert.equal(calls.webhook.length, 1);
  assert.equal(calls.webhook[0].ingressRef, 'opaque-ref');
  assert.ok(Buffer.isBuffer(calls.webhook[0].body));
  assert.deepEqual(calls.webhook[0].body, raw);
});

test('выключенный plugin закрывает control-plane и ingress до любых вызовов', async (t) => {
  const { app, calls } = await fixture(t, { enabled: false });
  const control = await app.inject({ method: 'GET', url: '/api/github/status' });
  const ingress = await app.inject({
    method: 'POST',
    url: '/hooks/github/ref',
    headers: { 'content-type': 'application/json' },
    payload: Buffer.from('{}'),
  });
  assert.equal(control.statusCode, 404);
  assert.equal(control.json().error, 'plugin_disabled');
  assert.equal(ingress.statusCode, 410);
  assert.deepEqual(calls.webhook, []);
  assert.equal(calls.status, 0);
});

test('webhook ошибки не отражают секреты и signature failure становится 401', async (t) => {
  const { app } = await fixture(t, {
    connectionOver: {
      async handleWebhook() {
        throw Object.assign(new Error('github_pat_secret_value webhook-secret'), {
          code: 'github_signature_invalid',
        });
      },
    },
  });
  const response = await app.inject({
    method: 'POST', url: '/hooks/github/ref',
    headers: { 'content-type': 'application/json' }, payload: Buffer.from('{}'),
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, 'github_signature_invalid');
  assert.ok(!response.body.includes('github_pat_secret_value'));
  assert.ok(!response.body.includes('webhook-secret'));
});

test('raw parser ограничивает webhook body независимо от общего лимита Fastify', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/hooks/github/ref',
    headers: { 'content-type': 'application/json' },
    payload: Buffer.alloc(GITHUB_WEBHOOK_BODY_LIMIT + 1, 0x20),
  });
  assert.equal(response.statusCode, 413);
  assert.deepEqual(calls.webhook, []);
});
