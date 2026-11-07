import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { ChatTurnLocks } from '../../server/src/lib/chat/turnLocks.ts';
import { ChatSessionBindingStore } from '../../server/src/lib/chat/sessionBindingStore.ts';
import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { withChatImageHint } from '../../server/src/lib/chat/imageHint.ts';
import {
  KIMI_RETRY_CONTRACT,
  mayRetryEmptyRun,
} from '../../server/src/lib/chat/retryContract.ts';
import {
  KIMI_AUTH_PROFILE_ID,
  KIMI_SECURITY_PROFILE,
} from '../../server/src/lib/kimi/profile.ts';
import chatModule from '../../server/src/modules/chat/index.ts';
import { createClaudeTurnCollector } from '../../server/src/lib/executors/_claudeStream.ts';
import kimiExecutor from '../../server/src/lib/executors/kimi.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const kimiSessionBinding = {
  authProfileId: () => KIMI_AUTH_PROFILE_ID,
  securityProfile: () => KIMI_SECURITY_PROFILE,
};

/**
 * Поднимает чат-модуль с урезанной конфигурацией и подставным исполнителем.
 * withArtifacts добавляет временную папку артефактов, как у рабочего сервера.
 */
async function apiFixture(t, { executor = null, withArtifacts = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-chat-routing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  const events = [];
  app.decorate('sse', {
    broadcast(event, data) { events.push({ event, data }); },
  });
  let executorCalls = 0;
  const config = {
    chatsDir: path.join(root, 'chats'),
    chatStoreLegacyPath: path.join(root, 'legacy.json'),
    chatBindingsDir: path.join(root, 'bindings'),
    rootDir: root,
    factoryHome: root,
    port: 18140,
    ...(withArtifacts ? { artifactsDir: path.join(root, 'artifacts') } : {}),
  };

  await app.register(chatModule, {
    config,
    factoryState: { async readEnv() { return {}; } },
    prefs: {
      read() {
        return { providerSettings: {}, chatAutoCompactWindow: 0 };
      }
    },
    claudeAuth: null,
    internalToken: 'test',
    modelsRegistry: async () => ({
      claude: [{ id: 'claude-test', efforts: [] }],
      kimi: [{ id: 'kimi-test', efforts: [] }],
    }),
    executorResolver: async () => {
      executorCalls += 1;
      if (executor?.id === 'kimi' && !executor.sessionBinding) {
        return { ...executor, sessionBinding: kimiSessionBinding };
      }
      return executor;
    },
  });
  t.after(() => app.close());
  return { app, config, root, events, executorCalls: () => executorCalls };
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

/**
 * Полный цикл Kimi проходит настоящий chat API и дисковые binding/историю.
 * Подменён только исполнитель: первый ход, выжимка и продолжение воспроизводимы.
 */
async function kimiCompactFixture(t, outcome = 'summary') {
  const calls = [];
  const seed = 'Задача: продолжить проверку. Решение: сохранить рабочую выжимку.';
  const executor = {
    id: kimiExecutor.id,
    compaction: kimiExecutor.compaction,
    retryContract: kimiExecutor.retryContract,
    sessionBinding: kimiSessionBinding,
    /**
     * Второй вызов является сжатием существующей памяти; остальные создают сессию.
     * Stop и пустой ответ моделируются отдельно, без успешного результата compact.
     */
    async run(options) {
      calls.push({ message: options.message, sessionId: options.sessionId });

      if (calls.length === 2) {
        if (outcome === 'stopped') {
          throw Object.assign(new Error('Ход остановлен.'), {
            stopped: true,
            sessionId: options.sessionId,
            steps: [],
          });
        }

        return {
          reply: outcome === 'empty' ? '   ' : seed,
          sessionId: options.sessionId,
          steps: [],
        };
      }

      const sessionId = calls.length === 1 ? 'before-compact' : 'after-compact';

      await options.onSessionCreated(sessionId);

      return {
        reply: 'Готово.',
        sessionId,
        steps: [],
      };
    },
  };
  const f = await apiFixture(t, { executor });
  const chatKey = 'compact-chat';
  const modelRef = { provider: 'kimi', model: 'kimi-test' };

  await saveKimiChat(f.app, chatKey);

  const first = await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey,
      modelRef,
      message: 'Первый обычный ход.',
    },
  });

  assert.equal(first.statusCode, 200, first.body);

  const bindings = new ChatSessionBindingStore({ dir: f.config.chatBindingsDir });
  const before = await bindings.read(chatKey);

  assert.ok(before);
  assert.equal(before.sessionId, 'before-compact');

  const history = new ChatHistoryStore({ chatsDir: f.config.chatsDir });

  return {
    ...f,
    chatKey,
    modelRef,
    seed,
    calls,
    bindings,
    before,
    history,
    compact: () => f.app.inject({
      method: 'POST',
      url: '/api/chat/compact',
      payload: {
        chatKey,
        modelRef,
        sessionId: before.sessionId,
      },
    }),
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
  const runs = [];
  const { app, executorCalls } = await apiFixture(t, {
    executor: {
      id: 'claude',
      async run(options) {
        runs.push(options);

        return {
          reply: 'Новый ответ',
          sessionId: 'fresh-fixture-session',
          steps: [],
        };
      },
    },
  });
  const oldRef = { provider: 'missing', model: 'invented' };
  const messages = [
    {
      role: 'user',
      text: 'Сохранённая история',
      attachments: [{ id: 'fixture-image' }],
    },
    { role: 'assistant', text: 'Прежний ответ' },
  ];
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'route-chat',
        surface: 'embedded',
        modelRef: oldRef,
        sessionId: 'retired-fixture-session',
        pendingSeed: 'Старая память',
        contextTokens: 123,
        messages,
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
  assert.equal(runs.length, 0);

  const staleReset = await app.inject({
    method: 'POST',
    url: '/api/chat/session/reset',
    payload: { chatKey: 'route-chat', modelRef: { provider: 'claude', model: 'claude-test' } },
  });

  assert.equal(staleReset.statusCode, 409);
  assert.equal(staleReset.json().error, 'stale_chat_model');
  assert.equal(runs.length, 0);

  const reset = await app.inject({
    method: 'POST',
    url: '/api/chat/session/reset',
    payload: { chatKey: 'route-chat', modelRef: oldRef },
  });

  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().reset, true);

  const state = await app.inject({ method: 'GET', url: '/api/chat/store' });
  const current = state.json().sessions.find((chat) => chat.id === 'route-chat');

  assert.deepEqual(current.modelRef, oldRef);
  assert.deepEqual(current.messages, messages);
  assert.equal(current.sessionId, null);
  assert.equal(current.pendingSeed, '');
  assert.equal(current.contextTokens, 0);

  const chosen = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...current,
        modelRef: { provider: 'claude', model: 'claude-test' },
      },
    },
  });

  assert.equal(chosen.statusCode, 200);

  const next = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'route-chat',
      modelRef: { provider: 'claude', model: 'claude-test' },
      message: 'Продолжить с новой моделью',
    },
  });

  assert.equal(next.statusCode, 200);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].sessionId, null);

  const after = await app.inject({ method: 'GET', url: '/api/chat/store' });
  const history = after.json().sessions.find((chat) => chat.id === 'route-chat').messages;

  assert.deepEqual(history.slice(0, messages.length), messages);
});

test('contextCache идёт живьём в SSE, переживает F5 в active и возвращается с ответом', async (t) => {
  let release;
  let progressSeen;
  let emitProgress;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release?.());
  const progress = new Promise((resolve) => { progressSeen = resolve; });
  const contextCache = {
    scope: 'request', status: 'reported', readTokens: 90, writeTokens: 7, uncachedTokens: 3,
  };
  const executor = {
    id: 'claude',
    async run(options) {
      emitProgress = options.onProgress;
      options.onProgress(5, {
        contextTokens: 100, contextWindow: 256_000,
        contextMetric: 'active-input-v1', contextIsEstimate: false, contextCache,
      });
      progressSeen();
      await gate;
      return {
        reply: 'Готово.', sessionId: 'context-cache-session', contextTokens: 100,
        contextCache, steps: [],
      };
    },
  };
  const { app, events } = await apiFixture(t, { executor });
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'context-cache-chat',
        modelRef: { provider: 'claude', model: 'claude-test' },
        messages: [],
        createdAt: Date.UTC(2026, 7, 1),
        updatedAt: Date.UTC(2026, 7, 1),
        revision: 0,
      },
    },
  });
  assert.equal(saved.statusCode, 200);

  const running = app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'context-cache-chat',
      modelRef: { provider: 'claude', model: 'claude-test' },
      message: 'проверь кэш',
    },
  });
  await progress;

  const progressEvent = events.find((entry) => entry.event === 'chat-progress');
  assert.deepEqual(progressEvent?.data.contextCache, contextCache);
  assert.equal(progressEvent?.data.contextWindow, 256_000);
  assert.equal(progressEvent?.data.contextMetric, 'active-input-v1');
  assert.equal(progressEvent?.data.contextIsEstimate, false);
  const active = await app.inject({ method: 'GET', url: '/api/chat/active' });
  assert.equal(active.statusCode, 200);
  assert.deepEqual(active.json().active[0]?.contextCache, contextCache);
  assert.equal(active.json().active[0]?.contextWindow, 256_000);
  assert.equal(active.json().active[0]?.contextMetric, 'active-input-v1');

  emitProgress(6, { contextTokens: 0, contextWindow: 128_000, contextMetric: 'active-input-v1' });
  emitProgress(7);
  const zero = (await app.inject({ method: 'GET', url: '/api/chat/active' })).json().active[0];
  assert.equal(zero.contextTokens, 0, 'ноль переживает событие только с расходом вывода');
  assert.equal(zero.contextWindow, 128_000);
  assert.equal(Object.hasOwn(events.at(-1).data, 'contextTokens'), false);

  release();
  const result = await running;
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().contextCache, contextCache);
});

test('остановленный ход возвращает весь последний снимок, даже если ошибка его не несёт', async (t) => {
  const sample = {
    contextTokens: 0, contextWindow: 256_000,
    contextMetric: 'active-input-v1', contextIsEstimate: false,
  };
  const { app } = await apiFixture(t, { executor: {
    id: 'claude',
    async run(options) {
      options.onProgress(8, sample);
      throw Object.assign(new Error('Остановлен'), { stopped: true, sessionId: 'stopped-session' });
    },
  } });
  const saved = await app.inject({
    method: 'PUT', url: '/api/chat/store/chat', payload: { chat: {
      id: 'context-stop', modelRef: { provider: 'claude', model: 'claude-test' },
      messages: [], revision: 0,
    } },
  });
  assert.equal(saved.statusCode, 200);
  const response = await app.inject({
    method: 'POST', url: '/api/chat', payload: {
      chatKey: 'context-stop', modelRef: { provider: 'claude', model: 'claude-test' }, message: 'Проверь',
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().stopped, true);
  for (const [key, value] of Object.entries(sample)) {
    assert.equal(response.json()[key], value, key);
  }
});

test('Kimi forged sessionId отсекается до executor-а, resume берётся только из sidecar', async (t) => {
  const { app, executorCalls } = await apiFixture(t, { executor: {
    id: 'kimi',
    sessionBinding: kimiSessionBinding,
    async run() { assert.fail('forged session не должна доходить до run'); },
  } });
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
  assert.equal(executorCalls(), 1);
});

test('явный reset Kimi инвалидирует server-owned binding', async (t) => {
  const { app, config, root } = await apiFixture(t, { executor: {
    id: 'kimi', sessionBinding: kimiSessionBinding, async run() { return {}; },
  } });
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
  let resumedWith = 'not-called';
  const { app, config, root, executorCalls } = await apiFixture(t, { executor: {
    id: 'kimi',
    sessionBinding: kimiSessionBinding,
    async run(options) {
      resumedWith = options.sessionId;
      await options.onSessionCreated('fresh-session');
      return { reply: 'ok', sessionId: 'fresh-session', steps: [] };
    },
  } });
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

  assert.equal(run.statusCode, 200);
  assert.equal(resumedWith, null, 'инвалидированный id не участвует в resume');
  assert.ok(executorCalls() >= 2, 'capability проверена и ход дошёл до resolver-а');
  assert.equal((await bindings.read('stale-window-chat')).sessionId, 'fresh-session');
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
  assert.equal(run.json().error, 'provider_empty_response');
  assert.equal(run.json().sessionReset, true);
  assert.equal(runs, 1, 'после принятого prompt автоматического повтора нет');
  const binding = await new ChatSessionBindingStore({ dir: config.chatBindingsDir }).read('empty-run-chat');
  assert.equal(binding.sessionId, null);
});

test('пустой запуск объясняется в ленте отметкой повтора и остаётся в сохранённом ходе', async (t) => {
  const start = { k: 'start', model: 'claude-test', mode: 'auto' };
  let runs = 0;
  const executor = {
    id: 'claude',
    async run(options) {
      runs += 1;
      options.onStep?.({ ...start });
      // Первый запуск умер на старте: обращений к модели не было, ход пуст.
      if (runs === 1) return { reply: '', steps: [{ ...start }], emptyRun: true };
      options.onStep?.({ k: 'text', text: 'готово' });
      return { reply: 'готово', steps: [{ ...start }, { k: 'text', text: 'готово' }] };
    },
  };
  const { app, events } = await apiFixture(t, { executor });
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'empty-start-chat',
        modelRef: { provider: 'claude', model: 'claude-test' },
        messages: [],
        createdAt: Date.UTC(2026, 7, 1),
        updatedAt: Date.UTC(2026, 7, 1),
        revision: 0,
      },
    },
  });
  assert.equal(saved.statusCode, 200);

  const run = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'empty-start-chat',
      modelRef: { provider: 'claude', model: 'claude-test' },
      message: 'проверка повтора пустого запуска',
    },
  });

  assert.equal(run.statusCode, 200);
  assert.equal(runs, 2, 'пустой запуск повторяется ровно один раз');
  // Два «старта» подряд без объяснения читаются как дубль показа, поэтому между ними
  // обязана стоять отметка повтора — и живьём, и в сохранённой ленте.
  const steps = run.json().steps || [];
  assert.deepEqual(steps.map((step) => step.k), ['start', 'note', 'start', 'text']);
  assert.equal(steps[1].level, 'warn');
  assert.match(steps[1].text, /повторяю ход/);

  const notes = events
    .filter((entry) => entry.event === 'chat-step' && entry.data.step?.k === 'note');
  assert.equal(notes.length, 1);
  assert.match(notes[0].data.step.text, /повторяю ход/);
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
  assert.equal(run.json().error, 'provider_session_reset_failed');
  assert.equal(run.json().sessionResetFailed, true);
  const binding = await new ChatSessionBindingStore({ dir: config.chatBindingsDir }).read('reset-failure-chat');
  assert.equal(binding.sessionId, 'binding-session', 'несогласованный id не записан и не сброшен вслепую');
});

test('stop Kimi сохраняет отменённую session для resume (smoke 0.33.0: RESUME_OK)', async (t) => {
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
  assert.equal(run.json().sessionReset, false);
  assert.equal(run.json().sessionId, 'stopped-session');
  const binding = await new ChatSessionBindingStore({ dir: config.chatBindingsDir }).read('stopped-chat');
  assert.equal(binding.sessionId, 'stopped-session', 'binding переживает стоп: следующий ход делает resume');
});

test('resume после стопа; при проглатывании — инвалидация и досье в новой session', async (t) => {
  const received = [];
  const resumedWith = [];
  let call = 0;
  const executor = {
    id: 'kimi',
    retryContract: KIMI_RETRY_CONTRACT,
    async run(options) {
      call += 1;
      received.push(String(options.message || ''));
      resumedWith.push(options.sessionId || null);
      if (call === 1) {
        await options.onSessionCreated('session-1');
        const error = new Error('Ход остановлен.');
        error.stopped = true;
        error.sessionId = 'session-1';
        error.steps = [];
        throw error;
      }
      if (call === 2) {
        // Resume отменённой сессии «проглотил» prompt: end_turn без единого chunk/шага.
        return { reply: '', sessionId: 'session-1', steps: [], emptyRun: true, retryState: 'post_prompt' };
      }
      await options.onSessionCreated(`session-${call}`);
      return { reply: 'готово', sessionId: `session-${call}`, steps: [], cost: null };
    },
  };
  const { app, config } = await apiFixture(t, { executor });
  await saveKimiChat(app, 'brief-chat');

  const stopped = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'brief-chat',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
      model: 'kimi-test',
      message: 'первый prompt',
    },
  });
  assert.equal(stopped.json().stopped, true);
  assert.equal(stopped.json().sessionReset, false);
  assert.equal(stopped.json().sessionId, 'session-1');

  // Клиент сохранил остановленный ход в историю: флаг stopped + лента шагов.
  const historyPut = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'brief-chat',
        modelRef: { provider: 'kimi', model: 'kimi-test' },
        createdAt: Date.UTC(2026, 7, 1),
        updatedAt: Date.now(),
        revision: 1,
        messages: [
          { role: 'user', text: 'первый prompt' },
          {
            role: 'assistant', text: '⏹ Ход остановлен.', stopped: true,
            steps: [
              { k: 'start', model: 'kimi-test' },
              { k: 'tool', name: 'Edit', title: 'chat.js' },
              { k: 'res', ok: true, text: 'ok' },
              { k: 'tool', name: 'Bash', title: 'npm test' },
              { k: 'res', ok: false, text: '1 failing test' },
            ],
          },
        ],
      },
    },
  });
  assert.equal(historyPut.statusCode, 200);

  // Следующий ход делает resume той же session, но prompt «проглатывается».
  const swallowed = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'brief-chat',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
      model: 'kimi-test',
      message: 'продолжай',
    },
  });
  assert.equal(swallowed.statusCode, 500);
  assert.equal(swallowed.json().error, 'provider_empty_response');
  assert.equal(swallowed.json().sessionReset, true);
  assert.equal(resumedWith[1], 'session-1', 'после стопа ход делает resume той же session');
  assert.ok(!received[1].includes('[Досье прерванного хода]'), 'при живом binding досье не нужно');
  const binding = await new ChatSessionBindingStore({ dir: config.chatBindingsDir }).read('brief-chat');
  assert.equal(binding.sessionId, null, 'проглатывание инвалидирует binding');

  // Клиент дописал ошибку проглатывания: assistant-последним остаётся остановленный ход.
  const errorPut = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'brief-chat',
        modelRef: { provider: 'kimi', model: 'kimi-test' },
        createdAt: Date.UTC(2026, 7, 1),
        updatedAt: Date.now(),
        revision: 2,
        messages: [
          { role: 'user', text: 'первый prompt' },
          {
            role: 'assistant', text: '⏹ Ход остановлен.', stopped: true,
            steps: [
              { k: 'tool', name: 'Edit', title: 'chat.js' },
              { k: 'res', ok: false, text: '1 failing test' },
            ],
          },
          { role: 'user', text: 'продолжай' },
          { role: 'error', text: 'Kimi завершил ход без ответа. Сессия сброшена; повтори сообщение явно.' },
        ],
      },
    },
  });
  assert.equal(errorPut.statusCode, 200);

  // Повторное сообщение: session новая → досье передаёт, что успел сделать остановленный ход.
  const third = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'brief-chat',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
      model: 'kimi-test',
      message: 'продолжай',
    },
  });
  assert.equal(third.statusCode, 200);
  assert.equal(resumedWith[2], null, 'после инвалидации стартует новая session');
  const briefed = received[2] || '';
  assert.ok(briefed.includes('[Досье прерванного хода]'), 'досье подмешано в сообщение');
  assert.ok(briefed.includes('- Edit: chat.js'));
  assert.ok(briefed.includes('- Ошибка: 1 failing test'));
  assert.ok(briefed.endsWith(withChatImageHint('продолжай', '')),
    'подсказка следует за исходной просьбой');

  // Клиент дописал обычный ответ: досье одноразовое и дальше не подмешивается.
  const followupPut = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'brief-chat',
        modelRef: { provider: 'kimi', model: 'kimi-test' },
        createdAt: Date.UTC(2026, 7, 1),
        updatedAt: Date.now(),
        revision: 3,
        messages: [
          { role: 'user', text: 'первый prompt' },
          {
            role: 'assistant', text: '⏹ Ход остановлен.', stopped: true,
            steps: [{ k: 'tool', name: 'Edit', title: 'chat.js' }],
          },
          { role: 'user', text: 'продолжай' },
          { role: 'assistant', text: 'готово' },
        ],
      },
    },
  });
  assert.equal(followupPut.statusCode, 200);

  const fourth = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'brief-chat',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
      model: 'kimi-test',
      message: 'ещё вопрос',
    },
  });
  assert.equal(fourth.statusCode, 200);
  assert.ok(!(received[3] || '').includes('[Досье прерванного хода]'), 'досье одноразовое');
});

test('ход Kimi не получает общую папку артефактов: у него своя изоляция', async (t) => {
  const seen = [];
  const executor = {
    id: 'kimi',
    retryContract: KIMI_RETRY_CONTRACT,
    async run(options) {
      seen.push(options.extraDirs || []);
      await options.onSessionCreated('kimi-session');

      return {
        reply: 'готово',
        sessionId: 'kimi-session',
        steps: [],
        cost: null,
      };
    },
  };
  const { app, root } = await apiFixture(t, { executor, withArtifacts: true });

  await saveKimiChat(app, 'kimi-artifacts');

  const response = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'kimi-artifacts',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
      model: 'kimi-test',
      message: 'сделай снимок',
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].includes(path.join(root, 'artifacts')), false);
});


test('R1: ошибка Claude после message_start сохраняет замер прошлого хода', async (t) => {
  const previous = {
    contextTokens: 4200,
    contextMetric: 'active-input-v1',
    contextIsEstimate: false,
    contextCache: {
      scope: 'request',
      status: 'reported',
      uncachedTokens: 4200,
    },
  };
  const { app } = await apiFixture(t, { executor: {
    id: 'claude',
    async run(options) {
      const collector = createClaudeTurnCollector({ onProgress: options.onProgress });

      collector.push({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'failed-response' } },
      });

      throw new Error('fixture-before-context');
    },
  } });
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: {
      id: 'context-before-measurement',
      modelRef: { provider: 'claude', model: 'claude-test' },
      sessionId: 'previous-context-session',
      messages: [],
      revision: 0,
      ...previous,
    } },
  });

  assert.equal(saved.statusCode, 200);

  const response = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'context-before-measurement',
      modelRef: { provider: 'claude', model: 'claude-test' },
      message: 'Проверь',
    },
  });
  const state = await app.inject({ method: 'GET', url: '/api/chat/store' });
  const current = state.json().sessions.find((chat) => chat.id === 'context-before-measurement');

  assert.equal(response.statusCode, 500);
  assert.equal(response.json().message, 'fixture-before-context');

  for (const [key, value] of Object.entries(previous)) {
    assert.deepEqual(current[key], value, key);
  }
});

for (const accepted of [false, true]) {
  test(`R6: отказ записи контекста сохраняет исходную ошибку, accepted=${accepted}`, async (t) => {
    const { app } = await apiFixture(t, { executor: {
      id: 'claude',
      async run(options) {
        options.onProgress(8, { contextTokens: 3300, contextMetric: 'active-input-v1' });
        t.mock.method(ChatHistoryStore.prototype, 'patchExecution', async () => {
          throw new Error('fixture-history-unavailable');
        });

        throw Object.assign(new Error('fixture-original-turn-error'), { code: 'fixture_turn_failed' });
      },
    } });
    const warnings = t.mock.method(app.log, 'warn');

    await app.inject({
      method: 'PUT',
      url: '/api/chat/store/chat',
      payload: { chat: {
        id: 'context-write-error',
        modelRef: { provider: 'claude', model: 'claude-test' },
        messages: [],
        revision: 0,
      } },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {
        chatKey: 'context-write-error',
        modelRef: { provider: 'claude', model: 'claude-test' },
        message: 'Проверь',
        ...(accepted ? { turnId: 'turn-history-failure-0001' } : {}),
      },
    });

    if (accepted) {
      assert.equal(response.statusCode, 202);

      let pending;

      for (let attempt = 0; attempt < 100 && !pending; attempt += 1) {
        const result = await app.inject({ method: 'GET', url: '/api/chat/pending' });

        pending = result.json().pending.find((item) => item.turnId === 'turn-history-failure-0001');

        if (!pending) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      assert.equal(pending?.role, 'error');
      assert.equal(pending?.reply, 'fixture-original-turn-error');
    } else {
      assert.equal(response.statusCode, 500);
      assert.equal(response.json().message, 'fixture-original-turn-error');
      assert.equal(response.json().error, 'fixture_turn_failed');
    }

    assert.ok(warnings.mock.calls.some((call) => call.arguments[0]?.err === 'fixture-history-unavailable'));
  });
}

test('R6: ошибка без контекстного замера не пишет пустую правку истории', async (t) => {
  let writes = 0;
  const { app } = await apiFixture(t, { executor: {
    id: 'claude',
    async run() {
      t.mock.method(ChatHistoryStore.prototype, 'patchExecution', async () => {
        writes += 1;
      });

      throw new Error('fixture-no-context');
    },
  } });

  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: {
      id: 'empty-context-error',
      modelRef: { provider: 'claude', model: 'claude-test' },
      messages: [],
      revision: 0,
    } },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'empty-context-error',
      modelRef: { provider: 'claude', model: 'claude-test' },
      message: 'Проверь',
    },
  });

  assert.equal(response.statusCode, 500);
  assert.equal(response.json().message, 'fixture-no-context');
  assert.equal(writes, 0);
});

test('ошибка хода сохраняет последний контекст для повторного открытия чата', async (t) => {
  const { app } = await apiFixture(t, { executor: {
    id: 'claude',
    async run(options) {
      options.onProgress(8, { contextTokens: 3300, contextMetric: 'deepseek-web-usage' });

      throw new Error('fixture-turn-error');
    },
  } });
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: {
      id: 'context-error',
      modelRef: { provider: 'claude', model: 'claude-test' },
      messages: [],
      revision: 0,
    } },
  });

  assert.equal(saved.statusCode, 200);

  const response = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'context-error',
      modelRef: { provider: 'claude', model: 'claude-test' },
      message: 'Проверь',
    },
  });

  assert.equal(response.statusCode, 500);
  assert.equal(response.json().contextTokens, 3300);

  const state = await app.inject({ method: 'GET', url: '/api/chat/store' });
  const current = state.json().sessions.find((chat) => chat.id === 'context-error');

  assert.equal(current.contextTokens, 3300);
  assert.equal(response.json().message, 'fixture-turn-error');

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      turnId: 'turn-context-error-0001',
      chatKey: 'context-error',
      modelRef: { provider: 'claude', model: 'claude-test' },
      message: 'Повтори проверку',
    },
  });

  assert.equal(accepted.statusCode, 202);

  let pending;

  for (let attempt = 0; attempt < 100 && !pending; attempt += 1) {
    const result = await app.inject({ method: 'GET', url: '/api/chat/pending' });

    pending = result.json().pending.find((item) => item.turnId === 'turn-context-error-0001');

    if (!pending) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  assert.equal(pending?.role, 'error');
  assert.equal(pending?.contextTokens, 3300);
});


for (const stopped of [false, true]) {
  test(`снимок контекста переживает повтор прогресса и открытие, стоп=${stopped}`, async (t) => {
    const sample = {
      contextTokens: 3300,
      contextWindow: 262144,
      contextMetric: 'deepseek-web-usage',
      contextIsEstimate: false,
    };
    const { app, events } = await apiFixture(t, { executor: {
      id: 'claude',
      /**
       * Повтор прогресса передаёт тот же замер, а не добавочный расход.
       * Успех и остановка проверяют сохранение этого снимка общим путём.
       */
      async run(options) {
        options.onProgress(8, sample);
        options.onProgress(8, sample);

        if (stopped) {
          throw Object.assign(new Error('Остановлен'), { stopped: true });
        }

        return {
          reply: 'Готово',
          steps: [],
          sessionId: 'usage-session',
          ...sample
        };
      },
    } });
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/chat/store/chat',
      payload: { chat: {
        id: 'usage-roundtrip',
        modelRef: { provider: 'claude', model: 'claude-test' },
        messages: [],
        revision: 0,
      } },
    });

    assert.equal(saved.statusCode, 200);

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {
        chatKey: 'usage-roundtrip',
        modelRef: { provider: 'claude', model: 'claude-test' },
        message: 'Сверь метрики',
      },
    });
    const state = await app.inject({ method: 'GET', url: '/api/chat/store' });
    const current = state.json().sessions.find((chat) => chat.id === 'usage-roundtrip');

    assert.equal(response.statusCode, 200);

    for (const [key, value] of Object.entries(sample)) {
      assert.equal(response.json()[key], value);
      assert.equal(current[key], value);
    }

    assert.deepEqual(events.filter((entry) => entry.event === 'chat-progress')
      .map((entry) => [entry.data.tokens, entry.data.contextTokens]), [[8, 3300], [8, 3300]]);
  });
}

test('Kimi compact сохраняет выжимку, ротирует binding и начинает новую сессию', async (t) => {
  const f = await kimiCompactFixture(t);
  const response = await f.compact();

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].sessionId, f.before.sessionId);
  assert.match(f.calls[1].message, /^Сожми наш разговор в рабочую выжимку/u);
  assert.notEqual(f.calls[1].message, '/compact');
  assert.deepEqual(response.json().compact, { kind: 'summary', seed: f.seed });
  assert.equal(response.json().sessionId, null);
  assert.equal(response.json().contextTokens, 0);

  const rotated = await f.bindings.read(f.chatKey);
  const stored = await f.history.readOne(f.chatKey);

  assert.equal(rotated.sessionId, null);
  assert.equal(rotated.generation, f.before.generation + 1);
  assert.equal(stored.sessionId, null);
  assert.equal(stored.pendingSeed, f.seed);

  // Legacy-окно вклеивает сохранённую выжимку само; новый workdir-протокол
  // использует server claim. Здесь проверяется первый существующий путь.
  const message = `[Выжимка предыдущего разговора — продолжаем с этого места]\n${stored.pendingSeed}`
    + '\n[/Выжимка]\n\nПродолжай.';
  const next = await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: f.chatKey,
      modelRef: f.modelRef,
      sessionId: null,
      message,
    },
  });

  assert.equal(next.statusCode, 200, next.body);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].sessionId ?? null, null);
  assert.ok(f.calls[2].message.includes(f.seed));
  assert.equal(next.json().sessionId, 'after-compact');
  assert.equal((await f.bindings.read(f.chatKey)).sessionId, 'after-compact');
  assert.equal((await f.history.readOne(f.chatKey)).pendingSeed, '');
});

test('пустая выжимка Kimi не ротирует binding и не подтверждает сжатие', async (t) => {
  const f = await kimiCompactFixture(t, 'empty');
  const response = await f.compact();

  assert.equal(response.statusCode, 500, response.body);
  assert.match(response.body, /Исполнитель не вернул выжимку — контекст не сжат/u);
  assert.equal(response.json().compact, undefined);
  assert.equal(f.calls.length, 2);

  const after = await f.bindings.read(f.chatKey);
  const stored = await f.history.readOne(f.chatKey);

  assert.equal(after.sessionId, f.before.sessionId);
  assert.equal(after.generation, f.before.generation);
  assert.equal(stored.sessionId, f.before.sessionId);
  assert.equal(stored.pendingSeed || '', '');
});

test('остановленное сжатие Kimi сохраняет прежнюю session без успешного compact', async (t) => {
  const f = await kimiCompactFixture(t, 'stopped');
  const response = await f.compact();

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().stopped, true);
  assert.equal(response.json().compact, undefined);
  assert.equal(response.json().sessionId, f.before.sessionId);
  assert.equal(f.calls.length, 2);

  const after = await f.bindings.read(f.chatKey);
  const stored = await f.history.readOne(f.chatKey);

  assert.equal(after.sessionId, f.before.sessionId);
  assert.equal(after.generation, f.before.generation);
  assert.equal(stored.sessionId, f.before.sessionId);
  assert.equal(stored.pendingSeed || '', '');
});
