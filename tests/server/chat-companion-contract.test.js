// Проверяет серверный контракт быстрых ходов голосового компаньона.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import chatModule from '../../server/src/modules/chat/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function apiFixture(t, { ticket = null, telegramDiscussion = null } = {}) {
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
        return { speech: {}, trustedDirectories: [], providerSettings: {}, chatAutoCompactWindow: 0 };
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

async function saveNormal(app, id = 'normal-chat') {
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id,
        title: 'Обычный чат',
        model: 'claude-test',
        modelRef: { provider: 'claude', model: 'claude-test' },
        messages: [],
        createdAt: Date.UTC(2026, 7, 19),
        updatedAt: Date.UTC(2026, 7, 19),
      },
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  return id;
}

function turnPayload(chat, extra = {}) {
  return {
    chatKey: chat.id,
    modelRef: chat.modelRef,
    model: chat.modelRef.model,
    message: 'Подскажи следующий шаг',
    mode: 'plan',
    companionTurn: true,
    ...extra,
  };
}

test('COMP-MODE-01: exact companion global/task проходят только в объявленном plan', async (t) => {
  const fixture = await apiFixture(t);
  fixture.setExecutor('claude', {
    modesImpl: async () => [{ id: 'default' }, { id: 'plan' }, { id: 'acceptEdits' }],
  });
  const global = await saveCompanion(fixture.app);
  const task = await saveCompanion(fixture.app, { taskId: '44' });

  const globalTurn = await fixture.app.inject({
    method: 'POST', url: '/api/chat', payload: turnPayload(global),
  });
  const taskTurn = await fixture.app.inject({
    method: 'POST', url: '/api/tasks/44/chat', payload: turnPayload(task),
  });
  assert.equal(globalTurn.statusCode, 200, globalTurn.body);
  assert.equal(taskTurn.statusCode, 200, taskTurn.body);
  assert.equal(fixture.runs.length, 2);
  assert.equal(fixture.modes.length, 4,
    'каждый companion turn проверяет mode catalog при приёме и повторно внутри chat lock');
  assert.equal(fixture.runs[0].options.permissionMode, 'plan');
  assert.equal(fixture.runs[1].options.permissionMode, 'plan');
  assert.equal(fixture.runs[0].options.cwd, fixture.root);
  assert.equal(fixture.runs[1].options.cwd, fixture.worktree);
});

test('COMP-MODE-01/03: marker не превращает normal chat и не меняет task scope/mode', async (t) => {
  const fixture = await apiFixture(t);
  fixture.setExecutor('claude', {
    modesImpl: async () => [{ id: 'plan' }, { id: 'acceptEdits' }],
  });
  const normalId = await saveNormal(fixture.app);
  const task = await saveCompanion(fixture.app, { taskId: '44' });
  const global = await saveCompanion(fixture.app);

  const normal = await fixture.app.inject({
    method: 'POST', url: '/api/chat',
    payload: {
      chatKey: normalId,
      modelRef: { provider: 'claude', model: 'claude-test' },
      message: 'не запускать', mode: 'plan', companionTurn: true,
    },
  });
  assert.equal(normal.statusCode, 409, normal.body);
  assert.equal(normal.json().error, 'companion_chat_required');

  const wrongGlobal = await fixture.app.inject({
    method: 'POST', url: '/api/chat', payload: turnPayload(task),
  });
  assert.equal(wrongGlobal.statusCode, 409, wrongGlobal.body);
  assert.equal(wrongGlobal.json().error, 'companion_scope_mismatch');

  const wrongTask = await fixture.app.inject({
    method: 'POST', url: '/api/tasks/44/chat', payload: turnPayload(global),
  });
  assert.equal(wrongTask.statusCode, 409, wrongTask.body);
  assert.equal(wrongTask.json().error, 'companion_scope_mismatch');

  const broadMode = await fixture.app.inject({
    method: 'POST', url: '/api/tasks/44/chat',
    payload: turnPayload(task, { mode: 'acceptEdits' }),
  });
  assert.equal(broadMode.statusCode, 409, broadMode.body);
  assert.equal(broadMode.json().error, 'companion_plan_required');
  assert.equal(fixture.runs.length, 0);
  assert.equal(fixture.modes.length, 0, 'identity/mode отсеиваются до executor catalog');
  assert.equal(fixture.factoryReads.length, 0, 'scope failure не читает worktree');
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
      payload: turnPayload(chat, { companionTurn: false, mode: 'acceptEdits' }),
    });
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json().error, 'companion_scope_mismatch');
  }
  assert.equal(fixture.runs.length, 0, 'wrong route не доходит до executor даже без marker-а');

  const accepted = await fixture.app.inject({
    method: 'POST',
    url: '/api/tasks/44/chat',
    payload: turnPayload(task, { companionTurn: false, mode: 'acceptEdits' }),
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.runs[0].options.permissionMode, 'acceptEdits',
    'полный чат сохраняет явно выбранный человеком режим');
});

test('COMP-MODE-03: companion marker не протаскивает attachments и slash semantics', async (t) => {
  const fixture = await apiFixture(t);
  fixture.setExecutor('claude', {
    modesImpl: async () => [{ id: 'plan' }],
  });
  const chat = await saveCompanion(fixture.app);

  for (const extra of [
    { attachments: [{ file: 'forged.txt', name: 'forged.txt' }] },
    { slashCommand: '/danger', message: '/danger' },
  ]) {
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/chat', payload: turnPayload(chat, extra),
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'companion_turn_unsupported');
  }
  assert.equal(fixture.resolverCalls.length, 0);
  assert.equal(fixture.modes.length, 0);
  assert.equal(fixture.runs.length, 0);
});

test('COMP-MODE-02: missing/error/empty/no-plan catalog fail-closed до run и activeRuns', async (t) => {
  const fixture = await apiFixture(t);
  const chat = await saveCompanion(fixture.app);
  const variants = [
    { label: 'нет метода modes', executor: { includeModes: false } },
    { label: 'modes бросает', executor: { modesImpl: async () => { throw new Error('catalog down'); } } },
    { label: 'modes вернул null', executor: { modesImpl: async () => null } },
    { label: 'modes вернул пустой каталог', executor: { modesImpl: async () => [] } },
    { label: 'plan отсутствует', executor: { modesImpl: async () => [{ id: 'acceptEdits' }] } },
  ];

  for (const variant of variants) {
    fixture.setExecutor('claude', variant.executor);
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/chat', payload: turnPayload(chat),
    });
    assert.equal(response.statusCode, 409, `${variant.label}: ${response.body}`);
    assert.equal(response.json().error, 'companion_plan_unavailable', variant.label);
    const active = await fixture.app.inject({ method: 'GET', url: '/api/chat/active' });
    assert.deepEqual(active.json().active, [], variant.label);
  }
  assert.equal(fixture.runs.length, 0);
  assert.equal(fixture.events.some((event) => ['chat-queued', 'chat-turn-start'].includes(event.event)), false);
});

test('COMP-MODE-02: Codex без modes и Kimi forged binding дают plan-unavailable до binding', async (t) => {
  const fixture = await apiFixture(t);
  fixture.setExecutor('codex', { includeModes: false });
  fixture.setExecutor('kimi', { includeModes: false });
  const codex = await saveCompanion(fixture.app, { taskId: '60', provider: 'codex' });
  const kimi = await saveCompanion(fixture.app, { taskId: '61', provider: 'kimi' });

  const codexTurn = await fixture.app.inject({
    method: 'POST', url: '/api/tasks/60/chat', payload: turnPayload(codex),
  });
  assert.equal(codexTurn.statusCode, 409, codexTurn.body);
  assert.equal(codexTurn.json().error, 'companion_plan_unavailable');

  const kimiTurn = await fixture.app.inject({
    method: 'POST', url: '/api/tasks/61/chat',
    payload: turnPayload(kimi, { sessionId: 'client-forged-session' }),
  });
  assert.equal(kimiTurn.statusCode, 409, kimiTurn.body);
  assert.equal(kimiTurn.json().error, 'companion_plan_unavailable',
    'strict catalog проверяется раньше forged/binding branch');
  assert.equal(fixture.runs.length, 0);
  await assert.rejects(() => fs.access(fixture.config.chatBindingsDir));
});

test('COMP-MODE-04: полный /chats без marker продолжает companion в выбранном режиме', async (t) => {
  const fixture = await apiFixture(t);
  fixture.setExecutor('claude', {
    modesImpl: async () => [{ id: 'acceptEdits' }],
  });
  const chat = await saveCompanion(fixture.app);

  const response = await fixture.app.inject({
    method: 'POST', url: '/api/chat',
    payload: turnPayload(chat, { companionTurn: false, mode: 'acceptEdits' }),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.runs[0].options.permissionMode, 'acceptEdits');
});

test('COMP-ENSURE-02/MODE-02: исчезнувшая server-owned задача закрывает companion до executor', async (t) => {
  const fixture = await apiFixture(t);
  fixture.setExecutor('claude', { modesImpl: async () => [{ id: 'plan' }] });
  const chat = await saveCompanion(fixture.app, { taskId: '44' });
  fixture.knownTasks.delete('44');
  fixture.taskChecks.length = 0;

  const response = await fixture.app.inject({
    method: 'POST', url: '/api/tasks/44/chat', payload: turnPayload(chat),
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'companion_task_unavailable');
  assert.deepEqual(fixture.taskChecks, ['44']);
  assert.equal(fixture.resolverCalls.length, 0, 'executor даже не резолвится');
  assert.equal(fixture.modes.length, 0, 'каталог режимов не читается');
  assert.equal(fixture.runs.length, 0);
  assert.equal(fixture.factoryReads.length, 0, 'worktree не читается');
  const active = await fixture.app.inject({ method: 'GET', url: '/api/chat/active' });
  assert.deepEqual(active.json().active, []);
});

test('COMP-ENSURE-02: B24-only identity сохраняет историю, но quick turn не падает в root cwd', async (t) => {
  const fixture = await apiFixture(t);
  fixture.knownTasks.add('62');
  fixture.setExecutor('claude', { modesImpl: async () => [{ id: 'plan' }] });
  const chat = await saveCompanion(fixture.app, { taskId: '62' });

  const response = await fixture.app.inject({
    method: 'POST', url: '/api/tasks/62/chat', payload: turnPayload(chat),
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'companion_task_sandbox_unavailable');
  assert.equal(fixture.resolverCalls.length, 0);
  assert.equal(fixture.modes.length, 0);
  assert.equal(fixture.runs.length, 0);
  assert.equal(fixture.factoryReads.length, 0, 'runChatTurn не читает пустой env и не выбирает root cwd');
});

test('COMP-MODE-02: удалённый trusted worktree закрывает ход до executor и activeRuns', async (t) => {
  const fixture = await apiFixture(t);
  fixture.setExecutor('claude', { modesImpl: async () => [{ id: 'plan' }] });
  const chat = await saveCompanion(fixture.app, { taskId: '44' });
  await fs.rm(fixture.worktree, { recursive: true, force: true });

  const response = await fixture.app.inject({
    method: 'POST', url: '/api/tasks/44/chat', payload: turnPayload(chat),
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'companion_task_sandbox_unavailable');
  assert.equal(fixture.resolverCalls.length, 0, 'executor не резолвится со stale cwd');
  assert.equal(fixture.modes.length, 0, 'mode catalog не читается со stale cwd');
  assert.equal(fixture.runs.length, 0);
  assert.equal(fixture.events.some((event) => (
    ['chat-queued', 'chat-turn-start'].includes(event.event)
  )), false);
  const active = await fixture.app.inject({ method: 'GET', url: '/api/chat/active' });
  assert.deepEqual(active.json().active, []);
});

test('COMP-MODE-02: symlink не перепривязывает trusted workspace к другому cwd', async (t) => {
  const fixture = await apiFixture(t);
  fixture.setExecutor('claude', { modesImpl: async () => [{ id: 'plan' }] });
  const chat = await saveCompanion(fixture.app, { taskId: '44' });
  const redirected = path.join(fixture.root, 'redirected-worktree');
  await fs.mkdir(redirected);
  await fs.rm(fixture.worktree, { recursive: true, force: true });
  await fs.symlink(redirected, fixture.worktree, 'dir');

  const response = await fixture.app.inject({
    method: 'POST', url: '/api/tasks/44/chat', payload: turnPayload(chat),
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'companion_task_sandbox_unavailable');
  assert.equal(fixture.resolverCalls.length, 0);
  assert.equal(fixture.modes.length, 0);
  assert.equal(fixture.runs.length, 0, 'executor не получает canonical target подложенного symlink-а');
  const active = await fixture.app.inject({ method: 'GET', url: '/api/chat/active' });
  assert.deepEqual(active.json().active, []);
});

test('COMP-MODE-02: поздняя проверка замечает worktree, исчезнувший во время prompt I/O', async (t) => {
  const discussionStarted = deferred();
  const releaseDiscussion = deferred();
  const fixture = await apiFixture(t, {
    ticket: {
      taskId: '44',
      title: 'Проверить поздний sandbox gate',
      description: 'Контекст с server-owned обсуждением.',
    },
    telegramDiscussion: async () => {
      discussionStarted.resolve();
      await releaseDiscussion.promise;
      return { text: '' };
    },
  });
  fixture.setExecutor('claude', { modesImpl: async () => [{ id: 'plan' }] });
  const chat = await saveCompanion(fixture.app, { taskId: '44' });
  const turn = fixture.app.inject({
    method: 'POST', url: '/api/tasks/44/chat', payload: turnPayload(chat),
  });
  await discussionStarted.promise;
  await fs.rm(fixture.worktree, { recursive: true, force: true });
  releaseDiscussion.resolve();

  const response = await turn;
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'companion_task_sandbox_unavailable');
  assert.equal(fixture.runs.length, 0);
  assert.equal(fixture.events.some((event) => event.event === 'chat-turn-start'), false);
  const active = await fixture.app.inject({ method: 'GET', url: '/api/chat/active' });
  assert.deepEqual(active.json().active, []);
});

test('COMP-MODE-02: provider-writable env не назначает cwd без trusted attempt match', async (t) => {
  const fixture = await apiFixture(t);
  fixture.forgedEnvTasks.add('44');
  fixture.setExecutor('claude', { modesImpl: async () => [{ id: 'plan' }] });
  const chat = await saveCompanion(fixture.app, { taskId: '44' });

  const response = await fixture.app.inject({
    method: 'POST', url: '/api/tasks/44/chat', payload: turnPayload(chat),
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'companion_task_sandbox_unavailable');
  assert.equal(fixture.runs.length, 0);
  assert.equal(fixture.resolverCalls.length, 0);
});

test('COMP-MODE-02: queued turn повторно проверяет свежий plan catalog внутри chat lock', async (t) => {
  const fixture = await apiFixture(t);
  const firstRun = deferred();
  const releaseFirst = deferred();
  let planAvailable = true;
  fixture.setExecutor('claude', {
    modesImpl: async () => (planAvailable ? [{ id: 'plan' }] : [{ id: 'acceptEdits' }]),
    runImpl: async () => {
      if (fixture.runs.length === 1) {
        firstRun.resolve();
        await releaseFirst.promise;
      }
      return { reply: 'ok-claude', steps: [], sessionId: 'claude-session', cost: 0 };
    },
  });
  const chat = await saveCompanion(fixture.app, { taskId: '44' });
  const first = fixture.app.inject({
    method: 'POST', url: '/api/tasks/44/chat', payload: turnPayload(chat),
  });
  await firstRun.promise;
  const second = fixture.app.inject({
    method: 'POST', url: '/api/tasks/44/chat', payload: turnPayload(chat),
  });
  await waitFor(
    () => fixture.events.some((event) => event.event === 'chat-queued'),
    'второй ход не дошёл до очереди',
  );
  planAvailable = false;
  releaseFirst.resolve();

  assert.equal((await first).statusCode, 200);
  const response = await second;
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'companion_plan_unavailable');
  assert.equal(fixture.runs.length, 1, 'второй executor не стартует');
});

test('COMP-MODE-02: queued turn не использует worktree, исчезнувший во время ожидания', async (t) => {
  const fixture = await apiFixture(t);
  const firstRun = deferred();
  const releaseFirst = deferred();
  fixture.setExecutor('claude', {
    modesImpl: async () => [{ id: 'plan' }],
    runImpl: async () => {
      if (fixture.runs.length === 1) {
        firstRun.resolve();
        await releaseFirst.promise;
      }
      return { reply: 'ok-claude', steps: [], sessionId: 'claude-session', cost: 0 };
    },
  });
  const chat = await saveCompanion(fixture.app, { taskId: '44' });
  const first = fixture.app.inject({
    method: 'POST', url: '/api/tasks/44/chat', payload: turnPayload(chat),
  });
  await firstRun.promise;
  const second = fixture.app.inject({
    method: 'POST', url: '/api/tasks/44/chat', payload: turnPayload(chat),
  });
  await waitFor(
    () => fixture.events.some((event) => event.event === 'chat-queued'),
    'второй ход не дошёл до очереди',
  );
  fixture.sandboxTasks.delete('44');
  releaseFirst.resolve();

  assert.equal((await first).statusCode, 200);
  const response = await second;
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'companion_task_sandbox_unavailable');
  assert.equal(fixture.runs.length, 1, 'второй executor не стартует со stale cwd');
});

test('COMP-MODE-02: DELETE не удаляет identity во время locked strict preflight', async (t) => {
  const fixture = await apiFixture(t);
  const lockedModes = deferred();
  const releaseModes = deferred();
  let modeCall = 0;
  fixture.setExecutor('claude', {
    modesImpl: async () => {
      modeCall += 1;
      if (modeCall === 2) {
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
    assert.deepEqual(active.json().active, [], 'locked preflight ещё не появился в activeRuns');
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

test('COMP-TTS-15: server sticky verdict переживает sliding tail и отдельный MCP permission channel', async (t) => {
  const fixture = await apiFixture(t);
  fixture.setExecutor('claude', {
    modesImpl: async () => [{ id: 'plan' }],
    runImpl: async (options, call) => {
      options.onStep({ k: 'start', model: 'claude-test', mode: 'plan' });
      if (call === 1) {
        options.onStep({ k: 'text', text: 'Обычный ответ.' });
        return {
          reply: 'Обычный ответ.',
          steps: [{ k: 'start' }, { k: 'text', text: 'Обычный ответ.' }],
          sessionId: 'safe-session',
          // Результат исполнителя не источник истины: итоговый вердикт записывает сервер.
          speechSafe: false,
        };
      }
      if (call === 2) {
        options.onStep({ k: 'tool', name: 'Bash', title: 'раннее действие' });
        const tail = Array.from({ length: 401 }, (_, index) => ({ k: 'text', text: `хвост ${index}` }));
        tail.forEach(options.onStep);
        return {
          reply: 'Хвост выглядит безопасно.',
          steps: tail.slice(-400),
          sessionId: 'unsafe-session',
          speechSafe: true,
        };
      }

      const pendingPermission = fixture.app.inject({
        method: 'POST',
        url: '/api/chat/permission-request',
        payload: { tool_name: 'Bash', input: { command: 'pwd' }, chatKey: options.chatKey },
      });
      await waitFor(
        () => fixture.events.some((event) => event.event === 'chat-permission'),
        'Claude MCP permission не дошёл до route',
      );
      const event = fixture.events.findLast((item) => item.event === 'chat-permission');
      const decision = await fixture.app.inject({
        method: 'POST',
        url: `/api/chat/permission/${event.data.pid}`,
        payload: { allow: false },
      });
      assert.equal(decision.statusCode, 200, decision.body);
      await pendingPermission;
      options.onStep({ k: 'text', text: 'После вопроса.' });
      return {
        reply: 'После вопроса.',
        steps: [{ k: 'start' }, { k: 'text', text: 'После вопроса.' }],
        sessionId: 'permission-session',
      };
    },
  });
  const chat = await saveCompanion(fixture.app);

  const safe = await fixture.app.inject({
    method: 'POST', url: '/api/chat', payload: turnPayload(chat),
  });
  assert.equal(safe.statusCode, 200, safe.body);
  assert.equal(safe.json().speechSafe, true,
    'только server-observed start/text получает явный safe verdict');

  const trimmedUnsafe = await fixture.app.inject({
    method: 'POST', url: '/api/chat', payload: turnPayload(chat),
  });
  assert.equal(trimmedUnsafe.statusCode, 200, trimmedUnsafe.body);
  assert.equal(trimmedUnsafe.json().steps.length, 400, 'ранний tool действительно выпал из HTTP tail');
  assert.ok(trimmedUnsafe.json().steps.every((step) => step.k === 'text'));
  assert.equal(trimmedUnsafe.json().speechSafe, false,
    'выпавший tool остаётся sticky unsafe');

  const mcpPermission = await fixture.app.inject({
    method: 'POST', url: '/api/chat', payload: turnPayload(chat),
  });
  assert.equal(mcpPermission.statusCode, 200, mcpPermission.body);
  assert.equal(mcpPermission.json().speechSafe, false,
    'локальный Claude MCP route тоже снимает attestation');
});
