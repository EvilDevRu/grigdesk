// Generic t<TASK>.env обязан одинаково задавать workspace, diff и каталоги task-chat.
// Legacy BE_WT/FE_WT читается только явным read-only opt-in.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { parseSandboxRepositories } from '../../server/src/lib/sandboxEnv.ts';
import chatModule from '../../server/src/modules/chat/index.ts';
import factoryModule from '../../server/src/modules/factory/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

function genericEnv(root) {
  return {
    WORKSPACE_MODE: 'isolated',
    REPO_COUNT: '1',
    REPO_0_NAME: 'project-alpha',
    REPO_0_SOURCE: path.join(root, 'project-alpha-source'),
    REPO_0_WT: path.join(root, 'project-alpha-worktree'),
    REPO_0_BRANCH: 'factory/t9123',
    // Эти значения не имеют права стать fallback при заявленном generic-формате.
    BE_WT: path.join(root, 'wrong-be'),
    FE_WT: path.join(root, 'wrong-fe'),
  };
}

function legacyEnv(root) {
  return {
    BE_WT: path.join(root, 'be-worktree'),
    FE_WT: path.join(root, 'fe-worktree'),
    BE_BRANCH: 'factory/t9123',
    FE_BRANCH: 'factory/t9123',
  };
}

test('sandbox env: single-repo generic и shared mode разбираются точно', () => {
  const generic = parseSandboxRepositories(genericEnv('/tmp/grigdesk-generic'));
  assert.equal(generic.kind, 'generic');
  assert.deepEqual(generic.repos, [{
    name: 'project-alpha',
    source: '/tmp/grigdesk-generic/project-alpha-source',
    path: '/tmp/grigdesk-generic/project-alpha-worktree',
    branch: 'factory/t9123',
  }]);

  assert.equal(generic.workspaceMode, 'isolated');

  const shared = parseSandboxRepositories({
    ...genericEnv('/tmp/grigdesk-shared'),
    WORKSPACE_MODE: 'shared',
    REPO_0_SOURCE: '/tmp/grigdesk-shared/project-alpha-worktree',
  });
  assert.equal(shared.workspaceMode, 'shared');

  assert.equal(parseSandboxRepositories(legacyEnv('/tmp/grigdesk-legacy')).kind, 'invalid');
  const legacy = parseSandboxRepositories(legacyEnv('/tmp/grigdesk-legacy'), { allowLegacy: true });
  assert.equal(legacy.kind, 'legacy');
  assert.deepEqual(legacy.repos.map((repo) => repo.name), ['be', 'fe']);
  assert.deepEqual(legacy.repos.map((repo) => repo.path), [
    '/tmp/grigdesk-legacy/be-worktree',
    '/tmp/grigdesk-legacy/fe-worktree',
  ]);
});

test('sandbox env: повреждённый generic fail-closed и не откатывается к BE_WT', () => {
  const malformed = parseSandboxRepositories({
    REPO_COUNT: '1',
    REPO_0_NAME: 'project-alpha',
    REPO_0_SOURCE: '/tmp/project-alpha-source',
    REPO_0_WT: '/tmp/project-alpha-worktree',
    BE_WT: '/tmp/legacy-must-not-open',
  });
  assert.equal(malformed.kind, 'invalid');
  assert.deepEqual(malformed.repos, []);

  for (const env of [
    { ...genericEnv('/tmp/a'), REPO_1_NAME: 'extra' },
    { ...genericEnv('/tmp/b'), REPO_COUNT: '01' },
    { ...genericEnv('/tmp/c'), REPO_0_WT: '../relative' },
    { ...genericEnv('/tmp/d'), REPO_0_SOURCE: '../relative' },
    { ...genericEnv('/tmp/e'), REPO_0_SOURCE: '/tmp/e/project-alpha-worktree' },
  ]) {
    assert.equal(parseSandboxRepositories(env).kind, 'invalid');
  }
});

async function factoryServer(t, env) {
  const app = Fastify({ logger: false });
  await app.register(factoryModule, {
    factoryState: {
      async readEnv() { return env; },
    },
    config: {
      factoryHome: '/tmp',
      factoryBin: '/tmp/no-factory',
      factoryConfigRoot: '/tmp/no-config',
      factoryControlDir: '/tmp/no-control',
      routesDir: '/tmp/no-routes',
      ticketsDir: '/tmp/no-tickets',
      stateDir: '/tmp/no-state',
      profilesDir: '/tmp/no-profiles',
    },
    prefs: { read: () => ({}) },
    b24: null,
    analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null },
  });
  await app.ready();
  t.after(() => app.close());
  return app;
}

test('factory API отдаёт и диффит single-repo generic без BE/FE aliases', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sandbox-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = genericEnv(root);
  await mkdir(env.REPO_0_WT, { recursive: true });
  const app = await factoryServer(t, env);

  const workspace = (await app.inject({
    method: 'GET',
    url: '/api/tasks/9123/workspace',
  })).json();
  assert.deepEqual(workspace.repos, [{
    name: 'project-alpha',
    source: env.REPO_0_SOURCE,
    path: env.REPO_0_WT,
    branch: 'factory/t9123',
  }]);
  assert.equal('beWt' in workspace, false);
  assert.equal('feWt' in workspace, false);
  assert.equal(workspace.workspaceMode, 'isolated');

  const diff = (await app.inject({
    method: 'GET',
    url: '/api/tasks/9123/diff',
  })).json();
  assert.deepEqual(diff.repos.map((repo) => [repo.name, repo.path]), [
    ['project-alpha', env.REPO_0_WT],
  ]);
});

test('factory API сохраняет форму workspace старого BE/FE env', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sandbox-legacy-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = legacyEnv(root);
  await Promise.all([mkdir(env.BE_WT, { recursive: true }), mkdir(env.FE_WT, { recursive: true })]);
  const app = await factoryServer(t, env);

  const workspace = (await app.inject({
    method: 'GET',
    url: '/api/tasks/9123/workspace',
  })).json();
  assert.equal(workspace.readOnly, true);
  assert.deepEqual(workspace.repos.map((repo) => repo.name), ['be', 'fe']);
});

async function chatServer(t, root, env, calls) {
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  const executor = {
    id: 'claude',
    async run(options) {
      calls.push({ cwd: options.cwd, extraDirs: options.extraDirs });
      return {
        reply: 'ok',
        steps: [],
        sessionId: 'test-session',
        contextTokens: 1,
        cost: 0,
      };
    },
  };
  await app.register(chatModule, {
    config: {
      chatsDir: path.join(root, 'chats'),
      chatStoreLegacyPath: path.join(root, 'legacy-chats.json'),
      chatBindingsDir: path.join(root, 'bindings'),
      rootDir: root,
      factoryHome: root,
      agentsDir: path.join(root, 'agents'),
      port: 18140,
    },
    factoryState: { async readEnv() { return env; } },
    prefs: {
      read() {
        return { providerSettings: {}, chatAutoCompactWindow: 0 };
      },
    },
    claudeAuth: null,
    internalToken: 'test',
    modelsRegistry: async () => ({ claude: [{ id: 'claude-test', efforts: [] }] }),
    executorResolver: async () => executor,
  });
  await app.ready();
  t.after(() => app.close());
  return app;
}

test('task-chat берёт первый generic repo как cwd, остальные как add-dir', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sandbox-chat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'project-alpha-worktree');
  const second = path.join(root, 'assets-worktree');
  const firstSource = path.join(root, 'project-alpha-source');
  const secondSource = path.join(root, 'assets-source');
  await Promise.all([mkdir(first), mkdir(second)]);
  const calls = [];
  const app = await chatServer(t, root, {
    WORKSPACE_MODE: 'isolated',
    REPO_COUNT: '2',
    REPO_0_NAME: 'project-alpha',
    REPO_0_SOURCE: firstSource,
    REPO_0_WT: first,
    REPO_0_BRANCH: 'factory/t9123',
    REPO_1_NAME: 'assets',
    REPO_1_SOURCE: secondSource,
    REPO_1_WT: second,
    REPO_1_BRANCH: 'factory/t9123',
  }, calls);

  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/9123/chat',
    payload: {
      modelRef: { provider: 'claude', model: 'claude-test' },
      message: 'проверка каталогов',
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(calls, [{ cwd: first, extraDirs: [second] }]);
});

test('task-chat с повреждённым generic env не запускается в корне GrigDesk', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sandbox-invalid-chat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const app = await chatServer(t, root, {
    WORKSPACE_MODE: 'isolated',
    REPO_COUNT: '1',
    REPO_0_NAME: 'project-alpha',
    REPO_0_SOURCE: path.join(root, 'project-alpha-source'),
    REPO_0_WT: path.join(root, 'project-alpha-worktree'),
    BE_WT: path.join(root, 'legacy-must-not-open'),
  }, calls);

  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/9123/chat',
    payload: {
      modelRef: { provider: 'claude', model: 'claude-test' },
      message: 'не запускать',
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'invalid_sandbox_env');
  assert.deepEqual(calls, []);
});

test('task-chat не открывает legacy cwd/add-dir', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sandbox-legacy-chat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = legacyEnv(root);
  await Promise.all([mkdir(env.BE_WT), mkdir(env.FE_WT)]);
  const calls = [];
  const app = await chatServer(t, root, env, calls);

  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/9123/chat',
    payload: {
      modelRef: { provider: 'claude', model: 'claude-test' },
      message: 'проверка legacy каталогов',
    },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'invalid_sandbox_env');
  assert.deepEqual(calls, []);
});
