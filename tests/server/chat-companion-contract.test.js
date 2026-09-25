// Проверяет серверный контракт companion-чата: server-owned identity привязана к маршруту
// хода, а сам ход идёт обычным путём в выбранном человеком режиме.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import chatModule from '../../server/src/modules/chat/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function apiFixture(t, {
  ticket = null,
  telegramDiscussion = null,
  workProject = null,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-companion-mode-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worktree = path.join(root, 'task-worktree');
  await fs.mkdir(worktree, { recursive: true });
  const ticketsDir = path.join(root, 'tickets');
  if (ticket) {
    await fs.mkdir(ticketsDir, { recursive: true });
    await fs.writeFile(
      path.join(ticketsDir, `t${ticket.taskId}.ticket.json`),
      JSON.stringify(ticket),
    );
  }

  const events = [];
  const runs = [];
  const modes = [];
  const resolverCalls = [];
  const factoryReads = [];
  const taskChecks = [];
  const knownTasks = new Set(['44', '60', '61']);
  const sandboxTasks = new Set(['44', '60', '61']);
  const forgedEnvTasks = new Set();
  const executors = new Map();
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast(event, data) { events.push({ event, data }); } });
  if (typeof telegramDiscussion === 'function') {
    app.decorate('telegramDiscussion', telegramDiscussion);
  }
  const config = {
    chatsDir: path.join(root, 'chats'),
    chatStoreLegacyPath: path.join(root, 'legacy.json'),
    chatBindingsDir: path.join(root, 'bindings'),
    rootDir: root,
    factoryHome: root,
    port: 18140,
    ...(ticket ? { ticketsDir } : {}),
  };
  await app.register(chatModule, {
    config,
    factoryState: {
      async readRegistry(id) {
        if (!sandboxTasks.has(String(id))) throw new Error('task registry missing');
        return { registry: { TASK: String(id) } };
      },
      async readTrustedAttempt(id) {
        if (!sandboxTasks.has(String(id))) throw new Error('trusted attempt missing');
        return {
          ...(workProject ? { profile: workProject } : {}),
          workspaceMode: 'isolated',
          repositories: [{ name: 'main', workspace: worktree, branch: `factory/t${id}` }],
        };
      },
      verifyTrustedEnvironment(trusted, env) {
        if (env.REPO_0_WT !== trusted.repositories[0].workspace) {
          throw new Error('env does not match trusted attempt');
        }
        return true;
      },
      async readEnv(id) {
        factoryReads.push(String(id));
        return {
          WORKSPACE_MODE: 'isolated',
          REPO_COUNT: '1',
          REPO_0_NAME: 'main',
          REPO_0_SOURCE: path.join(root, 'source'),
          REPO_0_WT: forgedEnvTasks.has(String(id)) ? path.join(root, 'forged-worktree') : worktree,
          REPO_0_BRANCH: `factory/t${id}`,
        };
      },
    },
    prefs: {
      read() {
        return {
          speech: {},
          trustedDirectories: [],
          providerSettings: {},
          chatAutoCompactWindow: 0,
          projects: workProject ? { [workProject]: {} } : {},
        };
      },
    },
    modelsRegistry: async () => ({
      claude: [{ id: 'claude-test', efforts: [] }],
      kimi: [{ id: 'kimi-test', efforts: [] }],
      codex: [{ id: 'codex-test', efforts: [] }],
    }),
    executorResolver: async (provider) => {
      resolverCalls.push(provider);
      return executors.get(provider) || null;
    },
    taskExists: async (taskId) => {
      taskChecks.push(String(taskId));
      return knownTasks.has(String(taskId));
    },
  });
  await app.ready();
  t.after(() => app.close());

  function setExecutor(provider, { modesImpl, includeModes = true, runImpl = null } = {}) {
    const executor = {
      id: provider,
      async run(options) {
        runs.push({ provider, options });
        if (runImpl) return runImpl(options, runs.length);
        return {
          reply: `ok-${provider}`,
          steps: [],
          sessionId: `${provider}-session`,
          cost: 0,
        };
      },
    };
    if (includeModes) {
      executor.modes = async (...args) => {
        modes.push({ provider, args });
        return modesImpl ? modesImpl(...args) : [{ id: 'plan' }];
      };
    }
    executors.set(provider, executor);
    return executor;
  }

  return {
    app,
    config,
    root,
    worktree,
    events,
    runs,
    modes,
    resolverCalls,
    factoryReads,
    taskChecks,
    knownTasks,
    sandboxTasks,
    forgedEnvTasks,
    setExecutor,
  };
}

async function saveCompanion(app, { taskId = null, provider = 'claude' } = {}) {
  const ensured = await app.inject({
    method: 'POST',
    url: '/api/chat/store/ensure',
    payload: { purpose: 'companion', ...(taskId ? { taskId } : {}) },
  });
  assert.equal(ensured.statusCode, 200, ensured.body);
  const chat = ensured.json().chat;
  const model = `${provider}-test`;
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        ...chat,
        model,
        modelRef: { provider, model },
        updatedAt: Number(chat.updatedAt || 0) + 1,
      },
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const found = await app.inject({ method: 'GET', url: `/api/chat/store/chat/${chat.id}` });
  assert.equal(found.statusCode, 200, found.body);
  return found.json().chat;
}

function turnPayload(chat, extra = {}) {
  return {
    chatKey: chat.id,
    modelRef: chat.modelRef,
    model: chat.modelRef.model,
    message: 'Подскажи следующий шаг',
    mode: 'plan',
    ...extra,
  };
}

test('COMP-MODE-01: смена режима прав создаёт отдельный scope рабочих инструментов', async (t) => {
  const fixture = await apiFixture(t);
  const executor = fixture.setExecutor('claude', {
    modesImpl: async () => [{ id: 'plan' }, { id: 'acceptEdits' }],
  });
  executor.workToolsTransport = 'mcp';
  const chat = await saveCompanion(fixture.app, { taskId: '44' });

  const planned = await fixture.app.inject({
    method: 'POST',
    url: '/api/tasks/44/chat',
    payload: turnPayload(chat),
  });
  const writable = await fixture.app.inject({
    method: 'POST',
    url: '/api/tasks/44/chat',
    payload: turnPayload(chat, { mode: 'acceptEdits' }),
  });
  const keys = fixture.runs.map((run) => run.options.workToolScopeKey);

  assert.deepEqual({
    statuses: [planned.statusCode, writable.statusCode],
    distinct: new Set(keys).size,
    carriesModes: keys.map((key) => key.includes('plan') || key.includes('acceptEdits')),
  }, {
    statuses: [200, 200],
    distinct: 2,
    carriesModes: [true, true],
  });
});

test('COMP-MODE-03: durable companion identity всегда привязана к exact route', async (t) => {
  const fixture = await apiFixture(t);
  fixture.setExecutor('claude', {
    modesImpl: async () => [{ id: 'plan' }, { id: 'acceptEdits' }],
  });
  const task = await saveCompanion(fixture.app, { taskId: '44' });
  const global = await saveCompanion(fixture.app);

  for (const [url, chat] of [
    ['/api/chat', task],
    ['/api/tasks/45/chat', task],
    ['/api/tasks/44/chat', global],
  ]) {
    const rejected = await fixture.app.inject({
      method: 'POST',
      url,
      payload: turnPayload(chat, { mode: 'acceptEdits' }),
    });
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json().error, 'companion_scope_mismatch');
  }
  assert.equal(fixture.runs.length, 0, 'wrong route не доходит до executor');

  const accepted = await fixture.app.inject({
    method: 'POST',
    url: '/api/tasks/44/chat',
    payload: turnPayload(task, { mode: 'acceptEdits' }),
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.runs[0].options.permissionMode, 'acceptEdits',
    'полный чат сохраняет явно выбранный человеком режим');
});

test('COMP-MODE-04: companion-чат на /chats идёт в выбранном человеком режиме', async (t) => {
  const fixture = await apiFixture(t);
  fixture.setExecutor('claude', {
    modesImpl: async () => [{ id: 'acceptEdits' }],
  });
  const chat = await saveCompanion(fixture.app);

  const response = await fixture.app.inject({
    method: 'POST', url: '/api/chat',
    payload: turnPayload(chat, { mode: 'acceptEdits' }),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.runs[0].options.permissionMode, 'acceptEdits');
});

test('COMP-ENSURE-06: DELETE не удаляет identity, пока принятый ход ещё не дошёл до activeRuns', async (t) => {
  const fixture = await apiFixture(t);
  const lockedModes = deferred();
  const releaseModes = deferred();
  let modeCall = 0;
  fixture.setExecutor('claude', {
    modesImpl: async () => {
      modeCall += 1;
      if (modeCall === 1) {
        lockedModes.resolve();
        await releaseModes.promise;
      }
      return [{ id: 'plan' }];
    },
  });
  const chat = await saveCompanion(fixture.app);
  const turn = fixture.app.inject({
    method: 'POST', url: '/api/chat', payload: turnPayload(chat),
  });
  await lockedModes.promise;

  try {
    const active = await fixture.app.inject({ method: 'GET', url: '/api/chat/active' });
    assert.deepEqual(active.json().active, [], 'принятый ход ещё не появился в activeRuns');
    assert.equal(fixture.events.some((event) => event.event === 'chat-turn-start'), false);

    const deletion = await fixture.app.inject({
      method: 'DELETE', url: `/api/chat/store/chat/${chat.id}`,
    });
    assert.equal(deletion.statusCode, 409, deletion.body);
    assert.equal(deletion.json().error, 'chat_busy');
    const durable = await fixture.app.inject({
      method: 'GET', url: `/api/chat/store/chat/${chat.id}`,
    });
    assert.equal(durable.statusCode, 200, durable.body);
    assert.equal(durable.json().chat.logicalIdentity, 'companion:global');
  } finally {
    releaseModes.resolve();
  }

  const completed = await turn;
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(fixture.runs.length, 1);
  const after = await fixture.app.inject({
    method: 'GET', url: `/api/chat/store/chat/${chat.id}`,
  });
  assert.equal(after.statusCode, 200, after.body);
});
