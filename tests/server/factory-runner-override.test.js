// Stage-level override исполнителя: POST /api/tasks/:id/runner/override.
// Guard'ы — как у runner/switch (managed registry, terminal, активный этап),
// сама запись идёт ТОЛЬКО через CLI движка (`factory <task> runner set|clear`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access, mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';
import { routeLaunchEnv } from '../../server/src/lib/factoryRouteCli.ts';
import factoryModule from '../../server/src/modules/factory/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';
const ROUTE_HASH = 'a'.repeat(64);
const CATALOG_HASH = 'b'.repeat(64);

const missing = (file) => access(file).then(() => false, () => true);

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

async function writeTrustedAttempt({ controlDir, task, terminal = null }) {
  const taskRoot = path.join(controlDir, 'protocol-v2', 'tasks', `t${task}`);
  const attemptDir = path.join(taskRoot, 'attempts', ATTEMPT);
  await mkdir(path.join(attemptDir, 'artifacts'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(taskRoot, 'protocol.json'), jsonBytes({
    protocolVersion: 2,
    schema: 1,
  }), { mode: 0o400 });
  await writeCheckedJson(attemptDir, 'attempt', {
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
  });
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
    'workspace-mode\tisolated',
    'stand-ownership\ttask',
    'source-branch\tfactory/t8',
    'container\tdemo',
    'service-host\t127.0.0.1',
    `repo\tdemo\t${path.dirname(controlDir)}/src\t${path.dirname(controlDir)}/work`,
    '',
  ].join('\n'), { mode: 0o400 });
  if (terminal) {
    await writeContentAddressedJson(attemptDir, 'terminal', {
      schema: 1,
      protocolVersion: 2,
      attemptId: ATTEMPT,
      taskId: String(task),
      state: 'finished',
      closedAt: '2026-08-02T12:02:00Z',
      reason: null,
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
    'BUILD=pending',
    ...Object.entries(extra).map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n');
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-runner-override-'));
  const stateDir = path.join(root, 'state');
  const routesDir = path.join(root, 'routes');
  const profilesDir = path.join(root, 'profiles');
  const binDir = path.join(root, 'bin');
  const controlDir = path.join(root, 'control');
  const runnersDir = path.join(root, 'lib', 'runners');
  await Promise.all([
    mkdir(path.join(stateDir, 'logs'), { recursive: true }),
    mkdir(routesDir, { recursive: true }),
    mkdir(path.join(profilesDir, 'demo'), { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(runnersDir, { recursive: true }),
  ]);
  // Kimi остаётся валидным, но не установленным именем; DeepSeek уже поставлен.
  for (const name of ['claude.sh', 'codex.sh', 'deepseek.sh', 'index.sh']) {
    await writeFile(path.join(runnersDir, name), '# адаптер\n');
  }

  // Legacy реестр: виден, но недоступен для мутаций.
  await writeFile(path.join(stateDir, 't7.pipeline'), [
    'PROFILE=demo',
    'ROUTE=feature',
    'RUN_PROTOCOL=2',
    'WF_STATUS=running',
    'BUILD=running',
    '',
  ].join('\n'));
  // Управляемая попытка (активна) и закрытая попытка.
  await writeFile(path.join(stateDir, 't8.pipeline'), routeRegistry());
  await writeTrustedAttempt({ controlDir, task: '8' });
  await writeFile(path.join(stateDir, 't9.pipeline'), routeRegistry({ RESULT: 'completed' }));
  await writeTrustedAttempt({ controlDir, task: '9', terminal: 'completed' });

  const callsLog = path.join(root, 'factory.calls');
  const factoryBin = path.join(binDir, 'factory');
  await writeFile(factoryBin, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${callsLog}"\n`, { mode: 0o755 });

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
  // Проекция графа проверяется своими тестами; здесь важны guard'ы endpoint'а,
  // поэтому узел подставляется управляемым двойником.
  const graph = {
    daemonAlive: false,
    keys: { build: 'BUILD' },
    runnerKeys: { build: 'BUILD' },
    nodes: { build: ['agent', 'Build', ''] },
    statuses: { build: 'pending' },
    nodeMeta: {
      build: { runner: { stage: 'BUILD', primary: 'claude', actual: null, chain: ['claude', 'codex'] } },
    },
  };
  adapter.getTaskGraph = async () => graph;

  const app = Fastify({ logger: false });

  await app.register(factoryModule, {
    factoryState: adapter,
    config,
    prefs: { read: () => ({}) },
    tracker: null,
    analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null },
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, graph, callsLog };
}

test('override отклоняет битый формат stage/primary до состояния и движка', async (t) => {
  const { app, callsLog } = await fixture(t);
  for (const payload of [
    { stage: 'build!', primary: 'codex' },
    { stage: '', primary: 'codex' },
    { stage: 'BUILD', primary: 'Codex!' },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/tasks/8/runner/override', payload });
    assert.equal(response.statusCode, 400, `${JSON.stringify(payload)}: ${response.body}`);
    assert.equal(response.json().error, 'bad_runner_override');
  }
  assert.equal(await missing(callsLog), true);
});

test('override на legacy и закрытой попытке fail-closed', async (t) => {
  const { app, callsLog } = await fixture(t);
  const legacy = await app.inject({
    method: 'POST', url: '/api/tasks/7/runner/override', payload: { stage: 'BUILD', primary: 'codex' },
  });
  assert.equal(legacy.statusCode, 409, legacy.body);
  assert.equal(legacy.json().error, 'legacy_task_read_only');

  const terminal = await app.inject({
    method: 'POST', url: '/api/tasks/9/runner/override', payload: { stage: 'BUILD', primary: 'codex' },
  });
  assert.equal(terminal.statusCode, 409, terminal.body);
  assert.equal(terminal.json().error, 'attempt_terminal');

  const unknown = await app.inject({
    method: 'POST', url: '/api/tasks/99/runner/override', payload: { stage: 'BUILD', primary: 'codex' },
  });
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.equal(await missing(callsLog), true);
});

test('override на этапе с активным запуском отправляет в switch', async (t) => {
  const { app, graph, callsLog } = await fixture(t);
  graph.daemonAlive = true;
  graph.statuses.build = 'run';
  graph.nodeMeta.build.runner.actual = 'claude';
  const response = await app.inject({
    method: 'POST', url: '/api/tasks/8/runner/override', payload: { stage: 'BUILD', primary: 'codex' },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'runner_active_use_switch');
  assert.equal(await missing(callsLog), true);
});

test('остановленный run со старым runner.actual принимает override для следующего resume', async (t) => {
  const { app, graph, callsLog } = await fixture(t);
  graph.daemonAlive = false;
  graph.statuses.build = 'run';
  graph.nodeMeta.build.runner.actual = 'claude';

  const response = await app.inject({
    method: 'POST', url: '/api/tasks/8/runner/override', payload: { stage: 'BUILD', primary: 'codex' },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true);
  assert.match(await readFile(callsLog, 'utf8'), /^8 runner set BUILD codex$/m);
});

test('live-switch остановленного run отвечает понятной ошибкой до вызова движка', async (t) => {
  const { app, graph, callsLog } = await fixture(t);
  graph.daemonAlive = false;
  graph.statuses.build = 'run';
  graph.nodeMeta.build.runner.actual = 'claude';

  const response = await app.inject({
    method: 'POST', url: '/api/tasks/8/runner/switch', payload: { stage: 'BUILD', target: 'codex' },
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'runner_not_active');
  assert.match(response.json().message, /Прогон остановлен/);
  assert.equal(await missing(callsLog), true);
});

test('live-switch живого run вызывает canonical runner switch', async (t) => {
  const { app, graph, callsLog } = await fixture(t);
  graph.daemonAlive = true;
  graph.statuses.build = 'run';
  graph.nodeMeta.build.runner.actual = 'claude';

  const response = await app.inject({
    method: 'POST', url: '/api/tasks/8/runner/switch', payload: { stage: 'BUILD', target: 'codex' },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true);
  assert.match(await readFile(callsLog, 'utf8'), /^8 runner switch BUILD codex$/m);
});

test('override отклоняет этап вне маршрута попытки', async (t) => {
  const { app, callsLog } = await fixture(t);
  const response = await app.inject({
    method: 'POST', url: '/api/tasks/8/runner/override', payload: { stage: 'SHIP', primary: 'codex' },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'stage_unknown');
  assert.equal(await missing(callsLog), true);
});

test('override отклоняет неустановленного исполнителя', async (t) => {
  const { app, callsLog } = await fixture(t);
  const response = await app.inject({
    method: 'POST', url: '/api/tasks/8/runner/override', payload: { stage: 'BUILD', primary: 'kimi' },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'runner_unknown');
  assert.equal(await missing(callsLog), true);
});

test('валидный override пишется через runner set движка', async (t) => {
  const { app, callsLog } = await fixture(t);
  const response = await app.inject({
    method: 'POST', url: '/api/tasks/8/runner/override', payload: { stage: 'BUILD', primary: 'codex' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true);
  assert.match(await readFile(callsLog, 'utf8'), /^8 runner set BUILD codex$/m);
});

test('DeepSeek доступен для override, а его точный binary pin доезжает в Factory env', async (t) => {
  const { app, callsLog } = await fixture(t);
  const response = await app.inject({
    method: 'POST', url: '/api/tasks/8/runner/override',
    payload: { stage: 'BUILD', primary: 'deepseek' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(await readFile(callsLog, 'utf8'), /^8 runner set BUILD deepseek$/m);

  const bin = '/opt/grigdesk/deepseek/install/current/node_modules/.bin/dsh';
  const env = routeLaunchEnv({
    rootDir: '/opt/grigdesk', factoryHome: '/opt/grigdesk/engine',
    profilesDir: '/opt/grigdesk/profiles', factoryConfigRoot: '/tmp/factory-config',
    routesDir: '/opt/grigdesk/routes', stateDir: '/tmp/factory-state',
    factoryControlDir: '/tmp/factory-control', factoryBin: '/opt/grigdesk/engine/bin/factory',
    deepseekBinOverride: bin,
  });
  assert.equal(env.GRIGDESK_DEEPSEEK_BIN, bin);
});

test('пустой primary снимает override через runner clear, идемпотентно', async (t) => {
  const { app, callsLog } = await fixture(t);
  for (const payload of [{ stage: 'BUILD', primary: '' }, { stage: 'BUILD' }]) {
    const response = await app.inject({ method: 'POST', url: '/api/tasks/8/runner/override', payload });
    assert.equal(response.statusCode, 200, `${JSON.stringify(payload)}: ${response.body}`);
    assert.equal(response.json().ok, true);
  }
  const calls = (await readFile(callsLog, 'utf8')).trim().split('\n');
  assert.deepEqual(calls, ['8 runner clear BUILD', '8 runner clear BUILD']);
});
