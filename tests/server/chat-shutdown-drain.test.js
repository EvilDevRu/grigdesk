// Слив ходов на остановке сервера. Раньше SIGTERM убивал процесс мгновенно: живые
// сессии агентов умирали посреди хода, лента и id сессии терялись, а чат на первом
// ходе оставался вовсе без сессии. Здесь проверяется контракт слива: новые ходы
// получают 503, идущие прерываются как «стоп» с меткой причины, id сессии уходит окнам
// с первого события, а не ответивший на прерывание ход записывается в pending.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import chatModule from '../../server/src/modules/chat/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function apiFixture(t, { executor }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-chat-drain-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  const events = [];
  const drainSteps = [];
  app.decorate('sse', {
    broadcast(event, data) { events.push({ event, data }); },
  });
  // Координатор остановки подменён: тест сам зовёт зарегистрированный шаг слива.
  app.decorate('shutdown', {
    get active() { return false; },
    register(name, run) { drainSteps.push({ name, run }); },
    async begin() {},
    arm() {},
  });
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
    modelsRegistry: async () => ({ claude: [{ id: 'claude-test', efforts: [] }] }),
    executorResolver: async () => executor,
    shutdownGraceMs: 30,
    shutdownInterruptMs: 150,
  });
  t.after(() => app.close());
  const drain = async () => {
    assert.equal(drainSteps.length, 1, 'модуль чата регистрирует ровно один шаг слива');
    await drainSteps[0].run();
  };
  return { app, events, drain };
}

async function saveChat(app, id) {
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id,
        modelRef: { provider: 'claude', model: 'claude-test' },
        messages: [],
        createdAt: Date.UTC(2026, 7, 1),
        updatedAt: Date.UTC(2026, 7, 1),
        revision: 0,
      },
    },
  });
  assert.equal(saved.statusCode, 200);
}

function startTurn(app, chatKey) {
  return app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey,
      modelRef: { provider: 'claude', model: 'claude-test' },
      message: 'привет',
    },
  });
}

/** Исполнитель, который сообщает id сессии сразу и завершает ход только по прерыванию. */
function interruptibleExecutor(sessionId) {
  let started;
  const startedAt = new Promise((resolve) => { started = resolve; });
  const steps = [{ k: 'text', text: 'работаю', at: 1 }];
  const executor = {
    id: 'claude',
    async run(options) {
      await options.onSessionCreated?.(sessionId);
      for (const step of steps) options.onStep?.(step);
      started();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('Ход остановлен.'), { stopped: true, steps, sessionId }));
        }, { once: true });
      });
    },
  };
  return { executor, startedAt };
}

test('слив: id сессии уходит окнам сразу, ход прерывается с меткой, новые ходы получают 503', async (t) => {
  const { executor, startedAt } = interruptibleExecutor('sess-early');
  const { app, events, drain } = await apiFixture(t, { executor });
  await saveChat(app, 'drain-chat');

  const running = startTurn(app, 'drain-chat');
  await startedAt;

  const announced = events.find((entry) => entry.event === 'chat-session');
  assert.deepEqual(
    { chatKey: announced?.data.chatKey, sessionId: announced?.data.sessionId },
    { chatKey: 'drain-chat', sessionId: 'sess-early' },
    'id сессии рассылается с первого события хода, а не по его итогу',
  );

  await drain();

  const result = await running;
  assert.equal(result.statusCode, 200);
  const body = result.json();
  assert.equal(body.stopped, true);
  assert.equal(body.interruptedBy, 'server_shutdown');
  assert.equal(body.sessionId, 'sess-early');
  assert.equal(body.steps.length, 1, 'лента прерванного хода сохранена');
  assert.match(body.reply, /перезапуском сервера/);

  const refused = await startTurn(app, 'drain-chat');
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.json().error, 'server_restarting');

  const pending = await app.inject({ method: 'GET', url: '/api/chat/pending' });
  assert.deepEqual(pending.json().pending, [], 'ответ доставлен окну напрямую — pending пуст');
});

test('слив: зависший ход записывается в pending, поздний ответ снимает запись', async (t) => {
  let started;
  let release;
  const startedAt = new Promise((resolve) => { started = resolve; });
  const steps = [{ k: 'text', text: 'завис', at: 1 }];
  const executor = {
    id: 'claude',
    async run(options) {
      await options.onSessionCreated?.('sess-stuck');
      for (const step of steps) options.onStep?.(step);
      started();
      // Прерывание игнорируется: ход «завис» и закончится только по команде теста.
      return new Promise((resolve) => {
        release = () => resolve({ reply: 'Поздно, но готово.', sessionId: 'sess-stuck', steps });
      });
    },
  };
  const { app, events, drain } = await apiFixture(t, { executor });
  await saveChat(app, 'stuck-chat');

  const running = startTurn(app, 'stuck-chat');
  await startedAt;
  await drain();

  const pending = (await app.inject({ method: 'GET', url: '/api/chat/pending' })).json().pending;
  assert.equal(pending.length, 1, 'зависший ход записан в pending сервером');
  const [record] = pending;
  assert.equal(record.chatKey, 'stuck-chat');
  assert.equal(record.role, 'assistant');
  assert.equal(record.stopped, true);
  assert.equal(record.interruptedBy, 'server_shutdown');
  assert.equal(record.sessionId, 'sess-stuck');
  assert.deepEqual(record.steps, steps);
  assert.equal(record.userText, 'привет', 'вопрос человека сохранён рядом с ответом');
  assert.ok(events.some((entry) => entry.event === 'chat-orphan'), 'окна узнают о записи');

  release();
  const result = await running;
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().reply, 'Поздно, но готово.');
  const after = (await app.inject({ method: 'GET', url: '/api/chat/pending' })).json().pending;
  assert.deepEqual(after, [], 'настоящий ответ заменил запись «на память», дубля нет');
});
