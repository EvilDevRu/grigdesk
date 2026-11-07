// Ворота и курсор журнала: проекция не рисует ложное «ждёт тебя»,
// а /gate отказывает решению для ворот, на которых маршрут не стоит.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { computeNodeStatuses } from '../../server/src/lib/factoryGraph.ts';
import { readFactoryAttemptLedger } from '../../server/src/lib/factoryAttemptLedger.ts';
import { prepareFactoryRouteLaunch } from '../../server/src/lib/factoryLaunch.ts';
import {
  factoryRuntimeScope,
  readFactoryRuntimeAttempt,
} from '../../server/src/lib/factoryRuntimePins.ts';
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
    tracker: null,
    analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null },
  });
  await app.ready();
  t.after(async () => app.close());
  return app;
}

const POS = { build: [0, 0], lint: [1, 0], gate_accept: [2, 0], ship: [3, 0] };

// HTTP resume проходит настоящий resolver и unpin. Подменяется только процесс
// движка: юнит публикует причину в stages.log, а «живость» задаёт ответ адаптера.
for (const scenario of [
  {
    first: 'incompatible',
    next: 'ready',
    launches: 2,
    status: 200,
  },
  {
    first: 'incompatible',
    next: 'incompatible',
    launches: 2,
    status: 500,
  },
  {
    first: 'incompatible',
    next: 'unavailable',
    launches: 2,
    status: 500,
  },
  {
    first: 'unavailable',
    next: 'ready',
    launches: 1,
    status: 500,
  },
]) {
  test(`/resume: ${scenario.first} → ${scenario.next}, запусков ${scenario.launches}`, async (t) => {
    const fx = await fixture(t, { cursor: { node: 'ship', state: 'ready' } });
    const args = ['7', 'resume', '--profile', 'demo', '--attempt', ATTEMPT];

    await prepareFactoryRouteLaunch(fx.config, args);

    const roots = {
      controlRoot: fx.controlDir,
      stateRoot: fx.stateDir,
      profileRoot: fx.config.profilesDir,
    };
    const authority = path.join(
      fx.controlDir, 'server-runtimes', factoryRuntimeScope(roots), `${ATTEMPT}.json`,
    );
    const attemptDir = path.join(fx.controlDir, 'protocol-v2/tasks/t7/attempts', ATTEMPT);
    const beforePin = JSON.parse(await readFile(authority, 'utf8'));
    const immutableFiles = [
      'attempt.json', 'attempt.sha256', 'pins.json', 'pins.sha256',
      'artifacts/profile-contract.tsv', 'stage-results/runtime.json',
      '../../active-attempt.json',
      ...(await readdir(attemptDir)).filter((file) => file.startsWith('route-pin.')),
    ];
    const before = await Promise.all(
      immutableFiles.map((file) => readFile(path.join(attemptDir, file), 'utf8')),
    );

    const nextBin = path.join(fx.root, 'bin/factory-current');

    await writeFile(nextBin, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

    fx.config.factoryBin = nextBin;

    await writeFile(path.join(fx.root, 'bin/systemd-run'), `#!/usr/bin/env bash
if [[ "$1" == --version ]]; then echo 'systemd 252 (fixture)'; exit 0; fi
printf '%s\\n' "$*" >> '${fx.callsLog}'
count=$(wc -l < '${fx.callsLog}')
reason='${scenario.first}'
if (( count > 1 )); then reason='${scenario.next}'; fi
if [[ "$reason" != ready ]]; then
  printf 'FACTORY_ERROR=runner_preflight_%s RUNNERS=glm\\n' "$reason" \\
    >> '${path.join(fx.stateDir, 'logs/t7.stages.log')}'
fi
`, { mode: 0o755 });
    await writeFile(path.join(fx.root, 'bin/systemctl'), `#!/usr/bin/env bash
if [[ '${scenario.next}' == ready && -f '${fx.callsLog}' ]] \\
  && (( $(wc -l < '${fx.callsLog}') > 1 )); then
  echo active
  exit 0
fi
echo inactive
exit 3
`, { mode: 0o755 });

    fx.adapter.isDaemonAlive = () => scenario.next === 'ready'
      && existsSync(fx.callsLog) && readFileSync(fx.callsLog, 'utf8').trim().split('\n').length > 1;

    const app = await server(t, fx);
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/7/resume',
      payload: {},
    });

    assert.equal(response.statusCode, scenario.status, response.body);

    const calls = (await readFile(fx.callsLog, 'utf8')).trim().split('\n');
    const afterPin = JSON.parse(await readFile(authority, 'utf8'));

    assert.equal(calls.length, scenario.launches, 'перепривязка ограничена одним повтором');
    assert.ok(calls[0].includes(beforePin.engineBin), 'первый запуск использует прежний pin');
    assert.equal(afterPin.engineBin, scenario.launches === 2 ? nextBin : beforePin.engineBin);
    assert.deepEqual(await Promise.all(
      immutableFiles.map((file) => readFile(path.join(attemptDir, file), 'utf8')),
    ), before, 'попытка, каталог, маршрут, курсор и active pointer сохраняют исходные bytes');

    if (scenario.launches === 2) {
      assert.ok(calls[1].includes(nextBin), 'повтор использует текущую поставку');
    }

    if (scenario.status === 500) {
      const failure = scenario.launches === 2 ? scenario.next : scenario.first;

      assert.equal(response.json().error, `runner_preflight_${failure}`);
    }
  });
}

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

test('/gate закрепляет source runtime legacy-попытки с настоящими trusted файлами', async (t) => {
  const fx = await fixture(t, { cursor: { node: 'gate_accept', state: 'paused' } });
  const roots = {
    controlRoot: fx.controlDir,
    stateRoot: fx.stateDir,
    profileRoot: fx.config.profilesDir,
  };
  const scope = factoryRuntimeScope(roots);
  const authority = path.join(fx.controlDir, 'server-runtimes', scope, `${ATTEMPT}.json`);
  const trusted = await readFactoryRuntimeAttempt(roots, '7', ATTEMPT);

  assert.equal(trusted.profile, 'demo');
  await assert.rejects(access(authority), { code: 'ENOENT' });

  // Подставной движок фиксирует вызовы, но не поднимает оркестратор.
  // Неактивный unit завершает подтверждение resume без ожидания настоящей службы.
  await writeFile(path.join(fx.root, 'bin/systemctl'), '#!/usr/bin/env bash\necho inactive\nexit 3\n');

  const app = await server(t, fx);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/approve',
    payload: {},
  });

  if (response.statusCode !== 200) {
    await prepareFactoryRouteLaunch(fx.config, [
      '7', 'gate', '--profile', 'demo', '--attempt', ATTEMPT,
    ]).catch((error) => t.diagnostic(`Причина отказа выбора runtime: ${error.code}`));
  }

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true);

  const pin = JSON.parse(await readFile(authority, 'utf8'));

  assert.equal(pin.task, '7');
  assert.equal(pin.attempt, ATTEMPT);
  assert.equal(pin.scope, scope);
  assert.equal(pin.protocol, 'route-v2');
  assert.equal(pin.packageId, null);
  assert.equal(pin.reservationToken, null);
  assert.equal(pin.runtimeRoot, fx.root);
  assert.equal(pin.engineHome, fx.root);
  assert.equal(pin.engineBin, fx.config.factoryBin);
  assert.deepEqual(JSON.parse(await readFile(path.join(
    fx.config.dataHome, 'runtimes/server/attempt-pins', scope, `${ATTEMPT}.json`,
  ), 'utf8')), pin);
  assert.match(await readFile(fx.callsLog, 'utf8'), /7 gate --profile demo/);
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

/**
 * Профиль demo со стендом задачи, который «умер» после перезагрузки: проверка живости
 * смотрит файл-флаг, хук подъёма отмечает вызов в общем журнале и ведёт себя по `start`.
 * systemd-run пишет в тот же журнал — по порядку строк видно, что было раньше.
 */
async function deadStandFixture(t, start) {
  const fx = await fixture(t, { cursor: { node: 'gate_accept', state: 'paused' } });
  const binDir = path.join(fx.root, 'bin');
  const flag = path.join(fx.stateDir, 'stand-7.up');

  await writeFile(path.join(fx.config.profilesDir, 'demo', 'profile.sh'), `
profile_stand_alive() { [[ -f "${flag}" ]]; }
profile_stand_start() {
  printf 'stand-start %s\\n' "$1" >> "${fx.callsLog}"
  ${start}
}
`);
  await writeFile(
    path.join(binDir, 'systemd-run'),
    `#!/usr/bin/env bash\nprintf 'systemd-run %s\\n' "$*" >> "${fx.callsLog}"\nexit 0\n`,
    { mode: 0o755 },
  );
  // Юнит «вышел сразу»: подтверждение не ждёт полного окна, а сам запуск уже записан.
  await writeFile(path.join(binDir, 'systemctl'), '#!/usr/bin/env bash\necho inactive\nexit 3\n', {
    mode: 0o755,
  });

  return { fx, flag };
}

test('/gate поднимает мёртвый стенд задачи до запуска движка', async (t) => {
  const { fx, flag } = await deadStandFixture(t, `touch "${path.join('$STATE_DIR', 'stand-7.up')}"`);
  const app = await server(t, fx);

  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/approve',
    payload: {},
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(existsSync(flag), true, 'хук получил STATE_DIR сервера');

  const calls = readFileSync(fx.callsLog, 'utf8');

  assert.match(calls, /^stand-start 7$/m);
  assert.match(calls, /stand-start 7\n[\s\S]*systemd-run .* resume /, 'движок запущен после подъёма');
});

test('/gate не запускает движок, если стенд задачи не поднялся', async (t) => {
  const { fx } = await deadStandFixture(t, 'echo "ОШИБКА: порт 8150 занят" >&2; return 1');
  const app = await server(t, fx);

  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/approve',
    payload: {},
  });

  assert.equal(response.statusCode, 200, response.body);

  const body = response.json();

  assert.equal(body.resumed, false);
  assert.equal(body.resumeFailure?.error, 'stand_unavailable');
  assert.match(body.resumeError, /стенд задачи не поднялся: .*порт 8150 занят/);
  assert.doesNotMatch(readFileSync(fx.callsLog, 'utf8'), /systemd-run .* resume /);
});

test('«Продолжить» с мёртвым стендом, который не поднялся, отвечает причиной', async (t) => {
  const { fx } = await deadStandFixture(t, 'echo "ОШИБКА: реестра песочницы t7 нет" >&2; return 73');
  const app = await server(t, fx);

  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/resume',
    payload: {},
  });

  assert.equal(response.statusCode, 500, response.body);
  assert.equal(response.json().error, 'stand_unavailable');
  assert.match(response.json().message, /реестра песочницы t7 нет/);
  assert.doesNotMatch(readFileSync(fx.callsLog, 'utf8'), /systemd-run .* resume /);
});
