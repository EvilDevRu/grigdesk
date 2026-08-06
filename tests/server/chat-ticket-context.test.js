import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import chatModule from '../../server/src/modules/chat/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

// Чат с выбранной задачей обязан получать её тикет в конверте сообщения: выбор
// задачи влиял только на cwd, и агент не видел, о чём задача, пока человек не
// вставлял текст руками. Тикет читается из server-owned хранилища (ticketsDir).
async function apiFixture(t, { executor, ticket = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-chat-ticket-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ticketsDir = path.join(root, 'tickets');
  await fs.mkdir(ticketsDir, { recursive: true });
  if (ticket) {
    await fs.writeFile(
      path.join(ticketsDir, `t${ticket.taskId}.ticket.json`),
      JSON.stringify(ticket),
      'utf8',
    );
  }
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  const config = {
    chatsDir: path.join(root, 'chats'),
    chatStoreLegacyPath: path.join(root, 'legacy.json'),
    chatBindingsDir: path.join(root, 'bindings'),
    rootDir: root,
    factoryHome: root,
    agentsDir: path.join(root, 'agents'),
    ticketsDir,
    port: 18140,
  };
  await app.register(chatModule, {
    config,
    factoryState: { async readEnv() { return { WORKSPACE_MODE: 'isolated' }; } },
    prefs: { read() { return { trustedDirectories: [], providerSettings: {}, chatAutoCompactWindow: 0 }; } },
    claudeAuth: null,
    internalToken: 'test',
    modelsRegistry: async () => ({ claude: [{ id: 'claude-test', efforts: [] }] }),
    executorResolver: async () => executor,
  });
  t.after(() => app.close());
  return { app };
}

async function saveClaudeChat(app, id) {
  const response = await app.inject({
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
  assert.equal(response.statusCode, 200);
}

function capturingExecutor(captured) {
  return {
    id: 'claude',
    async run(options) {
      captured.message = options.message;
      return { reply: 'принято', steps: [], sessionId: 's1', cost: 0 };
    },
  };
}

const TICKET = {
  schema: 1,
  taskId: '8162',
  title: 'Вернуть фиксацию столбца «Группа»',
  description: 'Столбец «Группа» уезжает при горизонтальной прокрутке.',
  acceptanceCriteria: ['«Группа» видна при скролле', 'Скроллятся только колонки дат'],
  sourceUrl: 'http://127.0.0.1:8140/api/tasks/8162',
};

test('чат по задаче получает тикет в конверте сообщения', async (t) => {
  const captured = {};
  const { app } = await apiFixture(t, { executor: capturingExecutor(captured), ticket: TICKET });
  await saveClaudeChat(app, 'task-chat');

  const run = await app.inject({
    method: 'POST',
    url: '/api/tasks/8162/chat',
    payload: {
      chatKey: 'task-chat',
      modelRef: { provider: 'claude', model: 'claude-test' },
      model: 'claude-test',
      message: 'починишь?',
    },
  });

  assert.equal(run.statusCode, 200);
  assert.match(captured.message, /\[Задача чата\]/);
  assert.match(captured.message, /задача #8162: «Вернуть фиксацию столбца «Группа»»/);
  assert.match(captured.message, /Столбец «Группа» уезжает при горизонтальной прокрутке\./);
  assert.match(captured.message, /1\. «Группа» видна при скролле/);
  assert.match(captured.message, /2\. Скроллятся только колонки дат/);
  assert.match(captured.message, /\[\/Задача чата\]/);
  assert.ok(
    captured.message.indexOf('[/Задача чата]') < captured.message.indexOf('починишь?'),
    'конверт задачи идёт перед текстом пользователя',
  );
});

test('задача без тикета не роняет ход и не добавляет конверт', async (t) => {
  const captured = {};
  const { app } = await apiFixture(t, { executor: capturingExecutor(captured) });
  await saveClaudeChat(app, 'no-ticket-chat');

  const run = await app.inject({
    method: 'POST',
    url: '/api/tasks/8162/chat',
    payload: {
      chatKey: 'no-ticket-chat',
      modelRef: { provider: 'claude', model: 'claude-test' },
      model: 'claude-test',
      message: 'свободный вопрос',
    },
  });

  assert.equal(run.statusCode, 200);
  assert.doesNotMatch(captured.message, /\[Задача чата\]/);
});

test('свободный чат без задачи конверт тикета не получает', async (t) => {
  const captured = {};
  const { app } = await apiFixture(t, { executor: capturingExecutor(captured), ticket: TICKET });
  await saveClaudeChat(app, 'free-chat');

  const run = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'free-chat',
      modelRef: { provider: 'claude', model: 'claude-test' },
      model: 'claude-test',
      message: 'просто вопрос',
    },
  });

  assert.equal(run.statusCode, 200);
  assert.doesNotMatch(captured.message, /\[Задача чата\]/);
});

test('длинное описание обрезается с указанием файла тикета', async (t) => {
  const captured = {};
  const longTicket = { ...TICKET, description: `начало ${'x'.repeat(7000)} конец` };
  const { app } = await apiFixture(t, { executor: capturingExecutor(captured), ticket: longTicket });
  await saveClaudeChat(app, 'long-ticket-chat');

  const run = await app.inject({
    method: 'POST',
    url: '/api/tasks/8162/chat',
    payload: {
      chatKey: 'long-ticket-chat',
      modelRef: { provider: 'claude', model: 'claude-test' },
      model: 'claude-test',
      message: 'вопрос',
    },
  });

  assert.equal(run.statusCode, 200);
  assert.match(captured.message, /\[описание обрезано; полный текст: .*t8162\.ticket\.json\]/);
  assert.doesNotMatch(captured.message, /конец/);
});
