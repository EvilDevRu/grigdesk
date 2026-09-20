import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ChatSessionBindingStore } from '../../server/src/lib/chat/sessionBindingStore.ts';
import chatModule from '../../server/src/modules/chat/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-binding-capability-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  let auth = 'auth-a';
  let security = 'security-a';
  let serial = 0;
  const executor = {
    id: 'sidecar-test',
    sessionBinding: {
      authProfileId: () => auth,
      securityProfile: () => security,
    },
    async run(options) {
      calls.push({ sessionId: options.sessionId, model: options.model });
      const sessionId = options.sessionId || `provider-session-${++serial}`;
      await options.onSessionCreated(sessionId);
      return { reply: `ok-${calls.length}`, sessionId, steps: [] };
    },
  };
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  const config = {
    chatsDir: path.join(root, 'chats'),
    chatStoreLegacyPath: path.join(root, 'legacy.json'),
    chatBindingsDir: path.join(root, 'bindings'),
    rootDir: root,
    factoryHome: root,
    agentsDir: path.join(root, 'agents'),
    port: 18141,
  };
  await app.register(chatModule, {
    config,
    factoryState: { async readEnv() { return {}; } },
    prefs: { read() { return { trustedDirectories: [], providerSettings: {} }; } },
    claudeAuth: null,
    internalToken: 'test',
    modelsRegistry: async () => ({
      'sidecar-test': [
        { id: 'model-a', efforts: [] },
        { id: 'model-b', efforts: [] },
      ],
    }),
    executorResolver: async (provider) => (provider === executor.id ? executor : null),
  });
  t.after(() => app.close());
  return {
    app,
    config,
    calls,
    setAuth(value) { auth = value; },
    setSecurity(value) { security = value; },
  };
}

async function save(app, model = 'model-a', revision = 0) {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: {
      id: 'capability-chat',
      modelRef: { provider: 'sidecar-test', model },
      messages: [],
      revision,
    } },
  });
  assert.equal(response.statusCode, 200);
}

async function run(app, payload = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'capability-chat',
      modelRef: { provider: 'sidecar-test', model: 'model-a' },
      message: 'synthetic',
      ...payload,
    },
  });
}

test('произвольный executor с sessionBinding получает CAS, resume и ротацию identity', async (t) => {
  const f = await fixture(t);
  await save(f.app);

  assert.equal((await run(f.app)).statusCode, 200);
  assert.equal((await run(f.app)).statusCode, 200);
  assert.deepEqual(f.calls.map((call) => call.sessionId), [null, 'provider-session-1']);

  f.setSecurity('security-b');
  assert.equal((await run(f.app)).statusCode, 200);
  assert.equal(f.calls[2].sessionId, null, 'смена security profile создаёт новую session');

  f.setAuth('auth-b');
  assert.equal((await run(f.app)).statusCode, 200);
  assert.equal(f.calls[3].sessionId, null, 'смена auth profile создаёт новую session');

  const binding = await new ChatSessionBindingStore({ dir: f.config.chatBindingsDir })
    .read('capability-chat');
  assert.equal(binding.provider, 'sidecar-test');
  assert.equal(binding.authProfileId, 'auth-b');
  assert.equal(binding.securityProfile, 'security-b');
});

test('client-owned sessionId отклоняется для capability без запуска executor-а', async (t) => {
  const f = await fixture(t);
  await save(f.app);
  const response = await run(f.app, { sessionId: 'forged-by-browser' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'forged_session');
  assert.equal(f.calls.length, 0);
});

test('generic reset инвалидирует binding capability, не проверяя id вендора', async (t) => {
  const f = await fixture(t);
  await save(f.app);
  await run(f.app);
  const before = await new ChatSessionBindingStore({ dir: f.config.chatBindingsDir })
    .read('capability-chat');
  assert.ok(before.sessionId);

  const response = await f.app.inject({
    method: 'POST',
    url: '/api/chat/session/reset',
    payload: {
      chatKey: 'capability-chat',
      modelRef: { provider: 'sidecar-test', model: 'model-a' },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().reset, true);
  const after = await new ChatSessionBindingStore({ dir: f.config.chatBindingsDir })
    .read('capability-chat');
  assert.equal(after.sessionId, null);
  assert.ok(after.generation > before.generation);
});
