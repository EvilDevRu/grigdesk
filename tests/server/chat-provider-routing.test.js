import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { ChatTurnLocks } from '../../server/src/lib/chat/turn-locks.js';
import { ChatSessionBindingStore } from '../../server/src/lib/chat/session-binding-store.js';
import {
  KIMI_RETRY_CONTRACT,
  mayRetryEmptyRun,
} from '../../server/src/lib/chat/retry-contract.js';
import {
  KIMI_AUTH_PROFILE_ID,
  KIMI_SECURITY_PROFILE,
} from '../../server/src/lib/kimi/profile.js';
import chatModule from '../../server/src/modules/chat/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function apiFixture(t, { executor = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-chat-routing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  let executorCalls = 0;
  const config = {
    chatsDir: path.join(root, 'chats'),
    chatStoreLegacyPath: path.join(root, 'legacy.json'),
    chatBindingsDir: path.join(root, 'bindings'),
    rootDir: root,
    factoryHome: root,
    agentsDir: path.join(root, 'agents'),
    port: 18140,
  };
  await app.register(chatModule, {
    config,
    factoryState: { async readEnv() { return {}; } },
    prefs: { read() { return { trustedDirectories: [], providerSettings: {}, chatAutoCompactWindow: 0 }; } },
    claudeAuth: null,
    internalToken: 'test',
    modelsRegistry: async () => ({
      claude: [{ id: 'claude-test', efforts: [] }],
      kimi: [{ id: 'kimi-test', efforts: [] }],
    }),
    executorResolver: async () => { executorCalls += 1; return executor; },
  });
  t.after(() => app.close());
  return { app, config, root, executorCalls: () => executorCalls };
}

async function saveKimiChat(app, id = 'kimi-chat') {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id,
        modelRef: { provider: 'kimi', model: 'kimi-test' },
        messages: [],
        createdAt: Date.UTC(2026, 7, 1),
        updatedAt: Date.UTC(2026, 7, 1),
        revision: 0,
      },
    },
  });
  assert.equal(response.statusCode, 200);
  return response;
}

function kimiIdentity(root, chatKey) {
  return {
    chatKey,
    provider: 'kimi',
    cwdRealpath: root,
    model: 'kimi-test',
    authProfileId: KIMI_AUTH_PROFILE_ID,
    securityProfile: KIMI_SECURITY_PROFILE,
  };
}

test('session lock сериализует cross-chat resume одной provider-сессии', async () => {
  const locks = new ChatTurnLocks();
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = locks.run({ chatKey: 'a', provider: 'kimi', sessionId: 'same' }, async () => {
    order.push('first:start');
    await gate;
    order.push('first:end');
  });
  const second = locks.run({ chatKey: 'b', provider: 'kimi', sessionId: 'same' }, async () => {
    order.push('second:start');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first:start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
});

test('разные chat/session scopes выполняются параллельно', async () => {
  const locks = new ChatTurnLocks();
  const starts = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const jobs = [
    locks.run({ chatKey: 'a', provider: 'kimi', sessionId: 'one' }, async () => { starts.push('a'); await gate; }),
    locks.run({ chatKey: 'b', provider: 'kimi', sessionId: 'two' }, async () => { starts.push('b'); await gate; }),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(new Set(starts), new Set(['a', 'b']));
  release();
  await Promise.all(jobs);
});

test('Kimi retry разрешён только до подтверждённого prompt', () => {
  const kimi = { retryContract: KIMI_RETRY_CONTRACT };
  assert.equal(mayRetryEmptyRun(kimi, { emptyRun: true, retryState: 'pre_prompt' }), true);
  assert.equal(mayRetryEmptyRun(kimi, { emptyRun: true, retryState: 'prompt_accepted' }), false);
  assert.equal(mayRetryEmptyRun(kimi, { emptyRun: true, retryState: 'ambiguous_outcome' }), false);
  assert.equal(mayRetryEmptyRun(kimi, { emptyRun: true, retryState: 'pre_prompt' }, { compact: true }), false);
});

test('chat API не принимает client-owned surface и не запускает unknown model/provider', async (t) => {
  const { app, executorCalls } = await apiFixture(t);
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'route-chat',
        surface: 'embedded',
        modelRef: { provider: 'missing', model: 'invented' },
        messages: [],
        createdAt: Date.UTC(2026, 7, 1),
        updatedAt: Date.UTC(2026, 7, 1),
        revision: 0,
      },
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().surface, 'chats');

  const run = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'route-chat',
      modelRef: { provider: 'missing', model: 'invented' },
      model: 'invented',
      message: 'не запускать',
    },
  });
  assert.equal(run.statusCode, 400);
  assert.equal(run.json().error, 'unknown_provider');
  assert.equal(executorCalls(), 0);
});

test('Kimi forged sessionId отсекается до executor-а, resume берётся только из sidecar', async (t) => {
  const { app, executorCalls } = await apiFixture(t);
  const saved = await saveKimiChat(app);
  assert.deepEqual(saved.json().modelRef, { provider: 'kimi', model: 'kimi-test' });

  const forged = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'kimi-chat',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
      model: 'kimi-test',
      sessionId: 'client-picked-session',
      message: 'не запускать',
    },
  });
  assert.equal(forged.statusCode, 400);
  assert.equal(forged.json().error, 'forged_session');
  assert.equal(executorCalls(), 0);
});

test('явный reset Kimi инвалидирует server-owned binding', async (t) => {
  const { app, config, root } = await apiFixture(t);
  await saveKimiChat(app, 'reset-chat');
  const bindings = new ChatSessionBindingStore({ dir: config.chatBindingsDir });
  const live = await bindings.compareAndSwap({
    ...kimiIdentity(root, 'reset-chat'),
    sessionId: 'provider-session-before-reset',
  });

  const reset = await app.inject({
    method: 'POST',
    url: '/api/chat/session/reset',
    payload: {
      chatKey: 'reset-chat',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
    },
  });

  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().reset, true);
  assert.equal(reset.json().generation, live.generation + 1);
  const invalidated = await bindings.read('reset-chat');
  assert.equal(invalidated.sessionId, null);
  assert.equal(invalidated.generation, live.generation + 1);
});

test('старый client sessionId после явной инвалидации игнорируется, а не оживляет resume', async (t) => {
  const { app, config, root, executorCalls } = await apiFixture(t);
  await saveKimiChat(app, 'stale-window-chat');
  const bindings = new ChatSessionBindingStore({ dir: config.chatBindingsDir });
  const live = await bindings.compareAndSwap({
    ...kimiIdentity(root, 'stale-window-chat'),
    sessionId: 'old-window-session',
  });
  await bindings.rotate(live, live.generation);

  const run = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'stale-window-chat',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
      model: 'kimi-test',
      sessionId: 'old-window-session',
      message: 'executor здесь является тестовой заглушкой',
    },
  });

  assert.equal(run.statusCode, 400);
  assert.equal(run.json().error, 'unknown_provider');
  assert.equal(executorCalls(), 1, 'запрос прошёл проверку ownership и дошёл до resolver-а');
  assert.equal((await bindings.read('stale-window-chat')).sessionId, null);
});

test('пустой Kimi-ход после принятого prompt не повторяется и сбрасывает binding', async (t) => {
  let runs = 0;
  const executor = {
    id: 'kimi',
    retryContract: KIMI_RETRY_CONTRACT,
    async run(options) {
      runs += 1;
      await options.onSessionCreated('empty-run-session');
      return {
        reply: '',
        steps: [],
        sessionId: 'empty-run-session',
        emptyRun: true,
        retryState: 'post_prompt',
      };
    },
  };
  const { app, config } = await apiFixture(t, { executor });
  await saveKimiChat(app, 'empty-run-chat');

  const run = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'empty-run-chat',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
      model: 'kimi-test',
      message: 'тестовый prompt без внешней модели',
    },
  });

  assert.equal(run.statusCode, 500);
  assert.equal(run.json().error, 'kimi_empty_response');
  assert.equal(run.json().sessionReset, true);
  assert.equal(runs, 1, 'после принятого prompt автоматического повтора нет');
  const binding = await new ChatSessionBindingStore({ dir: config.chatBindingsDir }).read('empty-run-chat');
  assert.equal(binding.sessionId, null);
});

test('сбой инвалидации Kimi binding блокирует дальнейший ход вместо опасного resume', async (t) => {
  const executor = {
    id: 'kimi',
    retryContract: KIMI_RETRY_CONTRACT,
    async run(options) {
      await options.onSessionCreated('binding-session');
      return {
        reply: '',
        steps: [],
        // Несогласованный id имитирует повреждение runtime-контракта: сбрасывать
        // неизвестную generation молча нельзя, но продолжать её тоже нельзя.
        sessionId: 'unexpected-session',
        emptyRun: true,
        retryState: 'post_prompt',
      };
    },
  };
  const { app, config } = await apiFixture(t, { executor });
  await saveKimiChat(app, 'reset-failure-chat');

  const run = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'reset-failure-chat',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
      model: 'kimi-test',
      message: 'тестовая реплика',
    },
  });

  assert.equal(run.statusCode, 500);
  assert.equal(run.json().error, 'kimi_session_reset_failed');
  assert.equal(run.json().sessionResetFailed, true);
  const binding = await new ChatSessionBindingStore({ dir: config.chatBindingsDir }).read('reset-failure-chat');
  assert.equal(binding.sessionId, 'binding-session', 'несогласованный id не записан и не сброшен вслепую');
});

test('stop Kimi возвращает sessionReset и не оставляет отменённую session для resume', async (t) => {
  const executor = {
    id: 'kimi',
    retryContract: KIMI_RETRY_CONTRACT,
    async run(options) {
      await options.onSessionCreated('stopped-session');
      const error = new Error('Ход остановлен.');
      error.stopped = true;
      error.sessionId = 'stopped-session';
      error.steps = [];
      throw error;
    },
  };
  const { app, config } = await apiFixture(t, { executor });
  await saveKimiChat(app, 'stopped-chat');

  const run = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'stopped-chat',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
      model: 'kimi-test',
      message: 'тестовый prompt без внешней модели',
    },
  });

  assert.equal(run.statusCode, 200);
  assert.equal(run.json().stopped, true);
  assert.equal(run.json().sessionReset, true);
  assert.equal(run.json().sessionId, null);
  const binding = await new ChatSessionBindingStore({ dir: config.chatBindingsDir }).read('stopped-chat');
  assert.equal(binding.sessionId, null);
});
