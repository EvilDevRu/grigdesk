import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { FactoryStateAdapter } from '../../../server/src/adapters/factoryState.ts';
import factoryModule from '../../../server/src/modules/factory/index.ts';

const requireFromServer = createRequire(new URL('../../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';
const ROUTE_HASH = 'a'.repeat(64);
const CATALOG_HASH = 'b'.repeat(64);
const HEAD_HASH = 'c'.repeat(64);

/**
 * Контрольная сумма runtime использует каноническую форму digest_value движка.
 * Ключи каждого вложенного объекта сортируются до сериализации без пробелов.
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
 * Проекция этапов содержит exact identity и курсор до либо после решения.
 * Остановленный курсор завершён, остальные состояния продолжают на явном узле.
 */
function stageRuntime({ node = 'gate_accept', state = 'paused', sequence = 8 } = {}) {
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
  const checksum = createHash('sha256').update(`${canonicalJson(runtime)}\n`).digest('hex');

  return `${JSON.stringify({ checksum, runtime }, null, 2)}\n`;
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Immutable документы читаются тем же trusted reader, что и в настоящем HTTP-пути.
 * Контрольная сумма хранится отдельно; для route-pin hash входит в имя файла.
 */
async function writeCheckedJson(dir, name, value, contentAddressed = false) {
  const content = jsonBytes(value);
  const hash = createHash('sha256').update(content).digest('hex');
  const base = contentAddressed ? `${name}.${hash}` : name;

  await writeFile(path.join(dir, `${base}.json`), content, { mode: 0o400 });

  if (!contentAddressed) {
    await writeFile(path.join(dir, `${name}.sha256`), `${hash}\n`, { mode: 0o400 });
  }
}

/**
 * Изолированный реестр t7 и проверенный ledger не обращаются к живым прогонам.
 * Подставной factory сначала заменяет runtime, затем засыпает до убийства по сроку.
 */
export async function factoryDecisionFixture(t, { after = null, before = {}, corruptAfter = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-decision-ledger-'));
  const stateDir = path.join(root, 'state');
  const controlDir = path.join(root, 'control');
  const routesDir = path.join(root, 'routes');
  const profilesDir = path.join(root, 'profiles');
  const binDir = path.join(root, 'bin');
  const worktree = path.join(root, 'worktree');

  await Promise.all([
    mkdir(path.join(stateDir, 'logs'), { recursive: true }),
    mkdir(routesDir),
    mkdir(path.join(profilesDir, 'demo'), { recursive: true }),
    mkdir(binDir),
    mkdir(worktree),
  ]);

  const taskRoot = path.join(controlDir, 'protocol-v2', 'tasks', 't7');
  const attemptDir = path.join(taskRoot, 'attempts', ATTEMPT);
  const stageDir = path.join(attemptDir, 'stage-results');

  await mkdir(path.join(attemptDir, 'artifacts'), { recursive: true, mode: 0o700 });
  await mkdir(stageDir, { mode: 0o700 });
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
    bootstrap: {
      id: 'scout',
      catalogHash: CATALOG_HASH,
    },
  });
  await writeCheckedJson(attemptDir, 'route-pin', {
    schema: 1,
    protocolVersion: 2,
    attemptId: ATTEMPT,
    taskId: '7',
    profile: 'demo',
    catalogHash: CATALOG_HASH,
    routeId: 'feature',
    routeHash: ROUTE_HASH,
    selectedAt: '2026-08-02T12:01:00Z',
  }, true);
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

  const runtimeFile = path.join(stageDir, 'runtime.json');
  const afterFile = path.join(root, 'after.json');

  await writeFile(runtimeFile, runtimeEnvelope(stageRuntime(before)), { mode: 0o400 });
  await writeFile(afterFile, corruptAfter ? '{}' : runtimeEnvelope(stageRuntime(after || {})), {
    mode: 0o400,
  });
  await writeFile(path.join(stateDir, 't7.pipeline'), [
    'PROFILE=demo', 'ROUTE=feature', 'RUN_PROTOCOL=2', 'CATALOG_PROTOCOL=route-v2',
    `ATTEMPT_ID=${ATTEMPT}`, `ROUTE_HASH=${ROUTE_HASH}`, 'DELIVERY_MODE=disabled',
    'WF_STATUS=running', 'STALLED_HUMAN=1', 'BUILD=done', 'LINT=done',
    'GATE_ACCEPT=waiting', 'SHIP=pending', '',
  ].join('\n'));

  const callsLog = path.join(root, 'factory.calls');
  const factoryBin = path.join(binDir, 'factory');
  const replace = after || corruptAfter ? `rm -f '${runtimeFile}'\ncp '${afterFile}' '${runtimeFile}'\n` : '';

  await writeFile(factoryBin, '#!/usr/bin/env bash\n'
    + `printf 'factory %s\\n' "$*" >> '${callsLog}'\n`
    + `${replace}exec sleep 5\n`, { mode: 0o755 });
  await writeFile(path.join(binDir, 'systemd-run'), '#!/usr/bin/env bash\n'
    + `printf 'systemd-run %s\\n' "$*" >> '${callsLog}'\nexit 0\n`, { mode: 0o755 });
  // Быстрый выход подставного юнита позволяет проверить вызов resume без ожидания identity.
  await writeFile(path.join(binDir, 'systemctl'), '#!/usr/bin/env bash\necho inactive\nexit 3\n', {
    mode: 0o755,
  });

  const oldPath = process.env.PATH;

  process.env.PATH = `${binDir}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const config = {
    rootDir: root,
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
    decisionTimeoutMs: 500,
  };
  const adapter = new FactoryStateAdapter({
    stateDir,
    routesDir,
    profilesDir,
    controlDir,
  });

  adapter.getTaskGraph = async () => ({ keys: { build: 'BUILD' } });

  const warnings = [];
  const app = Fastify({ logger: false });

  app.log.warn = (fields, message) => warnings.push({ fields, message });
  await app.register(factoryModule, {
    factoryState: adapter,
    config,
    prefs: { read: () => ({}) },
    b24: null,
    analyzer: {
      readClarifications: async () => null,
      readOpenQuestions: async () => null,
    },
  });
  await app.ready();
  t.after(() => app.close());

  return {
    app,
    adapter,
    callsLog,
    warnings,
  };
}
