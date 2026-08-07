// Пояснение к отказу: модалка «Доработать»/«Отклонить» шлёт comment, и сервер вкладывает
// его в deny-message агенту (тот же канал, что у ответов на вопросы). Без пояснения —
// прежний дефолтный текст. У kimi ACP outcome текста не несёт: сервер отвечает фронту
// commentDelivered:false, и пояснение уедет отдельным сообщением (см. стор чата).
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import chatModule from '../../server/src/modules/chat/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function apiFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-chat-perm-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  const events = [];
  app.decorate('sse', { broadcast(name, payload) { events.push({ name, payload }); } });
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
    executorResolver: async () => null,
  });
  t.after(() => app.close());
  return { app, events };
}

// Поднимает запрос разрешения (висит, как в бою), находит его pid в «SSE»-трансляции
// и отвечает на него как браузер. Возвращает тело, которое получил агент, и ack фронту.
async function answerPermission(t, { tool, input, answer }) {
  const { app, events } = await apiFixture(t);
  const pending = app.inject({
    method: 'POST',
    url: '/api/chat/permission-request',
    payload: { tool_name: tool, input, chatKey: 'c1' },
  });
  let ev;
  for (let i = 0; i < 10 && !ev; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    ev = events.find((e) => e.name === 'chat-permission');
  }
  assert.ok(ev, 'запрос разрешения дошёл до окон');
  const ack = await app.inject({
    method: 'POST',
    url: `/api/chat/permission/${ev.payload.pid}`,
    payload: answer,
  });
  assert.equal(ack.statusCode, 200);
  const response = await pending;
  assert.equal(response.statusCode, 200);
  return { body: response.json(), ack: ack.json() };
}

test('план на доработку с пояснением: агент получает и причину, и текст замечания', async (t) => {
  const { body } = await answerPermission(t, {
    tool: 'ExitPlanMode',
    input: { plan: 'Шаг 1. Сделать' },
    answer: { allow: false, comment: 'убери лишний шаг' },
  });
  assert.equal(body.behavior, 'deny');
  assert.match(body.message, /на доработку/);
  assert.match(body.message, /убери лишний шаг/);
});

test('отклонение обычного действия с пояснением: пояснение в deny-message', async (t) => {
  const { body } = await answerPermission(t, {
    tool: 'Bash',
    input: { command: 'rm -rf build' },
    answer: { allow: false, comment: 'опасная команда' },
  });
  assert.equal(body.behavior, 'deny');
  assert.match(body.message, /отклонил действие/);
  assert.match(body.message, /опасная команда/);
});

test('отказ без пояснения: прежний дефолтный текст без изменений', async (t) => {
  const { body } = await answerPermission(t, {
    tool: 'ExitPlanMode',
    input: { plan: 'Шаг 1' },
    answer: { allow: false },
  });
  assert.deepEqual(body, { behavior: 'deny', message: 'Пользователь отклонил действие в кокпите' });
});

test('разрешение по-прежнему проходит в allow-ветку с updatedInput', async (t) => {
  const { body, ack } = await answerPermission(t, {
    tool: 'Bash',
    input: { command: 'ls' },
    answer: { allow: true },
  });
  assert.deepEqual(body, { behavior: 'allow', updatedInput: { command: 'ls' } });
  assert.deepEqual(ack, { ok: true });
});
