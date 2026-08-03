// Single-engine cutover: one runtime root, pinned route attempts are actionable,
// historical registries are visible but every mutation is fail-closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access, mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { FactoryStateAdapter } from '../../server/src/adapters/factory-state.js';
import factoryModule from '../../server/src/modules/factory/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';
const ROUTE_HASH = 'a'.repeat(64);
const CATALOG_HASH = 'b'.repeat(64);

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeCheckedJson(dir, name, value) {
  const content = jsonBytes(value);
  await writeFile(path.join(dir, `${name}.json`), content, { mode: 0o400 });
  await writeFile(
    path.join(dir, `${name}.sha256`),
    `${createHash('sha256').update(content).digest('hex')}\n`,
    { mode: 0o400 },
  );
}

async function writeContentAddressedJson(dir, prefix, value) {
  const content = jsonBytes(value);
  const hash = createHash('sha256').update(content).digest('hex');
  await writeFile(path.join(dir, `${prefix}.${hash}.json`), content, { mode: 0o400 });
}

async function writeTrustedAttempt({
  controlDir, task, workspaceMode, source, workspace, sourceBranch, terminal = null,
}) {
  const taskRoot = path.join(controlDir, 'protocol-v2', 'tasks', `t${task}`);
  const attemptDir = path.join(taskRoot, 'attempts', ATTEMPT);
  await mkdir(path.join(attemptDir, 'artifacts'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(taskRoot, 'protocol.json'), jsonBytes({
    protocolVersion: 2,
    schema: 1,
  }), { mode: 0o400 });
  const attempt = {
    schema: 1,
    protocolVersion: 2,
    attemptId: ATTEMPT,
    taskId: String(task),
    profile: 'demo',
    createdAt: '2026-08-02T12:00:00Z',
    routesDir: path.join(path.dirname(controlDir), 'routes'),
    catalogHash: CATALOG_HASH,
    origin: 'fresh',
    previousAttemptId: null,
    recoveryReason: null,
  };
  await writeCheckedJson(attemptDir, 'attempt', attempt);
  await writeCheckedJson(attemptDir, 'pins', {
    schema: 1,
    protocolVersion: 2,
    attemptId: ATTEMPT,
    taskId: String(task),
    profile: 'demo',
    catalogHash: CATALOG_HASH,
    bootstrap: { id: 'scout', catalogHash: CATALOG_HASH },
  });
  await writeContentAddressedJson(attemptDir, 'route-pin', {
    schema: 1,
    protocolVersion: 2,
    attemptId: ATTEMPT,
    taskId: String(task),
    profile: 'demo',
    catalogHash: CATALOG_HASH,
    routeId: 'feature',
    routeHash: ROUTE_HASH,
    selectedAt: '2026-08-02T12:01:00Z',
  });
  await writeFile(path.join(attemptDir, 'artifacts', 'profile-contract.tsv'), [
    'schema\t1',
    'repos-mode\tgeneric',
    `workspace-mode\t${workspaceMode}`,
    `stand-ownership\t${workspaceMode === 'shared' ? 'external' : 'task'}`,
    `source-branch\t${sourceBranch}`,
    'container\tdemo',
    'service-host\t127.0.0.1',
    ...(workspaceMode === 'shared' ? ['frontend-port\t8830', 'api-port\t8830'] : []),
    `repo\tdemo\t${source}\t${workspace}`,
    '',
  ].join('\n'), { mode: 0o400 });
  if (terminal) {
    await writeContentAddressedJson(attemptDir, 'terminal', {
      schema: 1,
      protocolVersion: 2,
      attemptId: ATTEMPT,
      taskId: String(task),
      state: terminal === 'completed' ? 'finished' : 'abandoned',
      closedAt: '2026-08-02T12:02:00Z',
      reason: terminal === 'completed' ? null : 'fixture abandon',
    });
  } else {
    await writeFile(path.join(taskRoot, 'active-attempt.json'), jsonBytes({
      schema: 1,
      protocolVersion: 2,
      taskId: String(task),
      attemptId: ATTEMPT,
    }), { mode: 0o400 });
  }
}

function routeRegistry(extra = {}) {
  return [
    'PROFILE=demo',
    'ROUTE=feature',
    'RUN_PROTOCOL=2',
    'CATALOG_PROTOCOL=route-v2',
    `ATTEMPT_ID=${ATTEMPT}`,
    `ROUTE_HASH=${ROUTE_HASH}`,
    'DELIVERY_MODE=disabled',
    'WF_STATUS=running',
    'STALLED_HUMAN=0',
    'BUILD=running',
    ...Object.entries(extra).map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n');
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-single-engine-'));
  const stateDir = path.join(root, 'state');
  const routesDir = path.join(root, 'routes');
  const profilesDir = path.join(root, 'profiles');
  const binDir = path.join(root, 'bin');
  const repoDir = path.join(root, 'main-checkout');
  const taskSourceDir = path.join(root, 'task-source');
  const taskWorktreeDir = path.join(root, 'task-worktree');
  const controlDir = path.join(root, 'control');
  await Promise.all([
    mkdir(path.join(stateDir, 'logs'), { recursive: true }),
    mkdir(routesDir, { recursive: true }),
    mkdir(path.join(profilesDir, 'demo'), { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(repoDir, { recursive: true }),
    mkdir(taskSourceDir, { recursive: true }),
    mkdir(taskWorktreeDir, { recursive: true }),
  ]);
  await writeFile(path.join(profilesDir, 'demo', 'graph.json'), JSON.stringify({
    capabilities: [],
    default_route: 'feature',
    routes: {
      feature: {
        pos: { build: [0, 0] },
        edges: [],
      },
    },
  }));

  // Legacy launcher also wrote RUN_PROTOCOL=2; without the pinned route identity this
  // registry must remain read-only.
  await writeFile(path.join(stateDir, 't7.pipeline'), [
    'PROFILE=demo',
    'ROUTE=feature',
    'RUN_PROTOCOL=2',
    'WF_STATUS=running',
    'BUILD=running',
    '',
  ].join('\n'));

  await writeFile(path.join(stateDir, 't8.pipeline'), routeRegistry());
  await writeFile(path.join(stateDir, 't8.env'), [
    'WORKSPACE_MODE=isolated',
    'STAND_OWNERSHIP=task',
    'SOURCE_BRANCH=factory/t8',
    'REPO_COUNT=1',
    'REPO_0_NAME=demo',
    `REPO_0_SOURCE=${taskSourceDir}`,
    `REPO_0_WT=${taskWorktreeDir}`,
    'REPO_0_BRANCH=factory/t8',
    '',
  ].join('\n'));

  await writeFile(path.join(stateDir, 't9.pipeline'), routeRegistry({ RESULT: 'completed' }));
  await writeFile(path.join(stateDir, 't9.env'), [
    'WORKSPACE_MODE=shared',
    'STAND_OWNERSHIP=external',
    'SOURCE_BRANCH=main',
    'REPO_COUNT=1',
    'REPO_0_NAME=demo',
    `REPO_0_SOURCE=${repoDir}`,
    `REPO_0_WT=${repoDir}`,
    'REPO_0_BRANCH=main',
    'FE_PORT=8830',
    'API_PORT=8830',
    '',
  ].join('\n'));
  await writeTrustedAttempt({
    controlDir,
    task: '8',
    workspaceMode: 'isolated',
    source: taskSourceDir,
    workspace: taskWorktreeDir,
    sourceBranch: 'factory/t8',
  });
  await writeTrustedAttempt({
    controlDir,
    task: '9',
    workspaceMode: 'shared',
    source: repoDir,
    workspace: repoDir,
    sourceBranch: 'main',
    terminal: 'completed',
  });

  const callsLog = path.join(root, 'factory.calls');
  const downLog = path.join(root, 'down.calls');
  const gitLog = path.join(root, 'git.calls');
  const factoryBin = path.join(binDir, 'factory');
  await writeFile(factoryBin, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${callsLog}"\n`, { mode: 0o755 });
  await writeFile(
    path.join(profilesDir, 'demo', 'down.sh'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${downLog}"\n`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(binDir, 'git'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${gitLog}"\nexit 0\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });

  const config = {
    factoryHome: root,
    factoryBin,
    factoryConfigRoot: path.join(root, 'config'),
    factoryControlDir: controlDir,
    routesDir,
    ticketsDir: path.join(root, 'tickets'),
    stateDir,
    profilesDir,
    factoryProfile: 'demo',
    sandboxDownCmd: '',
  };
  const adapter = new FactoryStateAdapter({ stateDir, routesDir, profilesDir, controlDir });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return {
    root, stateDir, routesDir, profilesDir, config, adapter, callsLog, downLog, gitLog, repoDir,
  };
}

async function server(t, fx) {
  const app = Fastify({ logger: false });
  await app.register(factoryModule, {
    factoryState: fx.adapter,
    config: fx.config,
    prefs: { read: () => ({}) },
    b24: null,
    analyzer: { readClarifications: async () => null },
  });
  await app.ready();
  t.after(async () => app.close());
  return app;
}

async function missing(file) {
  return access(file).then(() => false, () => true);
}

test('STATE-01: один root показывает current и legacy как read-only без generation branch', async (t) => {
  const fx = await fixture(t);
  assert.deepEqual(await fx.adapter.listTaskIds(), ['7', '8', '9']);

  const legacy = await fx.adapter.getTaskSummary('7');
  const current = await fx.adapter.getTaskSummary('8');
  assert.equal(legacy.readOnly, true);
  assert.equal(current.readOnly, false);
  assert.equal(current.result, null);
  assert.equal(current.workspaceMode, 'isolated');
  assert.equal('generation' in current, false);
});

test('STATE-02: missing pinned route fails graph instead of falling back to graph.json', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    fx.adapter.getTaskGraph('8'),
    /закреплённый маршрут недоступен|повреждён/,
  );
  const historical = await fx.adapter.getTaskGraph('7');
  assert.equal(historical.readOnly, true, 'legacy graph остаётся только read-only представлением');
});

test('STATE-03: every legacy mutation returns 409 before factory/down/git execution', async (t) => {
  const fx = await fixture(t);
  const app = await server(t, fx);
  const cases = [
    ['POST', '/api/tasks/7/launch', {
      profile: 'demo', route: 'feature', title: 'Нельзя', description: 'Нельзя',
      sourceUrl: 'https://example.test/tasks/7', acceptanceCriteria: [],
    }],
    ['POST', '/api/tasks/7/gate/GATE_ACCEPT/approve', {}],
    ['POST', '/api/tasks/7/stage/BUILD/running', { comment: 'назад' }],
    ['POST', '/api/tasks/7/runner/switch', { stage: 'BUILD', target: 'codex' }],
    ['POST', '/api/tasks/7/runner/override', { stage: 'BUILD', primary: 'codex' }],
    ['POST', '/api/tasks/7/instruction', { text: 'нельзя' }],
    ['POST', '/api/tasks/7/sandbox/down', {}],
    ['POST', '/api/tasks/7/sandbox/retry', {}],
    ['POST', '/api/tasks/7/close', {}],
    ['POST', '/api/tasks/7/resume', {}],
  ];
  for (const [method, url, payload] of cases) {
    const response = await app.inject({ method, url, payload });
    assert.equal(response.statusCode, 409, `${url}: ${response.body}`);
    assert.equal(response.json().error, 'legacy_task_read_only', url);
  }
  assert.equal(await missing(fx.callsLog), true);
  assert.equal(await missing(fx.downLog), true);
  assert.equal(await missing(fx.gitLog), true);
});

test('STATE-04: shared workspace forbids down/retry and close never touches stand or branch', async (t) => {
  const fx = await fixture(t);
  const app = await server(t, fx);

  for (const url of ['/api/tasks/9/sandbox/down', '/api/tasks/9/sandbox/retry']) {
    const response = await app.inject({ method: 'POST', url, payload: {} });
    assert.equal(response.statusCode, 409, `${url}: ${response.body}`);
    assert.equal(response.json().error, 'shared_workspace_lifecycle_forbidden');
  }

  const closed = await app.inject({ method: 'POST', url: '/api/tasks/9/close', payload: {} });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().workspaceMode, 'shared');
  assert.deepEqual(closed.json().branches, []);
  assert.equal(await missing(fx.downLog), true, 'shared stand lifecycle script не вызван');
  assert.equal(await missing(fx.gitLog), true, 'даже git probe/branch -D не вызван');
  assert.equal(await readFile(path.join(fx.repoDir, '..', 'state', 'archive', 't9.pipeline'), 'utf8')
    .then(Boolean), true);
  assert.equal(await access(fx.repoDir).then(() => true), true, 'основной checkout остаётся на месте');
});

test('STATE-05: forged terminal projection cannot skip exact abandon before down/retry', async (t) => {
  const fx = await fixture(t);
  const app = await server(t, fx);
  await writeFile(path.join(fx.stateDir, 't8.pipeline'), routeRegistry({ RESULT: 'abandoned' }));

  for (const url of ['/api/tasks/8/sandbox/down', '/api/tasks/8/sandbox/retry']) {
    const response = await app.inject({ method: 'POST', url, payload: {} });
    assert.equal(response.statusCode, 409, `${url}: ${response.body}`);
    assert.equal(response.json().error, 'attempt_integrity_failed');
  }
  assert.equal(await missing(fx.callsLog), true, 'forged RESULT не пропущен в abandon/start');
  assert.equal(await missing(fx.downLog), true, 'forged RESULT не разрешает down.sh');
});

test('STATE-06: trusted shared ownership wins over forged registry lifecycle fields', async (t) => {
  const fx = await fixture(t);
  const app = await server(t, fx);
  await writeFile(path.join(fx.stateDir, 't9.pipeline'), routeRegistry({
    RESULT: 'completed',
    WORKSPACE_MODE: 'isolated',
    STAND_OWNERSHIP: 'task',
  }));

  for (const url of ['/api/tasks/9/sandbox/down', '/api/tasks/9/sandbox/retry']) {
    const response = await app.inject({ method: 'POST', url, payload: {} });
    assert.equal(response.statusCode, 409, `${url}: ${response.body}`);
    assert.equal(response.json().error, 'shared_workspace_lifecycle_forbidden');
  }
  assert.equal(await missing(fx.downLog), true);
  assert.equal(await missing(fx.callsLog), true);
});

test('STATE-07: forged env cannot turn trusted shared checkout into isolated lifecycle', async (t) => {
  const fx = await fixture(t);
  const app = await server(t, fx);
  await writeFile(path.join(fx.stateDir, 't9.env'), [
    'WORKSPACE_MODE=isolated',
    'STAND_OWNERSHIP=task',
    'SOURCE_BRANCH=main',
    'REPO_COUNT=1',
    'REPO_0_NAME=demo',
    `REPO_0_SOURCE=${fx.repoDir}`,
    `REPO_0_WT=${fx.repoDir}`,
    'REPO_0_BRANCH=main',
    'FE_PORT=8830',
    'API_PORT=8830',
    '',
  ].join('\n'));

  for (const url of ['/api/tasks/9/sandbox/down', '/api/tasks/9/sandbox/retry', '/api/tasks/9/close']) {
    const response = await app.inject({ method: 'POST', url, payload: {} });
    assert.equal(response.statusCode, 409, `${url}: ${response.body}`);
    assert.equal(response.json().error, 'attempt_integrity_failed');
  }
  assert.equal(await missing(fx.downLog), true);
  assert.equal(await missing(fx.gitLog), true);
  assert.equal(await access(fx.repoDir).then(() => true), true);
});

test('STATE-07b: shared service ports are pinned by the immutable profile contract', async (t) => {
  const fx = await fixture(t);
  const app = await server(t, fx);
  await writeFile(path.join(fx.stateDir, 't9.env'), [
    'WORKSPACE_MODE=shared',
    'STAND_OWNERSHIP=external',
    'SOURCE_BRANCH=main',
    'REPO_COUNT=1',
    'REPO_0_NAME=demo',
    `REPO_0_SOURCE=${fx.repoDir}`,
    `REPO_0_WT=${fx.repoDir}`,
    'REPO_0_BRANCH=main',
    'FE_PORT=9999',
    'API_PORT=8830',
    '',
  ].join('\n'));

  const response = await app.inject({ method: 'POST', url: '/api/tasks/9/close', payload: {} });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'attempt_integrity_failed');
  assert.equal(await missing(fx.downLog), true);
  assert.equal(await missing(fx.gitLog), true);
});

test('STATE-08: forged valid-looking attempt identity cannot reach resume engine', async (t) => {
  const fx = await fixture(t);
  const app = await server(t, fx);
  await writeFile(path.join(fx.stateDir, 't8.pipeline'), routeRegistry({
    ATTEMPT_ID: 'a_ffffffffffffffffffffffffffffffff',
  }));

  const response = await app.inject({ method: 'POST', url: '/api/tasks/8/resume', payload: {} });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'attempt_integrity_failed');
  assert.equal(await missing(fx.callsLog), true);
});

test('STATE-09: provider-writable state can never be configured as trusted control root', async (t) => {
  const fx = await fixture(t);
  const unsafe = new FactoryStateAdapter({
    stateDir: fx.stateDir,
    routesDir: fx.routesDir,
    profilesDir: fx.profilesDir,
    controlDir: fx.stateDir,
  });
  const registry = (await unsafe.readRegistry('8')).registry;
  await assert.rejects(
    unsafe.readTrustedAttempt('8', registry),
    /trusted control and provider-writable state overlap/,
  );
});

test('STATE-10: recovery endpoint inert and cannot resume anything automatically', async (t) => {
  const fx = await fixture(t);
  const app = await server(t, fx);
  const response = await app.inject({ method: 'GET', url: '/api/factory/recovery' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    enabled: false,
    running: false,
    checkedAt: null,
    items: [],
    reason: 'manual_resume_only',
  });
  assert.equal(await missing(fx.callsLog), true);
});
