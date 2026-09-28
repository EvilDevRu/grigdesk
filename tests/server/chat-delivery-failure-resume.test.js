// Ход, оборванный самим CLI (сеть, лимит), раньше приезжал в окно как текст с просьбой
// набрать «Продолжай» руками, а кнопка «Продолжить ход» была только у перезапуска
// сервера. Здесь проверяется контракт ответа: сбой доставки помечается той же меткой
// прерывания, несёт ленту и id сессии, а обычный ответ метки не получает.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import chatModule from '../../server/src/modules/chat/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const CLI_SAID = 'API Error: You\'ve hit your weekly limit · resets Sep 18, 7am';

async function apiFixture(t, { executor }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-chat-cut-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  app.decorate('shutdown', {
    get active() { return false; },
    register() {},
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
    port: 18141,
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
    modelsRegistry: async () => ({ claude: [{ id: 'claude-test', efforts: [] }] }),
    executorResolver: async () => executor,
  });
  t.after(() => app.close());
  return { app };
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
        createdAt: Date.UTC(2026, 8, 1),
        updatedAt: Date.UTC(2026, 8, 1),
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

/** Исполнитель, чей ход закончился сообщением самого CLI: модель ответить не успела. */
function cutExecutor() {
  const steps = [{ k: 'text', text: 'работаю', at: 1 }];
  return {
    id: 'claude',
    async run(options) {
      await options.onSessionCreated?.('sess-cut');
      for (const step of steps) options.onStep?.(step);
      return { reply: CLI_SAID, sessionId: 'sess-cut', steps, deliveryFailure: true };
    },
  };
}

test('обрыв CLI: ответ помечен меткой прерывания, несёт ленту и сессию', async (t) => {
  const { app } = await apiFixture(t, { executor: cutExecutor() });
  await saveChat(app, 'cut-chat');

  const result = await startTurn(app, 'cut-chat');
  assert.equal(result.statusCode, 200);
  const body = result.json();
  assert.equal(body.interruptedBy, 'delivery_failure', 'по метке окно рисует «Продолжить ход»');
  assert.equal(body.deliveryFailure, true);
  assert.equal(body.sessionId, 'sess-cut', 'продолжение возможно только по сохранённой сессии');
  assert.equal(body.steps.length, 1, 'лента оборванного хода сохранена');
  assert.match(body.reply, /оборвал сам CLI/);
  assert.ok(body.reply.includes(CLI_SAID), 'слова CLI процитированы, а не выдуманы');
  assert.match(body.reply, /«Продолжить ход»/, 'текст ведёт к кнопке окна');
  assert.match(body.reply, /«Продолжай»/, 'каналу без кнопки (Telegram) остаётся слово');
});

test('обычный ответ агента метки прерывания не получает', async (t) => {
  const executor = {
    id: 'claude',
    async run(options) {
      await options.onSessionCreated?.('sess-ok');
      return { reply: 'Готово.', sessionId: 'sess-ok', steps: [] };
    },
  };
  const { app } = await apiFixture(t, { executor });
  await saveChat(app, 'ok-chat');

  const body = (await startTurn(app, 'ok-chat')).json();
  assert.equal(body.reply, 'Готово.');
  assert.equal(body.interruptedBy, undefined);
});
