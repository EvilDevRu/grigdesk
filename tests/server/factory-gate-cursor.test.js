// Ворота и курсор журнала: проекция не рисует ложное «ждёт тебя»,
// а /gate отказывает решению для ворот, на которых маршрут не стоит.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access, chmod, mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { computeNodeStatuses } from '../../server/src/lib/factoryGraph.ts';
import { readFactoryAttemptLedger } from '../../server/src/lib/factoryAttemptLedger.ts';
import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';
import factoryModule from '../../server/src/modules/factory/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';
const ROUTE_HASH = 'a'.repeat(64);
const CATALOG_HASH = 'b'.repeat(64);
const HEAD_HASH = 'c'.repeat(64);

// Каноническая форма digest_value движка (engine/lib/attempt-stage-state.sh):
// json.dumps(sort_keys, separators=(",",":"), ensure_ascii=False) + "\n".
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function stageRuntime({
  node = 'gate_accept', state = 'paused', sequence = 8,
  stop = state === 'stopped' ? 'done' : null,
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
      lastCommit: { node: 'lint', outcome: 'done', sequence: sequence - 1 },
      pauseReason: state === 'paused' ? 'human-gate' : null,
      state,
      stop,
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

// Полный trusted ledger попытки; runtime.json пишется, только если cursor задан.
async function fixture(t, { cursor = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-gate-cursor-'));
  const stateDir = path.join(root, 'state');
  const controlDir = path.join(root, 'control');
  const routesDir = path.join(root, 'routes');
  const profilesDir = path.join(root, 'profiles');
  const binDir = path.join(root, 'bin');
  const worktree = path.join(root, 'worktree');
  await Promise.all([
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
    protocolVersion: 2, schema: 1,
  }), { mode: 0o400 });
  await writeCheckedJson(attemptDir, 'attempt', {
    schema: 1, protocolVersion: 2, attemptId: ATTEMPT, taskId: '7', profile: 'demo',
    createdAt: '2026-08-02T12:00:00Z', routesDir, catalogHash: CATALOG_HASH,
    origin: 'fresh', previousAttemptId: null, recoveryReason: null,
  });
  await writeCheckedJson(attemptDir, 'pins', {
    schema: 1, protocolVersion: 2, attemptId: ATTEMPT, taskId: '7', profile: 'demo',
    catalogHash: CATALOG_HASH, bootstrap: { id: 'scout', catalogHash: CATALOG_HASH },
  });
  await writeContentAddressedJson(attemptDir, 'route-pin', {
    schema: 1, protocolVersion: 2, attemptId: ATTEMPT, taskId: '7', profile: 'demo',
    catalogHash: CATALOG_HASH, routeId: 'feature', routeHash: ROUTE_HASH,
    selectedAt: '2026-08-02T12:01:00Z',
  });
  await writeFile(path.join(attemptDir, 'artifacts', 'profile-contract.tsv'), [
    'schema\t1', 'repos-mode\tgeneric', 'workspace-mode\tisolated', 'stand-ownership\ttask',
    'source-branch\tfactory/t7', 'container\tdemo', 'service-host\t127.0.0.1',
    `repo\tdemo\t${worktree}\t${worktree}\tfactory/t7`, '',
  ].join('\n'), { mode: 0o400 });
  await writeFile(path.join(taskRoot, 'active-attempt.json'), jsonBytes({
    schema: 1, protocolVersion: 2, taskId: '7', attemptId: ATTEMPT,
  }), { mode: 0o400 });

  if (cursor) {
    const stageDir = path.join(attemptDir, 'stage-results');
    await mkdir(stageDir, { mode: 0o700 });
    await writeFile(
      path.join(stageDir, 'runtime.json'),
      typeof cursor === 'string' ? cursor : runtimeEnvelope(stageRuntime(cursor)),
      { mode: 0o400 },
    );
  }

  await writeFile(path.join(stateDir, 't7.pipeline'), [
    'PROFILE=demo', 'ROUTE=feature', 'RUN_PROTOCOL=2', 'CATALOG_PROTOCOL=route-v2',
    `ATTEMPT_ID=${ATTEMPT}`, `ROUTE_HASH=${ROUTE_HASH}`, 'DELIVERY_MODE=disabled',
    'WF_STATUS=running', 'STALLED_HUMAN=1', 'BUILD=done', 'LINT=done',
    'GATE_ACCEPT=waiting', 'SHIP=pending', '',
  ].join('\n'));

  const callsLog = path.join(root, 'factory.calls');
  const factoryBin = path.join(binDir, 'factory');
  await writeFile(factoryBin, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${callsLog}"\n`, { mode: 0o755 });
  await writeFile(path.join(binDir, 'systemd-run'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(binDir, 'systemctl'), '#!/usr/bin/env bash\necho active\nexit 0\n', { mode: 0o755 });
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
    root, stateDir, controlDir, routesDir, config, adapter, callsLog,
  };
}

async function server(t, fx) {
  const app = Fastify({ logger: false });
  await app.register(factoryModule, {
    factoryState: fx.adapter,
    config: fx.config,
    prefs: { read: () => ({}) },
    b24: null,
    analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null },
  });
  await app.ready();
  t.after(async () => app.close());
  return app;
}

const POS = { build: [0, 0], lint: [1, 0], gate_accept: [2, 0], ship: [3, 0] };

test('v2-реестр не дорисовывает ворота без явной записи waiting', () => {
  // LINT=done записан узлом, коммит в журнал не лёг — ворота не достигнуты.
  const stalled = computeNodeStatuses({
    pf: {
      CATALOG_PROTOCOL: 'route-v2', BUILD: 'done', LINT: 'done', GATE_ACCEPT: 'pending', SHIP: 'pending',
    },
    pos: POS, keys: {}, optional: [], mtimeMs: null,
  });
  assert.equal(stalled.gate_accept, 'pending');

  const paused = computeNodeStatuses({
    pf: {
      CATALOG_PROTOCOL: 'route-v2', BUILD: 'done', LINT: 'done', GATE_ACCEPT: 'waiting', SHIP: 'pending',
    },
    pos: POS, keys: {}, optional: [], mtimeMs: null,
  });
  assert.equal(paused.gate_accept, 'wait');
});

test('исторический реестр без протокола сохраняет доинференс ворот', () => {
  const legacy = computeNodeStatuses({
    pf: { BUILD: 'done', LINT: 'done', GATE_ACCEPT: 'pending', SHIP: 'pending' },
    pos: POS, keys: {}, optional: [], mtimeMs: null,
  });
  assert.equal(legacy.gate_accept, 'wait');
});

test('каноническая форма конверта совпадает с digest_value движка', async (t) => {
  // Контрольная сумма посчитана python3 (json.dumps sort_keys, separators=(",",":")).
  const fx = await fixture(t, { cursor: {} });
  const runtime = stageRuntime({});
  const expected = 'afe4018854d10383ab652970bdb5126ab12bcf288544feae8443abc462fddad4';
  const envelope = `${JSON.stringify({ checksum: expected, runtime }, null, 2)}\n`;
  const file = path.join(fx.controlDir, 'protocol-v2', 'tasks', 't7', 'attempts', ATTEMPT, 'stage-results', 'runtime.json');
  await chmod(file, 0o600);
  await writeFile(file, envelope, { mode: 0o400 });
  const trusted = await fx.adapter.readTrustedAttempt('7');
  assert.deepEqual(trusted.cursor, {
    node: 'gate_accept', state: 'paused', stop: null, pauseReason: 'human-gate',
  });
});

test('runtime.json без конверта — молодая попытка, курсор null', async (t) => {
  const fx = await fixture(t);
  const trusted = await fx.adapter.readTrustedAttempt('7');
  assert.equal(trusted.cursor, null);
});

test('завершённый курсор stopped сохраняет попытку управляемой', async (t) => {
  const fx = await fixture(t, { cursor: { state: 'stopped', stop: 'done' } });
  const trusted = await fx.adapter.readTrustedAttempt('7');
  assert.deepEqual(trusted.cursor, {
    node: null, state: 'stopped', stop: 'done', pauseReason: null,
  });
  const summary = await fx.adapter.getTaskSummary('7');
  assert.equal(summary.readOnly, false);
});

test('подменённый runtime.json ломает trusted ledger fail-closed', async (t) => {
  const fx = await fixture(t, { cursor: { node: 'lint', state: 'ready' } });
  const file = path.join(fx.controlDir, 'protocol-v2', 'tasks', 't7', 'attempts', ATTEMPT, 'stage-results', 'runtime.json');
  const tampered = `${JSON.stringify({ checksum: 'd'.repeat(64), runtime: stageRuntime({ node: 'lint', state: 'ready' }) }, null, 2)}\n`;
  await chmod(file, 0o600);
  await writeFile(file, tampered, { mode: 0o400 });
  await assert.rejects(fx.adapter.readTrustedAttempt('7'), /checksum mismatch/);
});

test('/gate отказывает решению для ворот, на которых курсор не стоит', async (t) => {
  const fx = await fixture(t, { cursor: { node: 'lint', state: 'ready' } });
  const app = await server(t, fx);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/reject',
    payload: { comment: 'нет потоковой передачи' },
  });
  assert.equal(response.statusCode, 409, response.body);
  const body = response.json();
  assert.equal(body.error, 'gate_not_current');
  assert.match(body.message, /lint/);
  await assert.rejects(access(fx.callsLog), 'движок не вызван: отказ дан до команды');
});

test('/gate без инициализированного курсора отказывает без вызова движка', async (t) => {
  const fx = await fixture(t);
  const app = await server(t, fx);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/approve',
    payload: {},
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'gate_not_current');
  await assert.rejects(access(fx.callsLog), 'движок не вызван: курсора ещё нет');
});

test('/gate на припаркованных воротах передаёт решение движку', async (t) => {
  const fx = await fixture(t, { cursor: { node: 'gate_accept', state: 'paused' } });
  const app = await server(t, fx);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/reject',
    payload: { comment: 'вернуть на доработку' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true);
  const calls = await readFile(fx.callsLog, 'utf8');
  assert.match(calls, /7 gate --profile demo/);
  assert.match(calls, /--node gate_accept --decision rejected --commit-only/);
  assert.match(calls, /--comment вернуть на доработку/);
});

// Замечание человека — текст задания следующему агенту, а не подпись к клику. Пока
// ручка резала его до 500 символов одной строкой, разбор на несколько абзацев доезжал
// обрубком, причём молча: человек видел «отправлено», агент получал первый абзац.
test('/gate доносит многострочное замечание до движка без обрезки', async (t) => {
  const fx = await fixture(t, { cursor: { node: 'gate_accept', state: 'paused' } });
  const app = await server(t, fx);
  const comment = ['Первый абзац замечания.', '', '- пункт один', '- пункт два'].join('\n');
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/reject',
    payload: { comment: `${comment}\r\n` },
  });
  assert.equal(response.statusCode, 200, response.body);
  const calls = await readFile(fx.callsLog, 'utf8');
  assert.ok(calls.includes(comment), 'перевод строки и разметка сохранены целиком');
  assert.ok(!calls.includes('\r'), 'CRLF браузерной textarea нормализован');
});

test('/gate отказывает замечанию свыше потолка и не зовёт движок', async (t) => {
  const fx = await fixture(t, { cursor: { node: 'gate_accept', state: 'paused' } });
  const app = await server(t, fx);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/reject',
    payload: { comment: 'щ'.repeat(20001) },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'comment_too_long');
  await assert.rejects(access(fx.callsLog), 'движок не вызван: отказ дан до команды');
});

// Реестр и журнал ровно в той точке, где `gate --commit-only` уже вышел, а resume ещё не
// взял ORCH_PID: флаг остановки снят, демона нет, последняя строка — зафиксированные ворота.
async function writeHandoffWindow(fx) {
  await writeFile(path.join(fx.stateDir, 't7.pipeline'), [
    'PROFILE=demo', 'ROUTE=feature', 'RUN_PROTOCOL=2', 'CATALOG_PROTOCOL=route-v2',
    `ATTEMPT_ID=${ATTEMPT}`, `ROUTE_HASH=${ROUTE_HASH}`, 'DELIVERY_MODE=disabled',
    'WF_STATUS=running', 'STALLED_HUMAN=0', 'ORCH_PID=', 'BUILD=done', 'LINT=done',
    'GATE_ACCEPT=approved', 'SHIP=pending', '',
  ].join('\n'));
  await writeFile(path.join(fx.stateDir, 'logs', 't7.stages.log'), [
    '2026-10-07 16:05:31 [t7] route: узел lint: подготовка к исполнению',
    '2026-10-07 16:36:11 [t7] route: пауза на human gate gate_accept',
    '2026-10-08 14:59:32 [t7] route: gate gate_accept=approved зафиксирован',
    '',
  ].join('\n'));
}

// Живой случай 08.10.2026: человек нажал «Принять», а через секунду получил «Конвейер
// оборвался — демона нет, а конвейер не закрыт». Публикация при этом шла и дошла до конца.
test('передача хода после ворот не читается как обрыв прогона', async (t) => {
  const fx = await fixture(t, { cursor: { node: 'ship', state: 'ready' } });

  await writeHandoffWindow(fx);

  const unmarked = await fx.adapter.getTaskSummary('7');

  assert.equal(unmarked.stall?.kind, 'crashed', 'без отметки окно передачи неотличимо от обрыва');

  const done = fx.adapter.beginHandoff('7');
  const handing = await fx.adapter.getTaskSummary('7');

  assert.equal(handing.stall, null);
  assert.equal(handing.daemonAlive, true, 'продолжение поднимается — прогон идёт');
  assert.equal(fx.adapter.isDaemonAlive('', '7'), false, 'подтверждение подъёма видит только демона');

  done();
  done();

  const released = await fx.adapter.getTaskSummary('7');

  assert.equal(released.stall?.kind, 'crashed', 'не поднявшееся продолжение снова видно как обрыв');
});

test('/gate держит передачу хода от записи решения до попытки продолжения', async (t) => {
  const fx = await fixture(t, { cursor: { node: 'gate_accept', state: 'paused' } });
  const binDir = path.join(fx.root, 'bin');

  // Юнит «вышел сразу»: подтверждение подъёма отвечает за 250 мс, а не за 26 секунд.
  await writeFile(
    path.join(binDir, 'systemd-run'),
    `#!/usr/bin/env bash\nprintf 'systemd-run %s\\n' "$*" >> "${fx.callsLog}"\nexit 0\n`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(binDir, 'systemctl'),
    '#!/usr/bin/env bash\necho inactive\nexit 3\n',
    { mode: 0o755 },
  );

  const marks = [];
  const begin = fx.adapter.beginHandoff.bind(fx.adapter);
  // Синхронно: снимок обязан отражать журнал вызовов ровно в момент отметки.
  const callsNow = () => (existsSync(fx.callsLog) ? readFileSync(fx.callsLog, 'utf8') : '');

  fx.adapter.beginHandoff = (task) => {
    const done = begin(task);

    marks.push({ at: 'begin', calls: callsNow() });

    return () => {
      marks.push({ at: 'done', calls: callsNow() });
      done();
    };
  };

  const app = await server(t, fx);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/approve',
    payload: {},
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().resumed, false);
  assert.deepEqual(marks.map((mark) => mark.at), ['begin', 'done']);
  assert.equal(marks[0].calls, '', 'отметка поставлена до записи решения');
  assert.match(marks[1].calls, /--decision approved --commit-only/);
  assert.match(marks[1].calls, /systemd-run .* resume /, 'отметка снята только после попытки продолжения');
  assert.equal(fx.adapter.isRunLive('', '7'), false, 'после ответа отметки не остаётся');
});
