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

test('contextCache идёт живьём в SSE, переживает F5 в active и возвращается с ответом', async (t) => {
  let release;
  let progressSeen;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release?.());
  const progress = new Promise((resolve) => { progressSeen = resolve; });
  const contextCache = {
    scope: 'request', status: 'reported', readTokens: 90, writeTokens: 7, uncachedTokens: 3,
  };
  const executor = {
    id: 'claude',
    async run(options) {
      options.onProgress(5, { contextTokens: 100, contextCache });
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
  const active = await app.inject({ method: 'GET', url: '/api/chat/active' });
  assert.equal(active.statusCode, 200);
  assert.deepEqual(active.json().active[0]?.contextCache, contextCache);

  release();
  const result = await running;
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().contextCache, contextCache);
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
  assert.equal(run.json().error, 'kimi_session_reset_failed');
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
  assert.equal(swallowed.json().error, 'kimi_empty_response');
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
  assert.ok(briefed.endsWith('продолжай'), 'сообщение пользователя остаётся последним');

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
