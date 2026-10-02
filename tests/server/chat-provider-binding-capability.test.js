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
  let securityError = null;
  let serial = 0;
  let env = {};
  const executor = {
    id: 'sidecar-test',
    workdir: { switch: 'reseed', roots: 'single' },
    sessionBinding: {
      authProfileId: () => auth,
      securityProfile: () => {
        if (securityError) {
          throw securityError;
        }

        return security;
      },
    },
    // Новая сессия получает собственный id, а resume сохраняет прежний.
    // Тест видит каждый запуск и cwd, поэтому пустая выжимка не маскируется успехом.
    async run(options) {
      calls.push({
        sessionId: options.sessionId,
        model: options.model,
        cwd: options.cwd
      });
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
    factoryState: { async readEnv() {
      return env;
    } },
    prefs: {
      read() {
        return { providerSettings: {} };
      }
    },
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
    setSecurityError(value) {
      securityError = value;
    },
    setEnv(value) {
      env = value;
    },
  };
}

test('смена identity до summary не ротирует исходную сессию и не запускает пустую выжимку', async (t) => {
  const f = await fixture(t);

  await save(f.app);
  await run(f.app);

  const bindings = new ChatSessionBindingStore({ dir: f.config.chatBindingsDir });
  const before = await bindings.read('capability-chat');
  const directory = path.join(f.config.rootDir, 'next');

  await fs.mkdir(directory);
  f.setSecurity('security-b');

  const candidate = { taskId: null, workdir: { kind: 'path', path: directory } };
  const preview = await f.app.inject({
    method: 'POST',
    url: '/api/chat/workdir/preview',
    payload: { chatKey: 'capability-chat', candidate },
  });

  assert.equal(preview.statusCode, 200, preview.body);

  const response = await f.app.inject({
    method: 'POST',
    url: '/api/chat/workdir/change',
    payload: {
      chatKey: 'capability-chat',
      ...candidate,
      operationId: 'changed-identity',
      transfer: 'summary',
      expectedRevision: preview.json().revision,
      expectedWorkspaceKey: preview.json().workspaceKey,
    },
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'workdir_origin_changed');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await bindings.read('capability-chat'), before);

  const stored = (await f.app.inject('/api/chat/store/chat/capability-chat')).json().chat;

  assert.deepEqual(stored.workdir, { kind: 'cockpit' });
  assert.equal(stored.sessionId, before.sessionId);

  const compact = await f.app.inject({
    method: 'POST',
    url: '/api/chat/compact',
    payload: { chatKey: 'capability-chat', sessionId: before.sessionId },
  });

  assert.equal(compact.statusCode, 409, compact.body);
  assert.equal(compact.json().error, 'workdir_origin_changed');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await bindings.read('capability-chat'), before);
});

async function save(app, model = 'model-a', revision = 0, fields = {}) {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: {
      id: 'capability-chat',
      modelRef: { provider: 'sidecar-test', model },
      messages: [],
      revision,
        ...fields,
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

test('недоступный профиль исполнителя отклоняет ход без новой сессии и потери памяти', async (t) => {
  const f = await fixture(t);

  await save(f.app);
  assert.equal((await run(f.app)).statusCode, 200);

  // Код адаптера с его id в префиксе — безопасная причина; прочие ошибки текст не раскрывают.
  f.setSecurityError(Object.assign(new Error('Публикация runtime Cockpit не завершена'), {
    code: 'sidecar-test_runtime_publish_pending',
  }));

  const refused = await run(f.app);

  assert.equal(refused.statusCode, 503);
  assert.equal(refused.json().error, 'executor_unavailable');
  assert.match(refused.json().message, /Публикация runtime/u);

  f.setSecurityError(Object.assign(new Error('ENOENT /private/fixture/path'), { code: 'ENOENT' }));

  const hidden = await run(f.app);

  assert.equal(hidden.statusCode, 503);
  assert.doesNotMatch(hidden.json().message, /private/u);
  assert.equal(f.calls.length, 1, 'исполнитель не запускался');

  f.setSecurityError(null);
  assert.equal((await run(f.app)).statusCode, 200);
  assert.equal(f.calls[1].sessionId, 'provider-session-1', 'прежняя сессия продолжается');
});

test('смена профиля исполнителя оставляет заметку о новой сессии', async (t) => {
  const f = await fixture(t);

  await save(f.app);
  assert.equal((await run(f.app)).statusCode, 200);
  f.setSecurity('security-b');

  const rotated = await run(f.app);

  assert.equal(rotated.statusCode, 200);
  assert.match(rotated.json().reply, /профиль исполнителя изменился/u);
  assert.equal(f.calls[1].sessionId, null);
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

test('compact после смены cwd задачи ждёт подтверждения и сохраняет старую память', async (t) => {
  const f = await fixture(t);
  const first = path.join(f.config.rootDir, 'first');
  const second = path.join(f.config.rootDir, 'second');
  const env = {
    WORKSPACE_MODE: 'isolated',
    REPO_COUNT: '1',
    REPO_0_NAME: 'app',
    REPO_0_SOURCE: f.config.rootDir,
    REPO_0_WT: first,
    REPO_0_BRANCH: 'task-12',
  };

  await Promise.all([first, second].map((dir) => fs.mkdir(dir)));
  f.setEnv(env);
  await save(f.app, 'model-a', 0, { taskId: '12' });

  const initial = await f.app.inject({
    method: 'POST',
    url: '/api/tasks/12/chat',
    payload: { chatKey: 'capability-chat', message: 'Запомни разговор' },
  });

  assert.equal(initial.statusCode, 200, initial.body);

  const bindings = new ChatSessionBindingStore({ dir: f.config.chatBindingsDir });
  const before = await bindings.read('capability-chat');

  f.setEnv({ ...env, REPO_0_WT: second });

  const preview = await f.app.inject({
    method: 'POST',
    url: '/api/chat/workdir/preview',
    payload: { chatKey: 'capability-chat' },
  });

  assert.equal(preview.json().transfer, 'reseed');

  // Оба поколения клиента получают отказ: отсутствие ключа у старого compact
  // тоже не разрешает ротировать binding и сжимать пустой разговор в новой папке.
  for (const workspaceKey of [undefined, preview.json().workspaceKey]) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/tasks/12/compact',
      payload: {
        chatKey: 'capability-chat',
        sessionId: before.sessionId,
        workspaceKey,
      },
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'workdir_transfer_required');
  }

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].cwd, first);
  assert.deepEqual(await bindings.read('capability-chat'), before);
});
