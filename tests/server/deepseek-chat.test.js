import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import { pathToFileURL } from 'node:url';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import chatModule from '../../server/src/modules/chat/index.ts';
import { withChatImageHint } from '../../server/src/lib/chat/imageHint.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_WEB = path.join(REPO_ROOT, 'tests/fixtures/deepseek-harness/fakeWeb.mjs');
const MODEL = '["deepseek-official","deepseek-v4-flash"]';

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function waitFor(probe, attempts = 300) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('ожидаемое состояние не наступило');
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-deepseek-chat-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenarioFile = path.join(root, 'scenario.json');
  const logFile = path.join(root, 'fake.ndjson');
  const bin = path.join(root, 'dsh');
  await fs.mkdir(path.join(root, '.git'));

  const info = { ...runtimeInfoFixture(), journal: { write: 3, read: [0, 1, 2, 3] } };

  await fs.writeFile(bin, [
    `#!${process.execPath}`,
    `const info = ${JSON.stringify(info)};`,
    'if (process.argv.includes("--runtime-info")) { console.log(JSON.stringify(info)); process.exit(0); }',
    'if (process.argv.includes("-V")) { console.log(info.upstreamVersion); process.exit(0); }',
    `process.argv.push("--scenario", ${JSON.stringify(scenarioFile)}, "--log", ${JSON.stringify(logFile)});`,
    `await import(${JSON.stringify(pathToFileURL(FAKE_WEB).href)});`,
  ].join('\n'), { mode: 0o755 });
  const events = [];
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast(event, data) { events.push({ event, data }); } });
  const config = {
    chatsDir: path.join(root, 'chats'),
    chatStoreLegacyPath: path.join(root, 'legacy.json'),
    chatBindingsDir: path.join(root, 'bindings'),
    rootDir: root,
    factoryHome: root,
    deepseekRuntimeHome: path.join(root, 'deepseek-runtime'),
    deepseekBin: bin,
    port: 18142,
  };
  const beforeKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'synthetic-chat-key';
  t.after(() => {
    if (beforeKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = beforeKey;
  });
  await app.register(chatModule, {
    config,
    factoryState: { async readEnv() { return {}; } },
    prefs: {
      read() {
        return { providerSettings: {} };
      }
    },
    claudeAuth: null,
    internalToken: 'test',
    modelsRegistry: async () => ({
      deepseek: [{ id: MODEL, family: 'default', efforts: ['high'] }],
    }),
    executorResolver: async (provider) => (provider === 'deepseek' ? deepseek : null),
  });
  t.after(() => app.close());
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: {
      id: 'deepseek-chat',
      modelRef: { provider: 'deepseek', model: MODEL },
      messages: [],
      revision: 0,
    } },
  });
  assert.equal(saved.statusCode, 200);
  await fs.writeFile(scenarioFile, JSON.stringify({ updates: [] }));
  return {
    app,
    root,
    events,
    scenarioFile,
    logFile,
    async scenario(value) {
      await fs.writeFile(scenarioFile, JSON.stringify(value));
    },
  };
}

async function entries(file) {
  try {
    return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

function turn(app, message = 'synthetic prompt') {
  return app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: {
      chatKey: 'deepseek-chat',
      modelRef: { provider: 'deepseek', model: MODEL },
      model: MODEL,
      effort: 'high',
      mode: 'default',
      message,
    },
  });
}

test('полный fake-чат: permission → binding → resume, шаги видны в SSE', async (t) => {
  const f = await fixture(t);
  await f.scenario({
    updates: [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'первый ответ' } },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'permission-tool',
        title: 'bash',
        rawInput: {
          command: 'touch ../outside',
          sandbox_permissions: 'danger-full-access',
          justification: 'synthetic boundary check',
        },
      },
    ],
    permission: { toolCallId: 'permission-tool' },
  });
  const firstRun = turn(f.app);
  const permission = await waitFor(() => f.events.find((entry) => entry.event === 'chat-permission'));
  assert.equal(permission.data.tool, 'bash');
  assert.equal(permission.data.input.sandbox_permissions, 'danger-full-access');
  const answer = await f.app.inject({
    method: 'POST',
    url: `/api/chat/permission/${permission.data.pid}`,
    payload: { allow: true },
  });
  assert.equal(answer.statusCode, 200);
  const first = await firstRun;
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().reply, 'первый ответ');
  assert.ok(f.events.some((entry) => entry.event === 'chat-step' && entry.data.step?.k === 'tool'));

  await f.scenario({
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resume ok' } }],
  });
  const second = await turn(f.app, 'second prompt');
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().reply, 'resume ok');
  const requests = (await entries(f.logFile)).filter((entry) => entry.kind === 'request');
  const methods = requests.map((entry) => entry.message?.method);
  assert.equal(requests.filter((entry) => entry.message?.method === 'session/create'
    && !entry.message?.params?.request?.sessionId).length, 1);
  assert.equal(requests.filter((entry) => entry.message?.method === 'session/create'
    && entry.message?.params?.request?.sessionId).length, 1);
  assert.equal(methods.filter((method) => method === 'session/prompt').length, 2);
  const permissionResponse = (await entries(f.logFile))
    .find((entry) => entry.kind === 'permission_response');
  assert.equal(permissionResponse.message.result.value, 'allowed-once');
  // Каталоги ходов (overlay + hooks) живут только вместе с процессом DSH: после двух ходов
  // в runtime home чата не должно остаться ни одного `turns/<uuid>`.
  const chatDirs = await fs.readdir(path.join(f.root, 'deepseek-runtime', 'chats'));
  assert.equal(chatDirs.length, 1);
  assert.deepEqual(
    await fs.readdir(path.join(f.root, 'deepseek-runtime', 'chats', chatDirs[0], 'turns')),
    [],
  );
});

test('обрыв хода harness-ом доходит до окна как прерывание с кнопкой продолжения', async (t) => {
  const f = await fixture(t);
  await f.scenario({
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'bash', rawInput: { command: 'ls' } },
    ],
    promptError: {
      code: -32603,
      message: 'Internal error: turn failed: DeepSeek API request to https://api.deepseek.com failed',
    },
  });
  const response = await turn(f.app, 'long work');
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.interruptedBy, 'delivery_failure');
  assert.match(body.reply, /Ход оборвал сам CLI/u);
  assert.match(body.reply, /api\.deepseek\.com failed/u);
  assert.ok(body.sessionId);
  assert.ok(body.steps.some((step) => step.k === 'tool'));

  // Сессия цела: следующий ход делает resume, а не новую сессию.
  await f.scenario({
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resumed' } }],
  });
  const next = await turn(f.app, 'Продолжай');
  assert.equal(next.statusCode, 200);
  assert.equal(next.json().reply, 'resumed');
  const requests = (await entries(f.logFile)).filter((entry) => entry.kind === 'request');
  assert.equal(requests.filter((entry) => entry.message?.method === 'session/create'
    && entry.message?.params?.request?.sessionId).length, 1);
});

test('сжатие выжимкой ротирует server-owned binding: следующий ход — новая сессия', async (t) => {
  const f = await fixture(t);
  await f.scenario({
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'первый ответ' } }],
  });
  const first = await turn(f.app);
  assert.equal(first.statusCode, 200);

  // Выжимку пишет прежняя сессия (resume), ответ — семя новой; id наружу не уходит.
  await f.scenario({
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'выжимка' } }],
  });
  const compacted = await f.app.inject({
    method: 'POST',
    url: '/api/chat/compact',
    payload: {
      chatKey: 'deepseek-chat',
      modelRef: { provider: 'deepseek', model: MODEL },
      mode: 'default',
      sessionId: first.json().sessionId,
    },
  });
  assert.equal(compacted.statusCode, 200, compacted.body);
  assert.equal(compacted.json().compact.seed, 'выжимка');
  assert.equal(compacted.json().sessionId, null);

  // Раньше binding переживал сжатие, и следующий ход резюмировал полный контекст.
  await f.scenario({
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'с чистого листа' } }],
  });
  const next = await turn(f.app, '[Выжимка…]\n\nпродолжай');
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().reply, 'с чистого листа');
  const requests = (await entries(f.logFile)).filter((entry) => entry.kind === 'request');
  assert.deepEqual(
    requests.filter((entry) => entry.message?.method === 'session/create')
      .map((entry) => entry.message?.params?.request?.sessionId ? 'resume' : 'new'),
    ['new', 'resume', 'new'],
  );
});

test('stop отменяет один идущий prompt; active/F5 не запускает второй', async (t) => {
  const f = await fixture(t);
  await f.scenario({ waitForCancel: true });
  const running = turn(f.app, 'long prompt');
  await waitFor(async () => (await entries(f.logFile))
    .some((entry) => entry.message?.method === 'session/prompt'));
  const active = await f.app.inject({ method: 'GET', url: '/api/chat/active' });
  assert.equal(active.statusCode, 200);
  assert.equal(active.json().active.length, 1);
  const stop = await f.app.inject({
    method: 'POST', url: '/api/chat/stop', payload: { chatKey: 'deepseek-chat' },
  });
  assert.equal(stop.statusCode, 200);
  const response = await running;
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().stopped, true);
  const methods = (await entries(f.logFile))
    .filter((entry) => entry.kind === 'request')
    .map((entry) => entry.message?.method);
  assert.equal(methods.filter((method) => method === 'session/prompt').length, 1);
  assert.equal(methods.filter((method) => method === 'session/cancel').length, 1);
});

test('досье прерванного хода доезжает до DeepSeek, когда server-owned binding мёртв', async (t) => {
  const f = await fixture(t);
  await f.scenario({
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'продолжил' } }],
  });
  // Остановленный ход уже в истории, а binding пуст (empty-run инвалидация/новый чат):
  // resume невозможен, и запасной памятью остаётся только досье.
  const saved = await f.app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: {
      id: 'deepseek-chat',
      modelRef: { provider: 'deepseek', model: MODEL },
      createdAt: Date.UTC(2026, 8, 1),
      updatedAt: Date.now(),
      revision: 1,
      messages: [
        { role: 'user', text: 'сделай' },
        {
          role: 'assistant', text: '⏹ Ход остановлен.', stopped: true,
          steps: [
            { k: 'tool', name: 'Edit', title: 'chat.js' },
            { k: 'res', ok: false, text: '1 failing test' },
          ],
        },
      ],
    } },
  });
  assert.equal(saved.statusCode, 200, saved.body);

  const response = await turn(f.app, 'продолжай');
  assert.equal(response.statusCode, 200, response.body);
  const prompt = (await entries(f.logFile))
    .filter((entry) => entry.kind === 'request' && entry.message?.method === 'session/prompt')
    .at(-1);
  const text = String(prompt?.message?.params?.request?.content?.[0]?.text || '');
  assert.ok(text.includes('[Досье прерванного хода]'), 'досье подмешано в задание');
  assert.ok(text.includes('- Edit: chat.js'), 'досье называет сделанное');
  assert.ok(text.endsWith(withChatImageHint('продолжай', '')),
    'подсказка следует за просьбой человека');
});
