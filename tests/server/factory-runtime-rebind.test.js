// Ручная перепривязка рантайма: остановленная попытка снимает закрепление за
// поставкой сервера, чтобы следующий запуск получил текущий инструмент этапа.
// Живой прогон и закрытая попытка перепривязке не подлежат.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { prepareFactoryRouteLaunch } from '../../server/src/lib/factoryLaunch.ts';
import { factoryRuntimeScope } from '../../server/src/lib/factoryRuntimePins.ts';
import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';
import factoryModule from '../../server/src/modules/factory/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';
const ROUTE_HASH = 'a'.repeat(64);
const CATALOG_HASH = 'b'.repeat(64);
const HEAD_HASH = 'c'.repeat(64);

/**
 * Каноническая форма digest_value движка: json.dumps с сортировкой ключей
 * без пробелов и концом строки, как пишет engine/lib/attempt-stage-state.sh.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

/**
 * Каноническая форма runtime попытки: currentNode задан у paused/ready и пуст
 * только у stopped, а lastCommit всегда указывает на предшествующий коммит узла.
 */
function stageRuntime({
  node = 'ship',
  state = 'ready',
  sequence = 8,
} = {}) {
  return {
    schema: 1,
    protocolVersion: 2,
    taskId: '7',
    attemptId: ATTEMPT,
    profile: 'demo',
    catalogHash: CATALOG_HASH,
    route: 'feature',
    routeHash: ROUTE_HASH,
    entry: 'build',
    sequence,
    headEventHash: HEAD_HASH,
    cursor: {
      currentNode: state === 'stopped' ? null : node,
      lastCommit: {
        node: 'lint',
        outcome: 'done',
        sequence: sequence - 1,
      },
      pauseReason: state === 'paused' ? 'human-gate' : null,
      state,
      stop: state === 'stopped' ? 'done' : null,
    },
  };
}

function runtimeEnvelope(runtime) {
  const checksum = createHash('sha256')
    .update(`${canonicalJson(runtime)}\n`, 'utf8')
    .digest('hex');

  return `${JSON.stringify({ checksum, runtime }, null, 2)}\n`;
}

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

/**
 * Разворачивает trusted ledger попытки t7 с каноническим курсором: маршрут rebind
 * проходит managedRegistry, поэтому ledger обязан сходиться с проекцией прогона.
 */
async function fixture(t, { cursor = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-runtime-rebind-'));
  const stateDir = path.join(root, 'state');
  const controlDir = path.join(root, 'control');
  const routesDir = path.join(root, 'routes');
  const profilesDir = path.join(root, 'profiles');
  const binDir = path.join(root, 'bin');
  const worktree = path.join(root, 'worktree');

  await Promise.all([
    mkdir(controlDir, { mode: 0o700 }),
    mkdir(path.join(stateDir, 'logs'), { recursive: true }),
    mkdir(routesDir, { recursive: true }),
    mkdir(path.join(profilesDir, 'demo'), { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(worktree, { recursive: true }),
  ]);

  const taskRoot = path.join(controlDir, 'protocol-v2', 'tasks', 't7');
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
    taskId: '7',
    profile: 'demo',
    createdAt: '2026-08-02T12:00:00Z',
    routesDir,
    catalogHash: CATALOG_HASH,
    origin: 'fresh',
    previousAttemptId: null,
    recoveryReason: null,
  });
  await writeCheckedJson(attemptDir, 'pins', {
    schema: 1,
    protocolVersion: 2,
    attemptId: ATTEMPT,
    taskId: '7',
    profile: 'demo',
    catalogHash: CATALOG_HASH,
    bootstrap: { id: 'scout', catalogHash: CATALOG_HASH },
  });
  await writeContentAddressedJson(attemptDir, 'route-pin', {
    schema: 1,
    protocolVersion: 2,
    attemptId: ATTEMPT,
    taskId: '7',
    profile: 'demo',
    catalogHash: CATALOG_HASH,
    routeId: 'feature',
    routeHash: ROUTE_HASH,
    selectedAt: '2026-08-02T12:01:00Z',
  });
  await writeFile(path.join(attemptDir, 'artifacts', 'profile-contract.tsv'), [
    'schema\t1', 'repos-mode\tgeneric', 'workspace-mode\tisolated', 'stand-ownership\ttask',
    'source-branch\tfactory/t7', 'container\tdemo', 'service-host\t127.0.0.1',
    `repo\tdemo\t${worktree}\t${worktree}\tfactory/t7`, '',
  ].join('\n'), { mode: 0o400 });
  await writeFile(path.join(taskRoot, 'active-attempt.json'), jsonBytes({
    schema: 1,
    protocolVersion: 2,
    taskId: '7',
    attemptId: ATTEMPT,
  }), { mode: 0o400 });

  if (cursor) {
    const stageDir = path.join(attemptDir, 'stage-results');

    await mkdir(stageDir, { mode: 0o700 });
    await writeFile(path.join(stageDir, 'runtime.json'), runtimeEnvelope(cursor), { mode: 0o400 });
  }

  await writeFile(path.join(stateDir, 't7.pipeline'), [
    'PROFILE=demo', 'ROUTE=feature', 'RUN_PROTOCOL=2', 'CATALOG_PROTOCOL=route-v2',
    `ATTEMPT_ID=${ATTEMPT}`, `ROUTE_HASH=${ROUTE_HASH}`, 'DELIVERY_MODE=disabled',
    'WF_STATUS=running', 'STALLED_HUMAN=1', 'BUILD=done',
    'GATE_ACCEPT=waiting', 'SHIP=pending', '',
  ].join('\n'));

  const callsLog = path.join(root, 'factory.calls');
  const factoryBin = path.join(binDir, 'factory');
  const factoryStub = `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${callsLog}"\n`;

  await writeFile(factoryBin, factoryStub, { mode: 0o755 });
  await writeFile(path.join(binDir, 'systemd-run'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  await writeFile(
    path.join(binDir, 'systemctl'),
    '#!/usr/bin/env bash\necho inactive\nexit 3\n',
    { mode: 0o755 },
  );

  const config = {
    rootDir: root,
    dataHome: path.join(root, 'data'),
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
  const adapter = new FactoryStateAdapter({
    stateDir,
    routesDir,
    profilesDir,
    controlDir,
  });

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    stateDir,
    controlDir,
    config,
    adapter,
    callsLog,
  };
}

/**
 * Поднимает модуль фабрики на фикстурном адаптере и конфиге: маршрут rebind
 * проходит тот же managedRegistry и настоящий unpin, без подмены библиотеки.
 */
async function server(t, fx) {
  const app = Fastify({ logger: false });

  await app.register(factoryModule, {
    factoryState: fx.adapter,
    config: fx.config,
    prefs: { read: () => ({}) },
    tracker: null,
    analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null },
  });
  await app.ready();
  t.after(async () => app.close());

  return app;
}

function authorityPath(fx) {
  const roots = {
    controlRoot: fx.controlDir,
    stateRoot: fx.stateDir,
    profileRoot: fx.config.profilesDir,
  };

  return path.join(
    fx.controlDir, 'server-runtimes', factoryRuntimeScope(roots), `${ATTEMPT}.json`,
  );
}

test('runtime-rebind снимает pin остановленной попытки; повтор идемпотентен', async (t) => {
  const fx = await fixture(t, { cursor: stageRuntime() });

  fx.adapter.isDaemonAlive = () => false;

  await prepareFactoryRouteLaunch(fx.config, ['7', 'resume', '--profile', 'demo', '--attempt', ATTEMPT]);

  const authority = authorityPath(fx);
  const before = JSON.parse(await readFile(authority, 'utf8'));

  const app = await server(t, fx);
  const first = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/runtime-rebind',
    payload: {},
  });

  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().ok, true);
  assert.equal(first.json().unpinned, true);
  assert.equal(first.json().packageId, before.packageId);
  assert.match(first.json().note, /Закрепление снято/u);
  await assert.rejects(() => readFile(authority, 'utf8'), /ENOENT/u);

  const second = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/runtime-rebind',
    payload: {},
  });

  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().unpinned, false);
  assert.equal(second.json().packageId, null);
  assert.match(second.json().note, /Закрепления не было/u);
});

test('runtime-rebind отказывает живому прогону и сохраняет pin', async (t) => {
  const fx = await fixture(t, { cursor: stageRuntime() });

  fx.adapter.isDaemonAlive = () => true;

  await prepareFactoryRouteLaunch(fx.config, ['7', 'resume', '--profile', 'demo', '--attempt', ATTEMPT]);

  const authority = authorityPath(fx);
  const before = await readFile(authority, 'utf8');

  const app = await server(t, fx);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/runtime-rebind',
    payload: {},
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'run_in_progress');
  assert.equal(await readFile(authority, 'utf8'), before);
});
