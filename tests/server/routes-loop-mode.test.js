import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeAgentNode, makeDraft } from '../fixtures/routes-editor.mjs';
import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';
import factoryModule from '../../server/src/modules/factory/index.ts';
import routesModule from '../../server/src/modules/routes/index.ts';
import { validateRoute } from '../../server/src/modules/routes/schema.ts';
import { detectStall } from '../../server/src/lib/stall.ts';
import { archiveTaskFiles } from '../../server/src/lib/taskArtifacts.ts';
import { buildRouteDef } from '../../server/src/lib/routeGraph.ts';
import { readLoopProgress } from '../../server/src/lib/factoryLoopProgress.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import {
  arbitrationGate,
  readArbitrationContext,
  stallIsArbitrable,
} from '../../server/src/lib/factoryArbiter.ts';

// Режим «цикл»: ведущий ставит задание и проверяет, исполнитель делает. Сервер держит
// тот же контракт пары, что движок, читает остановку по потолку кругов и не пускает
// арбитра вторым управляющим поверх ведущего.

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const stop = (target = 'human') => ({ stop: target });
const next = (target) => ({ next: target });
const transfer = { rewind: 'build', reset: ['build', 'review'] };
const owners = (value) => ({
  build: value, tests: value, plan: value, human: value, environment: stop(),
});

function agent(id, filesystem, on, onFailure) {
  return {
    id,
    executor: 'agent',
    phase: 'main',
    runKey: id.toUpperCase(),
    emits: [],
    prompt: { blocks: [{ file: `prompts/${id}.base.md` }], requiredContext: ['task'] },
    policy: { filesystem, timeoutClass: 'browser', budgetClass: 'large' },
    fanout: { mode: 'single', maxExecutors: 1, degrade: 'forbid' },
    retry: { noResult: 1, productFailure: 0, providerFailure: { attempts: 0, strategy: 'none' } },
    on,
    onFailure,
  };
}

function loopRoute() {
  return {
    schema: 2,
    kind: 'route',
    profile: 'sample',
    id: 'loop',
    bootstrap: 'skip',
    loop: { lead: 'review', worker: 'build' },
    entry: 'review',
    sequence: { main: ['build', 'review', 'gate_accept'], tail: [] },
    nodes: [
      agent('build', 'workspace-write',
        { done: next('review'), skipped: next('review'), failed: next('review'), exhausted: stop() },
        owners(next('review'))),
      agent('review', 'state-only',
        { done: next('gate_accept'), skipped: stop(), failed: transfer, exhausted: stop() },
        { build: transfer, tests: transfer, plan: stop(), human: stop(), environment: stop() }),
      {
        id: 'gate_accept',
        executor: 'gate',
        phase: 'main',
        runKey: 'GATE_ACCEPT',
        emits: [],
        on: { approved: stop('done'), rejected: { rewind: 'review', reset: ['review', 'gate_accept'] } },
      },
    ],
    escalation: [],
  };
}

const promptFiles = ['prompts/build.base.md', 'prompts/review.base.md'];
const check = (route) => validateRoute(route, { profile: 'sample', routeId: 'loop', promptFiles });

test('корректная пара цикла публикуется', () => {
  assert.doesNotThrow(() => check(loopRoute()));
});

test('граф сохраняет пару режима петли, обычный rewind её не включает', () => {
  const route = loopRoute();

  assert.deepEqual(buildRouteDef(route, 'loop').loop, { lead: 'review', worker: 'build' });

  delete route.loop;

  assert.equal(buildRouteDef(route, 'loop').loop, null);
});

test('граф задачи передаёт пару из бандла и счётчики из текущей проекции', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-loop-graph-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const routesDir = path.join(root, 'routes');
  const store = new RoutesStore({ baseDir: routesDir });
  const { routeHash } = await store.publishRoute('sample', 'loop', {
    route: loopRoute(),
    prompts: Object.fromEntries(promptFiles.map((file) => [file, 'Задание узлу.'])),
  });

  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 't9.pipeline'), [
    'PROFILE=sample',
    'ROUTE=loop',
    'CATALOG_PROTOCOL=route-v2',
    `ATTEMPT_ID=a_${'1'.repeat(32)}`,
    `ROUTE_HASH=${routeHash}`,
    'BUILD=running',
    'REVIEW=pending',
    'LOOP_MODE=1',
    'LOOP_ROUND=4',
    'LOOP_STAGE=2',
    'LOOP_MAX_ROUNDS=20',
    '',
  ].join('\n'));

  const adapter = new FactoryStateAdapter({
    stateDir,
    routesDir,
    profilesDir: path.join(root, 'profiles'),
  });
  const graph = await adapter.getTaskGraph('9');

  assert.deepEqual(graph.loop, { lead: 'review', worker: 'build' });
  assert.deepEqual(graph.loopProgress, {
    round: 4,
    stage: 2,
    maxRounds: 20,
  });
  assert.equal(graph.daemonAlive, false);
});

test('отсутствующие счётчики петли неизвестны, снятый режим не показывает старые значения', () => {
  const registry = {
    LOOP_MODE: '1',
    LOOP_ROUND: '0',
    LOOP_STAGE: '1',
    LOOP_MAX_ROUNDS: '20',
  };
  const unknown = {
    round: null,
    stage: null,
    maxRounds: null,
  };

  assert.deepEqual(readLoopProgress(registry), {
    round: 0,
    stage: 1,
    maxRounds: 20,
  });
  assert.equal(readLoopProgress({ ...registry, LOOP_MODE: '' }), null);
  assert.deepEqual(readLoopProgress({ LOOP_MODE: '1' }), unknown);
  assert.deepEqual(readLoopProgress({
    LOOP_MODE: '1',
    LOOP_ROUND: '-1',
    LOOP_STAGE: '0',
    LOOP_MAX_ROUNDS: '20x',
  }), unknown);
});

const violations = [
  ['повтор продукта у исполнителя', (route) => { route.nodes[0].retry.productFailure = 1; }],
  ['вход не в ведущего', (route) => { route.entry = 'build'; }],
  ['исполнитель в обход ведущего', (route) => { route.nodes[0].on.done = next('gate_accept'); }],
  ['tests ведущего не возвращает работу', (route) => { route.nodes[1].onFailure.tests = stop(); }],
  ['одна роль у двух', (route) => { route.loop.worker = 'review'; }],
  ['лишний ключ пары', (route) => { route.loop.extra = 'x'; }],
  // Продуктовый отказ исполнителя уходит только ведущему: ни человеку, ни на приёмку.
  ['отказ исполнителя build — человеку', (route) => { route.nodes[0].onFailure.build = stop(); }],
  ['отказ исполнителя build — на приёмку', (route) => {
    route.nodes[0].onFailure.build = next('gate_accept');
  }],
  ['отказ исполнителя plan — человеку', (route) => { route.nodes[0].onFailure.plan = stop(); }],
  ['обычный отказ исполнителя — человеку', (route) => { route.nodes[0].on.failed = stop(); }],
  ['пропуск исполнителя — на приёмку', (route) => {
    route.nodes[0].on.skipped = next('gate_accept');
  }],
  ['без onFailure отказ через on.failed — человеку', (route) => {
    delete route.nodes[0].onFailure;
    route.nodes[0].on.failed = stop();
  }],
];
for (const [name, mutate] of violations) {
  test(`нарушение пары цикла отвергается: ${name}`, () => {
    const route = loopRoute();
    mutate(route);
    assert.throws(() => check(route), /machine\.loop|loop/);
  });
}

test('отказ исполнителя по окружению маршрут ведёт по своему решению', () => {
  const environment = loopRoute();
  environment.nodes[0].onFailure.environment = next('review');
  assert.doesNotThrow(() => check(environment));

  const fallback = loopRoute();
  delete fallback.nodes[0].onFailure;
  assert.doesNotThrow(() => check(fallback), 'без onFailure действует on.failed — ведущему');
});

test('остановка по потолку кругов разбирается своим правилом', () => {
  const logText = [
    '2026-09-26 10:00:00 [t9] route: узел review: подготовка к исполнению',
    '2026-09-26 10:30:00 [t9] route: REVIEW: маршрут остановлен: loop-ceiling — '
      + 'потолок кругов цикла исчерпан: 20 из 20 — подними PROFILE_LOOP_MAX_ROUNDS в профиле '
      + 'и продолжи задачу',
  ].join('\n');
  const stall = detectStall({ registry: { STALLED_HUMAN: '1' }, logText, daemonAlive: false });

  assert.equal(stall.stop, 'loop-ceiling');
  assert.equal(stall.stage, 'REVIEW');
  assert.ok(stall.title.includes('20 из 20'));
  assert.ok(stall.hint.includes('PROFILE_LOOP_MAX_ROUNDS'));
});

test('остановка цикла не предлагается арбитру ни кнопкой, ни вотчером', () => {
  const verdict = { owner: 'human' };

  assert.equal(stallIsArbitrable('no-progress', verdict), true);
  assert.equal(stallIsArbitrable('no-progress', verdict, { loop: true }), false);
  assert.equal(stallIsArbitrable('loop-ceiling', verdict), false);
});

test('журнал с событиями цикла закрывает попытку для арбитра', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'loop-arbiter-'));
  const dir = path.join(root, 'protocol-v2', 'tasks', 't9', 'attempts', 'a_1', 'stage-results');
  await mkdir(dir, { recursive: true });
  const hash = 'a'.repeat(64);
  const event = {
    kind: 'no-progress',
    node: 'review',
    reason: 'повторяется тот же набор',
    action: transfer,
    verdict: { owner: 'build', findings: [{ id: 'x', summary: 'не закрыт' }] },
    loop: { policy: 1, maxRounds: 20, roundsBefore: 1, roundsAfter: 1, stage: 1, stageAccepted: false },
  };
  await writeFile(path.join(dir, `event.${'1'.padStart(20, '0')}.${hash}.json`), JSON.stringify(event));
  const context = await readArbitrationContext({ controlDir: root, task: 9, attempt: 'a_1' });

  assert.equal(context.ok, true);
  assert.equal(context.loop, true);
  const gate = arbitrationGate(context, { state: 'stopped', stop: 'no-progress' });
  assert.equal(gate.ok, false);
  assert.ok(gate.message.includes('цикл'));
});

test('реестровый признак цикла закрывает гейт и без событий цикла в журнале', () => {
  const context = {
    ok: true, stop: 'human', node: 'review', target: 'review', reason: null,
    series: [{ node: 'review', owner: 'human', findings: [], reviewed: [] }],
    arbitrations: 0, loop: false,
  };
  const cursor = { state: 'stopped', stop: 'human' };

  assert.equal(arbitrationGate(context, cursor).ok, true);
  assert.equal(arbitrationGate(context, cursor, { loop: true }).ok, false);
});

// Resume без подъёма потолка штатно отказывает и дописывает подсказку в журнал. Реестр
// при этом обязан по-прежнему ждать человека: с STALLED_HUMAN=0 мёртвый демон читался бы
// как падение, а не как остановка по потолку.
test('отказ продолжать без подъёма потолка остаётся ожиданием человека', () => {
  const logText = [
    '2026-09-27 10:30:00 [t9] route: REVIEW: маршрут остановлен: loop-ceiling — '
      + 'потолок кругов цикла исчерпан: 2 из 2 — подними PROFILE_LOOP_MAX_ROUNDS в профиле '
      + 'и продолжи задачу',
    '2026-09-27 10:40:00 [t9] route: REVIEW: потолок кругов цикла не поднят '
      + '(PROFILE_LOOP_MAX_ROUNDS=2) — задача остаётся на остановке',
  ].join('\n');
  const waiting = detectStall({
    registry: { STALLED_HUMAN: '1', RESULT: 'stopped-loop-ceiling' }, logText, daemonAlive: false,
  });

  assert.equal(waiting.kind, 'human');
  assert.equal(waiting.stop, 'loop-ceiling');

  const lost = detectStall({
    registry: { STALLED_HUMAN: '0', RESULT: 'stopped-loop-ceiling' }, logText, daemonAlive: false,
  });

  assert.equal(lost.kind, 'crashed', 'снятый признак превращает ожидание в падение');
});

// Обычный маршрут: признак цикла движок снимает пустым значением (recover из цикла) или не
// пишет вовсе. В обоих случаях арбитр остаётся доступен; только `1` закрывает его.
test('снятый признак цикла в реестре оставляет обычному маршруту арбитра', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-loop-plain-arbiter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attempt = 'a_11111111111111111111111111111111';
  const results = path.join(root, 'control', 'protocol-v2', 'tasks', 't9', 'attempts', attempt,
    'stage-results');
  await mkdir(results, { recursive: true });
  await writeFile(path.join(results, `event.${'0'.repeat(19)}1.${'d'.repeat(64)}.json`),
    JSON.stringify({
      kind: 'no-progress',
      node: 'review',
      outcome: 'failed',
      action: transfer,
      sequence: 1,
      reason: 'повторяется тот же набор',
      verdict: { owner: 'build', reviewed: [], findings: [{ id: 'x', summary: 'не закрыт' }] },
    }));
  const adapter = new FactoryStateAdapter({
    stateDir: path.join(root, 'state'),
    profilesDir: path.join(root, 'profiles'),
    controlDir: path.join(root, 'control'),
  });
  const summary = (registry) => adapter.summaryStall({
    registry: { STALLED_HUMAN: '1', ...registry },
    timeline: [{ ts: '2026-09-27 10:00:00', event: 'route: REVIEW: маршрут остановлен: no-progress' }],
    daemonAlive: false,
    trusted: { attempt, cursor: { state: 'stopped', stop: 'no-progress' } },
    task: '9',
  });

  assert.equal((await summary({})).arbitrable, true, 'признака нет — обычный маршрут');
  assert.equal((await summary({ LOOP_MODE: '' })).arbitrable, true, 'снятый признак — обычный');
  assert.equal((await summary({ LOOP_MODE: '1' })).arbitrable, false, 'цикл арбитру не отдаётся');
});

// Ворота приёмки читают отчёт исполнителя через /doc/report. В цикле это отчёт последнего
// сданного визита из реестра; общий report.md — чужой, его показывать нельзя.
test('документ report в цикле — последний сданный отчёт визита', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-loop-report-doc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  await app.register(factoryModule, {
    config: {
      stateDir: root,
      factoryHome: path.resolve('engine'),
      factoryBin: path.resolve('engine/bin/factory'),
      factoryConfigRoot: path.join(root, 'config'),
      profilesDir: path.join(root, 'profiles'),
      routesDir: path.join(root, 'routes'),
      factoryControlDir: path.join(root, 'control'),
    },
    factoryState: { taskStateDir: async () => root },
    prefs: { read: () => ({}) },
  });
  await app.ready();
  t.after(() => app.close());
  const read = async () => (await app.inject({ method: 'GET', url: '/api/tasks/77/doc/report' })).json();
  const registry = (text) => writeFile(path.join(root, 't77.pipeline'), text);

  await writeFile(path.join(root, 't77.report.md'), 'Старый общий отчёт');
  await writeFile(path.join(root, 't77.report.r3.md'), 'Отчёт первого визита третьего круга');
  await writeFile(path.join(root, 't77.report.r3.v2.md'), 'Отчёт повторного визита');
  await writeFile(path.join(root, 't78.report.r1.md'), 'Отчёт чужой задачи');

  await registry('PROFILE=sample\n');
  assert.equal((await read()).text, 'Старый общий отчёт', 'обычный маршрут — прежний файл');
  await registry('LOOP_MODE=\nLOOP_REPORT=\n');
  assert.equal((await read()).text, 'Старый общий отчёт', 'снятый признак цикла — прежний файл');
  await registry('LOOP_MODE=1\nLOOP_ROUND=3\nLOOP_REPORT=t77.report.r3.v2.md\n');
  assert.equal((await read()).text, 'Отчёт повторного визита');
  await registry('LOOP_MODE=1\nLOOP_ROUND=3\nLOOP_REPORT=\n');
  assert.equal((await read()).text, '', 'сданного отчёта нет — старый общий не подставляется');
  await registry('LOOP_MODE=1\nLOOP_ROUND=4\nLOOP_REPORT=t77.report.r4.md\n');
  assert.equal((await read()).text, '', 'файла сданного отчёта нет — пусто, а не старый отчёт');
  await registry('LOOP_MODE=1\nLOOP_ROUND=3\n');
  assert.equal((await read()).text, 'Отчёт первого визита третьего круга',
    'реестр движка до пофайловых визитов — отчёт круга');
  for (const foreign of ['t78.report.r1.md', '../t77.report.r3.md', 't77.report.md']) {
    await registry(`LOOP_MODE=1\nLOOP_REPORT=${foreign}\n`);
    assert.equal((await read()).text, '', `чужое имя в реестре не читается: ${foreign}`);
  }
});

test('архив задачи уносит отчёты визитов цикла и исходный замер', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-loop-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = [
    't77.pipeline', 't77.report.md', 't77.report.r1.md', 't77.report.r1.v2.md',
    't77.report.r12.md', 't77.baseline.md', 't77.deferred.md', 't770.report.r1.md',
    't78.report.r1.md',
  ];
  for (const name of names) await writeFile(path.join(root, name), name, { mode: 0o444 });

  const moved = await archiveTaskFiles('77', root);

  assert.deepEqual(moved, [
    'pipeline', 'report.md', 'baseline.md', 'report.r1.md', 'report.r1.v2.md', 'report.r12.md',
  ]);
  assert.deepEqual((await readdir(root)).sort(),
    ['archive', 't77.deferred.md', 't770.report.r1.md', 't78.report.r1.md']);
  await access(path.join(root, 'archive', 't77.report.r1.v2.md'));
});

// Пробный сценарий редактора: потолок кругов живёт в профиле, поэтому сценарий цикла
// передаёт его через публичный API, а предел шагов цикла вмещает потолок 300.
function loopDraft() {
  const draft = makeDraft();
  const quick = draft.routes.quick;
  const build = makeAgentNode({ id: 'build', on: {
    done: next('review'), skipped: next('review'), failed: next('review'), exhausted: stop(),
  } });
  const review = makeAgentNode({ id: 'review', on: {
    done: next('gate_accept'), skipped: stop(), failed: transfer, exhausted: stop(),
  } });
  const gate = quick.route.nodes.find((node) => node.id === 'gate_accept');
  gate.on = { approved: stop('done'), rejected: { rewind: 'review', reset: ['review', 'gate_accept'] } };
  quick.route = {
    ...quick.route,
    entry: 'review',
    loop: { lead: 'review', worker: 'build' },
    sequence: { main: ['build', 'review', 'gate_accept'], tail: [] },
    nodes: [build, review, gate],
  };
  quick.prompts = { 'prompts/build.base.md': 'Исполни.', 'prompts/review.base.md': 'Проверь.' };
  return draft;
}

test('пробный шаг цикла принимает потолок кругов через HTTP', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-loop-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  await app.register(routesModule, {
    config: {
      routesDir: path.join(root, 'routes'),
      routesAuthoringDir: path.join(root, 'authoring'),
      profilesDir: path.join(root, 'profiles'),
    },
    prefs: {
      read: () => ({ projects: { sample: {} } }),
      write: () => { throw new Error('симуляция не меняет prefs'); },
    },
  });
  await app.ready();
  t.after(() => app.close());
  const draft = loopDraft();
  const created = await app.inject({
    method: 'POST', url: '/api/routes/sample/drafts',
    payload: {
      kind: 'document', title: draft.title, baseCatalogHash: null, baseSourceRevision: 0,
      document: {
        routes: draft.routes, bootstrap: draft.bootstrap, bootstrapPrompts: draft.bootstrapPrompts,
        presentation: draft.presentation, provenance: draft.provenance,
      },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const url = `/api/routes/sample/drafts/${created.json().id}/simulate/step`;
  const stepAt = (rounds, extra) => app.inject({ method: 'POST', url, payload: {
    expectedRevision: 1,
    cursor: { scope: 'route', routeId: 'quick', nodeId: 'review', terminal: false },
    counters: { noResult: {}, productFailure: {}, rewinds: { 'target:quick/build': rounds } },
    outcome: 'failed', failureOwner: 'build', selectedRouteId: null,
    pinned: false, humanApproved: false, stepIndex: 5, ...extra,
  } });

  const ceiling = await stepAt(2, { loopMaxRounds: 2 });
  assert.equal(ceiling.statusCode, 200, ceiling.body);
  assert.equal(ceiling.json().stop, 'loop-ceiling', 'выбранный потолок 2 соблюдается');
  const byDefault = await stepAt(2, {});
  assert.equal(byDefault.statusCode, 200, byDefault.body);
  assert.equal(byDefault.json().stop, null, 'без поля действует потолок по умолчанию 20');
  const highest = await stepAt(300, { loopMaxRounds: 300, stepIndex: 601 });
  assert.equal(highest.statusCode, 200, highest.body);
  assert.equal(highest.json().stop, 'loop-ceiling', 'потолок 300 достижим на 601-м шаге');
  for (const bad of [0, 301, 2.5, '2']) {
    const rejected = await stepAt(2, { loopMaxRounds: bad });
    assert.equal(rejected.statusCode, 400, `потолок ${bad} отвергается`);
  }
  assert.equal((await stepAt(2, { stepIndex: 201 })).statusCode, 400,
    'без потолка цикла предел шагов прежний — 200');
  assert.equal((await stepAt(2, { loopMaxRounds: 300, stepIndex: 1201 })).statusCode, 400,
    'у цикла предел шагов тоже есть — 1200');
});
