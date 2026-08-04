// Ветка закреплена НА РЕПОЗИТОРИЙ. У проекта из нескольких репозиториев каноничные
// ветки не обязаны совпадать (parser живёт на main, ag — на master), и кокпит обязан
// сверять env прогона с веткой КАЖДОГО репозитория, а не с одной общей. Манифесты,
// записанные до этой правки, короче на одно поле — журнал читается и по ним.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readFactoryAttemptLedger,
  verifyFactoryAttemptEnvironment,
} from '../../server/src/lib/factory-attempt-ledger.js';

const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';
const ROUTE_HASH = 'a'.repeat(64);
const CATALOG_HASH = 'b'.repeat(64);
const TASK = 4242;

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

/** Минимальный доверенный журнал попытки с произвольными строками repo в манифесте. */
async function trustedLedger({ workspaceMode = 'shared', sourceBranch, repoLines }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-branch-pin-'));
  const controlDir = path.join(root, 'control');
  const stateDir = path.join(root, 'state');
  const taskRoot = path.join(controlDir, 'protocol-v2', 'tasks', `t${TASK}`);
  const attemptDir = path.join(taskRoot, 'attempts', ATTEMPT);
  await mkdir(path.join(attemptDir, 'artifacts'), { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(taskRoot, 'protocol.json'), jsonBytes({
    protocolVersion: 2, schema: 1,
  }), { mode: 0o400 });
  await writeCheckedJson(attemptDir, 'attempt', {
    schema: 1,
    protocolVersion: 2,
    attemptId: ATTEMPT,
    taskId: String(TASK),
    profile: 'demo',
    createdAt: '2026-08-02T12:00:00Z',
    routesDir: path.join(root, 'routes'),
    catalogHash: CATALOG_HASH,
    origin: 'fresh',
    previousAttemptId: null,
    recoveryReason: null,
  });
  await writeCheckedJson(attemptDir, 'pins', {
    schema: 1,
    protocolVersion: 2,
    attemptId: ATTEMPT,
    taskId: String(TASK),
    profile: 'demo',
    catalogHash: CATALOG_HASH,
    bootstrap: { id: 'scout', catalogHash: CATALOG_HASH },
  });
  await writeContentAddressedJson(attemptDir, 'route-pin', {
    schema: 1,
    protocolVersion: 2,
    attemptId: ATTEMPT,
    taskId: String(TASK),
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
    ...repoLines,
    '',
  ].join('\n'), { mode: 0o400 });
  await writeFile(path.join(taskRoot, 'active-attempt.json'), jsonBytes({
    schema: 1, protocolVersion: 2, taskId: String(TASK), attemptId: ATTEMPT,
  }), { mode: 0o400 });
  return { controlDir, stateDir };
}

const REGISTRY = {
  PROFILE: 'demo',
  ROUTE: 'feature',
  ATTEMPT_ID: ATTEMPT,
  ROUTE_HASH,
  CATALOG_PROTOCOL: 'route-v2',
  WORKSPACE_MODE: 'shared',
  STAND_OWNERSHIP: 'external',
};

function read({ controlDir, stateDir }, registry = REGISTRY) {
  return readFactoryAttemptLedger({
    controlDir, stateDir, task: String(TASK), registry,
  });
}

function sharedEnv(overrides = {}) {
  return {
    WORKSPACE_MODE: 'shared',
    STAND_OWNERSHIP: 'external',
    SOURCE_BRANCH: 'main',
    FE_PORT: '8830',
    API_PORT: '8830',
    REPO_COUNT: '2',
    REPO_0_NAME: 'parser',
    REPO_0_SOURCE: '/srv/parser',
    REPO_0_WT: '/srv/parser',
    REPO_0_BRANCH: 'main',
    REPO_1_NAME: 'ag',
    REPO_1_SOURCE: '/srv/ag',
    REPO_1_WT: '/srv/ag',
    REPO_1_BRANCH: 'master',
    ...overrides,
  };
}

const TWO_REPOS = [
  'repo\tparser\t/srv/parser\t/srv/parser\tmain',
  'repo\tag\t/srv/ag\t/srv/ag\tmaster',
];

test('shared-манифест несёт свою ветку у каждого репозитория', async () => {
  const dirs = await trustedLedger({ sourceBranch: 'main', repoLines: TWO_REPOS });
  const trusted = await read(dirs);
  assert.equal(trusted.sourceBranch, 'main');
  assert.deepEqual(
    trusted.repositories.map((repo) => [repo.name, repo.branch]),
    [['parser', 'main'], ['ag', 'master']],
  );
  assert.equal(verifyFactoryAttemptEnvironment(trusted, sharedEnv()), true);
});

test('env с чужой веткой репозитория отвергается', async () => {
  const dirs = await trustedLedger({ sourceBranch: 'main', repoLines: TWO_REPOS });
  const trusted = await read(dirs);
  // Ровно та подмена, которую раньше нечем было поймать: сверка шла с общей веткой,
  // поэтому «main» у второго репозитория выглядела законной.
  assert.throws(
    () => verifyFactoryAttemptEnvironment(trusted, sharedEnv({ REPO_1_BRANCH: 'main' })),
    /repository topology/,
  );
});

test('манифест старой формы читается: ветка берётся из source-branch', async () => {
  const dirs = await trustedLedger({
    sourceBranch: 'main',
    repoLines: ['repo\tparser\t/srv/parser\t/srv/parser'],
  });
  const trusted = await read(dirs);
  assert.deepEqual(
    trusted.repositories.map((repo) => [repo.name, repo.branch]),
    [['parser', 'main']],
  );
  const env = sharedEnv({ REPO_COUNT: '1' });
  for (const key of ['REPO_1_NAME', 'REPO_1_SOURCE', 'REPO_1_WT', 'REPO_1_BRANCH']) {
    delete env[key];
  }
  assert.equal(verifyFactoryAttemptEnvironment(trusted, env), true);
});

test('в isolated расхождение веток недопустимо', async () => {
  const dirs = await trustedLedger({
    workspaceMode: 'isolated',
    sourceBranch: 'route-task-4242',
    repoLines: [
      'repo\tbackend\t/srv/be\t/srv/be-wt\troute-task-4242',
      'repo\tfrontend\t/srv/fe\t/srv/fe-wt\trelease',
    ],
  });
  await assert.rejects(
    read(dirs, { ...REGISTRY, WORKSPACE_MODE: 'isolated', STAND_OWNERSHIP: 'task' }),
    /more than one branch/,
  );
});
