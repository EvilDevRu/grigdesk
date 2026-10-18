// Ветка закреплена НА РЕПОЗИТОРИЙ. У проекта из нескольких репозиториев каноничные
// ветки не обязаны совпадать (service-a живёт на main, service-b — на master), и GrigDesk обязан
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
} from '../../server/src/lib/factoryAttemptLedger.ts';

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
async function trustedLedger({
  workspaceMode = 'shared', sourceBranch, repoLines,
  attemptSchema = 1, queueDispatchId = null, runnerPrimaryOverride = '',
  terminalState = null, terminalReason = null,
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-branch-pin-'));
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
    schema: attemptSchema,
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
    ...(attemptSchema === 2 ? { queueDispatchId, runnerPrimaryOverride } : {}),
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
  if (terminalState !== null) {
    await writeContentAddressedJson(attemptDir, 'terminal', {
      schema: 1,
      protocolVersion: 2,
      attemptId: ATTEMPT,
      taskId: String(TASK),
      state: terminalState,
      closedAt: '2026-08-02T12:02:00Z',
      reason: terminalState === 'finished'
        ? null
        : (terminalReason ?? 'operator closed attempt'),
    });
  }
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
  if (terminalState === null) {
    await writeFile(path.join(taskRoot, 'active-attempt.json'), jsonBytes({
      schema: 1, protocolVersion: 2, taskId: String(TASK), attemptId: ATTEMPT,
    }), { mode: 0o400 });
  }
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
    REPO_0_NAME: 'service-a',
    REPO_0_SOURCE: '/srv/service-a',
    REPO_0_WT: '/srv/service-a',
    REPO_0_BRANCH: 'main',
    REPO_1_NAME: 'service-b',
    REPO_1_SOURCE: '/srv/service-b',
    REPO_1_WT: '/srv/service-b',
    REPO_1_BRANCH: 'master',
    ...overrides,
  };
}

const TWO_REPOS = [
  'repo\tservice-a\t/srv/service-a\t/srv/service-a\tmain',
  'repo\tservice-b\t/srv/service-b\t/srv/service-b\tmaster',
];

test('shared-манифест несёт свою ветку у каждого репозитория', async () => {
  const dirs = await trustedLedger({ sourceBranch: 'main', repoLines: TWO_REPOS });
  const trusted = await read(dirs);
  assert.equal(trusted.sourceBranch, 'main');
  assert.deepEqual(
    trusted.repositories.map((repo) => [repo.name, repo.branch]),
    [['service-a', 'main'], ['service-b', 'master']],
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
    repoLines: ['repo\tservice-a\t/srv/service-a\t/srv/service-a'],
  });
  const trusted = await read(dirs);
  assert.deepEqual(
    trusted.repositories.map((repo) => [repo.name, repo.branch]),
    [['service-a', 'main']],
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

test('EC-05: attempt schema 2 round-trip проверяет queue provenance и exact runner override', async () => {
  const queueDispatchId = '00000000-0000-4000-8000-000000000001';
  const dirs = await trustedLedger({
    sourceBranch: 'main',
    repoLines: TWO_REPOS,
    attemptSchema: 2,
    queueDispatchId,
    runnerPrimaryOverride: 'codex',
  });
  const registry = {
    ...REGISTRY,
    CATALOG_HASH,
    QUEUE_DISPATCH_ID: queueDispatchId,
    RUNNER_OVERRIDE_PRIMARY: 'codex',
  };
  const trusted = await read(dirs, registry);
  assert.equal(trusted.queueDispatchId, queueDispatchId);
  assert.equal(trusted.runnerPrimaryOverride, 'codex');
  await assert.rejects(
    read(dirs, { ...registry, QUEUE_DISPATCH_ID: '' }),
    /launch provenance/,
  );
  await assert.rejects(
    read(dirs, { ...registry, RUNNER_OVERRIDE_PRIMARY: 'claude' }),
    /launch provenance/,
  );
  await assert.rejects(
    read(dirs, { ...registry, CATALOG_HASH: 'c'.repeat(64) }),
    /launch provenance/,
  );
});

test('EC-05: attempt schema 1 остаётся читаемым и честно не знает runner provenance', async () => {
  const dirs = await trustedLedger({ sourceBranch: 'main', repoLines: TWO_REPOS });
  const trusted = await read(dirs, {
    ...REGISTRY,
    // Историческая вторичная проекция могла содержать override, но schema 1
    // не делает его trusted identity.
    RUNNER_OVERRIDE_PRIMARY: 'claude',
  });
  assert.equal(trusted.queueDispatchId, null);
  assert.equal(trusted.runnerPrimaryOverride, null);
});

test('trusted finished переживает crash до обновления registry RESULT', async () => {
  const dirs = await trustedLedger({
    sourceBranch: 'main', repoLines: TWO_REPOS, terminalState: 'finished',
  });
  const trusted = await read(dirs, { ...REGISTRY, RESULT: 'running' });
  assert.equal(trusted.terminal, 'completed');
  assert.equal(trusted.terminalRecord.state, 'finished');
});

test('trusted abandoned переживает crash до обновления registry RESULT', async () => {
  const dirs = await trustedLedger({
    sourceBranch: 'main', repoLines: TWO_REPOS, terminalState: 'abandoned',
  });
  const trusted = await read(dirs, { ...REGISTRY, RESULT: 'failed' });
  assert.equal(trusted.terminal, 'abandoned');
  assert.equal(trusted.terminalRecord.state, 'abandoned');
});

test('trusted terminal по-прежнему отвергает противоположный terminal RESULT', async (t) => {
  for (const [terminalState, result] of [
    ['finished', 'abandoned'],
    ['abandoned', 'completed'],
  ]) {
    await t.test(`${terminalState} против ${result}`, async () => {
      const dirs = await trustedLedger({
        sourceBranch: 'main', repoLines: TWO_REPOS, terminalState,
      });
      await assert.rejects(
        read(dirs, { ...REGISTRY, RESULT: result }),
        /projection disagrees with trusted attempt ledger/,
      );
    });
  }
});

test('terminal RESULT без trusted terminal по-прежнему отвергается', async () => {
  const dirs = await trustedLedger({ sourceBranch: 'main', repoLines: TWO_REPOS });
  await assert.rejects(
    read(dirs, { ...REGISTRY, RESULT: 'completed' }),
    /projection disagrees with trusted attempt ledger/,
  );
});

// Границы terminal-причины у GrigDesk и движка обязаны совпадать. Живой случай: движку
// ослабили лимит до 20 000 символов с переносами ради многострочных замечаний человека,
// а этот ридер остался на 500 без переносов. `factory abandon` принимал длинную причину
// и отвечал успехом, после чего GrigDesk не мог прочитать СВОЮ ЖЕ закрытую попытку
// (`attempt_integrity_failed`), и карточка не убиралась с экрана ничем. Прежние тесты
// этого не ловили: все они писали короткие однострочные причины.
test('terminal-причина сходится с границами движка', async (t) => {
  const engineLimit = 20000;
  const accept = async (terminalReason) => {
    const dirs = await trustedLedger({
      sourceBranch: 'main', repoLines: TWO_REPOS, terminalState: 'abandoned', terminalReason,
    });
    const trusted = await read(dirs, { ...REGISTRY, RESULT: 'abandoned' });
    assert.equal(trusted.terminal, 'abandoned');
  };
  const reject = async (terminalReason) => {
    const dirs = await trustedLedger({
      sourceBranch: 'main', repoLines: TWO_REPOS, terminalState: 'abandoned', terminalReason,
    });
    await assert.rejects(read(dirs, { ...REGISTRY, RESULT: 'abandoned' }),
      /invalid abandon reason/);
  };

  await t.test('длиннее прежних 500 символов', () => accept('причина '.repeat(120)));
  await t.test('многострочная', () => accept('первая строка\nвторая\n- пункт разбора'));
  await t.test('ровно на границе движка', () => accept('я'.repeat(engineLimit)));
  await t.test('за границей движка', () => reject('я'.repeat(engineLimit + 1)));
  await t.test('пустая', () => reject(''));
  await t.test('возврат каретки', () => reject('первая\rвторая'));
  await t.test('табуляция', () => reject('первая\tвторая'));
  await t.test('NUL', () => reject('первая\u0000вторая'));
});
