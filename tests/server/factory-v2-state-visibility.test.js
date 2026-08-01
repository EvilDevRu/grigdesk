// Видимость прогонов route v2 в кокпите: адаптер читает ОБА дерева состояния
// (legacy state и state-v2), задачи v2 попадают в список/граф с меткой поколения,
// а мутации v1-CLI по ним отклоняются до какого-либо исполнения.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { FactoryStateAdapter } from '../../server/src/adapters/factory-state.js';
import factoryModule from '../../server/src/modules/factory/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-v2-visibility-'));
  const stateDir = path.join(root, 'state');
  const stateV2Dir = path.join(root, 'state-v2');
  const profilesDir = path.join(root, 'profiles');
  await mkdir(path.join(stateDir, 'logs'), { recursive: true });
  await mkdir(path.join(stateV2Dir, 'logs'), { recursive: true });
  await mkdir(path.join(profilesDir, 'demo'), { recursive: true });
  await writeFile(path.join(profilesDir, 'demo', 'graph.json'), JSON.stringify({
    default_route: 'feature',
    routes: {
      feature: {
        pos: { scout: [0, 0], build: [100, 0], ship: [200, 0] },
        edges: [['scout', 'build', '', 'plain', 'h'], ['build', 'ship', '', 'plain', 'h']],
      },
    },
  }));

  // Legacy-задача в обычном состоянии.
  await writeFile(path.join(stateDir, 't7.pipeline'), [
    'PROFILE=demo',
    'ROUTE=feature',
    'WF_STATUS=running',
    'SCOUT=done',
    'BUILD=running',
    '',
  ].join('\n'));

  // Задача v2 — в отдельном дереве, с маркерами протокола route-v2.
  await writeFile(path.join(stateV2Dir, 't8165.pipeline'), [
    'PROFILE=demo',
    'ROUTE=feature',
    'RUN_PROTOCOL=2',
    'CATALOG_PROTOCOL=route-v2',
    'ATTEMPT_ID=a_0123456789abcdef0123456789abcdef',
    'SANDBOX_GENERATION=v2',
    'WF_STATUS=running',
    'STALLED_HUMAN=0',
    'SCOUT=done',
    'BUILD=running',
    '',
  ].join('\n'));
  await writeFile(path.join(stateV2Dir, 't8165.env'), [
    'FE_PORT=8461',
    'API_PORT=8462',
    'BE_WT=/tmp/nowhere-be',
    '',
  ].join('\n'));
  await writeFile(path.join(stateV2Dir, 'logs', 't8165.stages.log'), [
    '2026-07-31 12:00:00 [t8165] v2: attempt начат',
    '',
  ].join('\n'));

  // Стаб factory-v2 для моста ворот: пишет аргументы вызова и выходит успехом.
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await writeFile(
    path.join(root, 'bin', 'factory-v2'),
    '#!/usr/bin/env bash\nprintf \'%s \' "$@" >> "$(dirname "$0")/calls.log"\nprintf \'\\n\' >> "$(dirname "$0")/calls.log"\n',
    { mode: 0o755 },
  );

  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, stateDir, stateV2Dir, profilesDir };
}

test('VIS-01: список задач сливает оба поколения состояния', async (t) => {
  const { stateDir, stateV2Dir, profilesDir } = await fixture(t);
  const adapter = new FactoryStateAdapter({ stateDir, stateV2Dir, profilesDir });
  assert.deepEqual(await adapter.listTaskIds(), ['7', '8165']);
});

test('VIS-02: сводка и граф v2-задачи читаются из state-v2 с меткой поколения', async (t) => {
  const { stateDir, stateV2Dir, profilesDir } = await fixture(t);
  const adapter = new FactoryStateAdapter({ stateDir, stateV2Dir, profilesDir });

  const summary = await adapter.getTaskSummary('8165');
  assert.equal(summary.generation, 'v2');
  assert.equal(summary.profile, 'demo');
  assert.equal(summary.stageMap.BUILD.status, 'running');

  const graph = await adapter.getTaskGraph('8165');
  assert.equal(graph.generation, 'v2');
  assert.equal(graph.statuses.build, 'run');
  assert.equal(graph.fePort, '8461');

  const v1 = await adapter.getTaskSummary('7');
  assert.equal(v1.generation, 'v1');
});

test('VIS-03: без stateV2Dir адаптер ведёт себя как раньше', async (t) => {
  const { stateDir, profilesDir } = await fixture(t);
  const adapter = new FactoryStateAdapter({ stateDir, profilesDir });
  assert.deepEqual(await adapter.listTaskIds(), ['7']);
  assert.equal((await adapter.getTaskSummary('7')).generation, 'v1');
});

test('VIS-04: мутации v1-CLI по v2-задаче отклоняются с 409 до исполнения', async (t) => {
  const { root, stateDir, stateV2Dir, profilesDir } = await fixture(t);
  const adapter = new FactoryStateAdapter({ stateDir, stateV2Dir, profilesDir });
  const app = Fastify({ logger: false });
  app.register(factoryModule, {
    factoryState: adapter,
    config: {
      factoryHome: root,
      factoryBin: path.join(root, 'nonexistent-factory'),
      factoryV2Bin: path.join(root, 'bin', 'factory-v2'),
      factoryConfigRoot: path.join(root, 'config'),
      stateDir,
      stateV2Dir,
      profilesDir,
    },
    prefs: { read: () => ({}) },
    b24: null,
    analyzer: null,
  });
  await app.ready();
  t.after(async () => { await app.close(); });

  const list = await app.inject({ method: 'GET', url: '/api/tasks' });
  assert.equal(list.statusCode, 200);
  const tasks = list.json().tasks.map((x) => [x.task, x.generation]);
  assert.deepEqual(tasks, [['7', 'v1'], ['8165', 'v2']]);

  // Ворота v2 — НЕ отказ, а мост в factory-v2 (см. VIS-05 ниже).
  const cases = [
    ['POST', '/api/tasks/8165/stage/BUILD/done'],
    ['POST', '/api/tasks/8165/stage/BUILD/skipped'],
    ['POST', '/api/tasks/8165/sandbox/down'],
    ['POST', '/api/tasks/8165/sandbox/retry'],
    ['POST', '/api/tasks/8165/launch'],
    ['POST', '/api/tasks/8165/instruction', { text: 'нельзя' }],
  ];
  for (const [method, url, body] of cases) {
    const res = await app.inject({ method, url, ...(body ? { payload: body } : {}) });
    assert.equal(res.statusCode, 409, `${url} обязан отклоняться для v2-задачи`);
    assert.equal(res.json().error, 'v2_task_engine_owned', url);
  }

  // Документы этапа читаются из дерева v2 (доки гейтов человеку нужны и там).
  await writeFile(path.join(stateV2Dir, 't8165.plan.md'), 'план из v2');
  const doc = await app.inject({ method: 'GET', url: '/api/tasks/8165/doc/plan' });
  assert.equal(doc.json().text, 'план из v2');

  // VIS-05: ворота v2 применяются мостом через factory-v2 с pin-ом попытки.
  const gate = await app.inject({
    method: 'POST',
    url: '/api/tasks/8165/gate/GATE_ACCEPT/approve',
    payload: { comment: 'ок' },
  });
  assert.equal(gate.statusCode, 200, 'v2 gate проходит мостом, а не 409');
  assert.equal(gate.json().generation, 'v2');
  const calls = await readFile(path.join(root, 'bin', 'calls.log'), 'utf8');
  assert.match(calls, /8165 gate --profile demo --attempt a_0123456789abcdef0123456789abcdef --node gate_accept --decision approved --commit-only --comment ок/,
    'мост передаёт pin попытки, узел и решение');
  // Без --commit-only gate сам ведёт маршрут дальше и живёт столько, сколько
  // работает следующий этап: http-таймаут кокпита убивал оркестратор посреди
  // прогона, раннер оставался сиротой, а решение уже было записано (t8165).
  assert.ok(calls.split('\n').filter((line) => / gate /.test(line))
    .every((line) => line.includes('--commit-only')),
  'синхронный вызов ворот не имеет права тянуть за собой прогон маршрута');
});
