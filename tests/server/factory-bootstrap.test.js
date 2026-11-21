import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import factoryModule from '../../server/src/modules/factory/index.ts';
import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';
import { testFactoryBinary } from '../helpers/factoryBinary.mjs';
import { publishCommandRoute } from './helpers/factoryGoRuntime.mts';

const exec = promisify(execFile);
const root = path.resolve(new URL('../..', import.meta.url).pathname);
const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');

/**
 * Fixture использует настоящие bundle, dispatcher, stage-result и append-only журнал.
 * Только модель заменена функцией; живой сервер, systemd и профиль проекта не вызываются.
 */
async function fixture(t, outcome = 'failed') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-bootstrap-'));

  t.after(async () => rm(directory, { recursive: true, force: true }));

  const stateDir = path.join(directory, 'state');
  const controlDir = path.join(directory, 'control');
  const routesDir = path.join(directory, 'routes');
  const profilesDir = path.join(directory, 'profiles');
  const workspace = path.join(directory, 'workspace');
  const source = path.join(directory, 'repository');

  await Promise.all([stateDir, controlDir, routesDir, workspace, source,
    path.join(profilesDir, 'demo-profile')].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })));

  for (const checkout of [source, workspace]) {
    await exec('git', ['init', '-qb', 'fixture', checkout], {
      env: { HOME: directory, PATH: '/usr/bin:/bin' },
    });
  }

  await writeFile(path.join(workspace, 'source.txt'), 'baseline\n');
  await publishCommandRoute(routesDir, false, false, 0, 'required');

  const profile = path.join(profilesDir, 'demo-profile');
  const codex = path.join(directory, 'codex');
  const ticket = path.join(directory, 'ticket.json');
  const factoryBin = testFactoryBinary();
  const factoryHome = path.join(root, 'engine');

  await writeFile(path.join(profile, 'profile.sh'), String.raw`
PROFILE_NAME=demo-profile
PROFILE_SERVICE_HOST=127.0.0.1
profile_workspace_mode() { printf 'isolated\n'; }
profile_repositories() { printf 'fixture\t%s\t%s\n' "${source}" "${workspace}"; }
profile_source_branch() { printf 'fixture\n'; }
profile_container() { printf 'bootstrap-fixture\n'; }
profile_stand_alive() { return 0; }
profile_service_ports() { printf '8830\t8830\n'; }
profile_exclusive_resources() { printf 'workspace:%s\n' "${workspace}"; }
profile_project_context() { printf '%s\n' '{"stack":["fixture"],"guardrails":[]}'; }
profile_route_command() {
  printf '%s\n' '{"schema":1,"outcome":"done","comment":"fixture","failureOwner":null,"findings":[]}'
}
`);
  await writeFile(path.join(profile, 'up.sh'), String.raw`#!/bin/bash
cat >"$STATE_DIR/t$1.env" <<EOF
TASK=$1
WORKSPACE_MODE=isolated
STAND_OWNERSHIP=task
SB_K=0
API_PORT=8830
FE_PORT=8830
SOURCE_BRANCH=fixture
REPO_COUNT=1
REPO_0_NAME=fixture
REPO_0_SOURCE=${source}
REPO_0_WT=${workspace}
REPO_0_BRANCH=fixture
EOF
`);
  await writeFile(path.join(profile, 'graph.json'), '{"capabilities":["route-v2"]}');
  await writeFile(path.join(profile, 'runners.env'), [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'RUNNERS_COVERAGE=required',
    'PROJECT_RUNNER_PRIMARY=codex', 'PROJECT_RUNNER_FAILOVER=', '',
  ].join('\n'));
  await writeFile(codex, String.raw`#!/bin/bash
set -eu
if [[ "$1" == --version ]]; then
  echo 'codex-cli 0.106.0'
  exit 0
fi
cat >/dev/null
[[ "$FACTORY_RUN_STAGE" == SCOUT ]]
args=()
case "${outcome}" in
  failed) args=(--failure-owner human --finding 'owner-choice=Какой вариант выбрать?');;
  done) args=(--finding-deferred 'external-check=Внешняя проверка');;
esac
"$FACTORY_STATUS_BIN" stage-result --task "$FACTORY_RUN_TASK" --stage SCOUT \
  --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" "${'$'}{args[@]}" \
  "${outcome}" 'Нужен выбор владельца'
`, { mode: 0o700 });
  await writeFile(ticket, JSON.stringify({
    schema: 1,
    taskId: '7',
    title: 'Fixture',
    description: 'Разведка',
    acceptanceCriteria: ['Сохранён точный вопрос'],
    sourceUrl: 'https://example.test/7',
  }));

  /**
   * Запускает Go с изолированным профилем и локальной подменой Codex.
   * Сетевые ключи и окружение пользователя дочерний процесс не получает.
   */
  function factory(operation, ...options) {
    return exec(factoryBin, ['7', operation, '--profile', 'demo-profile',
      '--state-dir', stateDir, '--control-dir', controlDir, '--routes-dir', routesDir, ...options], {
      env: {
        HOME: directory,
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        NODE_BIN: process.execPath,
        FACTORY_HOME: factoryHome,
        FACTORY_PROFILES_DIR: profilesDir,
        GRIGDESK_CODEX_BIN: codex,
      },
      timeout: 15000,
    });
  }

  await factory('start', '--route', 'command', '--ticket-json', ticket);

  const attempts = path.join(controlDir, 'protocol-v2/tasks/t7');
  const { attemptId: attempt } = JSON.parse(await readFile(path.join(attempts, 'active-attempt.json')));
  const attemptDir = path.join(attempts, 'attempts', attempt);

  const config = {
    rootDir: root,
    factoryHome,
    factoryBin,
    factoryConfigRoot: path.join(directory, 'config'),
    factoryControlDir: controlDir,
    routesDir,
    stateDir,
    profilesDir,
    factoryProfile: 'demo-profile',
    ticketsDir: path.join(directory, 'tickets'),
  };
  const adapter = new FactoryStateAdapter({
    stateDir,
    controlDir,
    routesDir,
    profilesDir,
  });
  const app = Fastify({ logger: false });

  await app.register(factoryModule, {
    factoryState: adapter,
    config,
    prefs: { read: () => ({}) },
    tracker: null,
    analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null },
  });
  await app.ready();
  t.after(async () => app.close());

  return {
    config,
    directory,
    app,
    adapter,
    attempt,
    attemptDir,
    factory,
    result: (await adapter.readTrustedAttempt(7)).bootstrapStop,
  };
}

test('bootstrap human виден в summary и graph до cursor, не предлагается арбитру', async (t) => {
  const fx = await fixture(t);
  const summary = await fx.adapter.getTaskSummary(7);
  const graph = await fx.adapter.getTaskGraph(7);

  assert.equal(summary.readOnly, false);
  assert.equal(summary.stall.phase, 'bootstrap');
  assert.equal(summary.stall.bootstrap.recordHash, fx.result.recordHash);
  assert.equal(summary.stall.arbitrable, false);
  assert.equal(graph.stall.phase, 'bootstrap');
  assert.equal(graph.stall.bootstrap.visitId, fx.result.visitId);
  assert.equal(graph.nodeMeta.scout.verdict.phase, 'bootstrap');
  assert.equal(graph.nodeMeta.scout.verdict.sequence, null);
  assert.equal(graph.statuses.scout, 'stall');
  assert.equal((await fx.adapter.readTrustedAttempt(7)).cursor, null);

  const held = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/7/resume',
    payload: {},
  });

  assert.equal(held.statusCode, 409);
  assert.equal(held.json().error, 'bootstrap_answer_required');
});

test('API exact visit сохраняет решение, повтор идемпотентен, конфликт отклонён', async (t) => {
  const fx = await fixture(t);
  const body = {
    profile: 'demo-profile',
    attempt: fx.attempt,
    phase: 'bootstrap',
    node: 'scout',
    visitId: fx.result.visitId,
    stopHash: fx.result.recordHash,
    answer: ` Выбери первый вариант.\nОтвет целиком.\t${'🚀'.repeat(19000)} `,
  };
  const request = (payload) => fx.app.inject({
    method: 'POST',
    url: '/api/tasks/7/bootstrap-answer',
    payload,
  });
  const stale = await request({ ...body, stopHash: 'a'.repeat(64) });

  assert.equal(stale.statusCode, 409);
  assert.equal((await request({ ...body, answer: ' ' })).statusCode, 400);
  assert.equal((await request({ ...body, answer: '🚀'.repeat(20001) })).statusCode, 400);
  assert.equal((await request({ ...body, answer: 'Ответ\u0000' })).statusCode, 400);

  const first = await request(body);

  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().decision.answer, body.answer);

  const repeat = await request(body);

  assert.equal(repeat.statusCode, 200, repeat.body);
  assert.equal(repeat.json().decision.recordHash, first.json().decision.recordHash);
  assert.equal((await request({ ...body, answer: 'Второй вариант' })).statusCode, 409);
  assert.equal((await fx.adapter.readTrustedAttempt(7)).bootstrapStop.state, 'answered');
  assert.equal((await fx.adapter.readTrustedAttempt(7)).cursor, null);
});

test('findings API читает checkpoint через настоящий короткий CLI и отклоняет чужую attempt', async (t) => {
  const fx = await fixture(t, 'done');
  const good = await fx.app.inject(`/api/tasks/7/findings?profile=demo-profile&attempt=${fx.attempt}`);

  assert.equal(good.statusCode, 200, good.body);
  assert.equal(good.json().findings.deferred[0].id, 'external-check');
  assert.equal(good.json().findings.deferred[0].source.phase, 'bootstrap');
  assert.equal(good.json().findings.deferred[0].openedSequence, null);

  const stale = await fx.app.inject('/api/tasks/7/findings?profile=demo-profile&attempt=a_wrong');

  assert.equal(stale.statusCode, 409);

  const checkpoint = path.join(fx.attemptDir, 'artifacts/bootstrap.json');
  const journalDir = path.join(fx.attemptDir, 'bootstrap-results');
  const completed = (await readdir(journalDir)).find(
    (name) => name.startsWith('event.00000000000000000002.'),
  );

  await rm(path.join(journalDir, completed));
  assert.equal((await fx.adapter.readTrustedAttempt(7)).bootstrapStop, null);

  await chmod(checkpoint, 0o600);
  await writeFile(checkpoint, '{broken');
  await chmod(checkpoint, 0o400);

  const corrupted = await fx.app.inject(`/api/tasks/7/findings?profile=demo-profile&attempt=${fx.attempt}`);

  assert.equal(corrupted.statusCode, 409);
});

test('повреждённый hash-chain закрывает actionable bootstrap stop', async (t) => {
  const fx = await fixture(t);
  const directory = path.join(fx.attemptDir, 'bootstrap-results');
  const stopFile = path.join(directory, `event.00000000000000000002.${fx.result.recordHash}.json`);
  const original = await readFile(stopFile, 'utf8');

  await chmod(stopFile, 0o600);
  await writeFile(stopFile, original.replace('Нужен выбор владельца', 'Подменённый вопрос'));
  await chmod(stopFile, 0o400);

  await assert.rejects(fx.adapter.readTrustedAttempt(7), /digest/);

  const response = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/7/bootstrap-answer',
    payload: {
      profile: 'demo-profile',
      attempt: fx.attempt,
      phase: 'bootstrap',
      node: 'scout',
      visitId: fx.result.visitId,
      stopHash: fx.result.recordHash,
      answer: 'Выбор',
    },
  });

  assert.equal(response.statusCode, 409);

  await rm(stopFile);

  // Правильный digest не заменяет семантическую проверку типов записи.
  // Повторяем негативные случаи с заново вычисленным hash и целой цепочкой визита.
  for (const kind of ['runId', 'severity']) {
    const event = JSON.parse(original);

    if (kind === 'runId') {
      event.runs[0].runId = 7;
    } else {
      const finding = event.verdict.findings[0];

      event.verdict.findings[0] = {
        id: finding.id,
        severity: ['deferred'],
        summary: finding.summary,
      };
    }

    const bytes = `${JSON.stringify(event, null, 2)}\n`;
    const digest = createHash('sha256').update(bytes).digest('hex');
    const filename = path.join(directory, `event.00000000000000000002.${digest}.json`);

    await writeFile(filename, bytes, { mode: 0o400 });
    await assert.rejects(fx.adapter.readTrustedAttempt(7), /неверн/);
    await rm(filename);
  }
});

test('PIPE-PRELUDE: ответ bootstrap, чтение identity и отдельный resume одной attempt', async (t) => {
    const { pipelineFixture } = await import('../tracker/helpers/pipelineFixture.mts');
    const fx = await fixture(t);
    const cli = await pipelineFixture(t, async (seen, response) => {
        const result = await fx.app.inject({
            method: seen.method,
            url: seen.url,
            headers: seen.headers,
            payload: seen.body.length ? seen.body : undefined,
        });

        response.statusCode = result.statusCode;
        response.setHeader('Content-Type', 'application/json');
        response.end(result.rawPayload);
    });
    const before = await cli.run(['state', '7']);

    assert.equal(before.code, 0);
    assert.equal(JSON.parse(before.stdout).identity, null);

    const answer = ' Выбор\nС TAB\t' + '🚀'.repeat(19000);
    const saved = await cli.run(['bootstrap-answer', '7'], {
        profile: 'demo-profile',
        attempt: fx.attempt,
        phase: 'bootstrap',
        node: 'scout',
        visitId: fx.result.visitId,
        stopHash: fx.result.recordHash,
        answer,
    });

    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(JSON.parse(saved.stdout).decision.answer, answer);
    assert.equal((await fx.adapter.readTrustedAttempt('7')).cursor, null);

    const read = await cli.run(['prelude-state', '7']);

    assert.equal(read.code, 0, read.stderr);

    const expectedPrelude = JSON.parse(read.stdout).identity;

    assert.equal(expectedPrelude.attempt, fx.attempt);
    assert.equal(expectedPrelude.bootstrap.state, 'answered');
    assert.equal(expectedPrelude.bootstrap.decisionHash, JSON.parse(saved.stdout).decision.recordHash);

    const stop = await cli.run(['stop', '7'], { expectedPrelude });

    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).outcome, 'not_running');

    // Admission проверяется на реальном immutable bootstrap, запуск модели не нужен.
    // Живость заменяет только внешний process-port, сохраняя guard и HTTP целиком.
    const wasAlive = fx.adapter.isDaemonAlive;

    fx.adapter.isDaemonAlive = () => true;

    try {
        const resumed = await cli.run(['resume', '7'], { expectedPrelude });

        assert.equal(resumed.code, 0, resumed.stderr);
        assert.equal(JSON.parse(resumed.stdout).outcome, 'already_running');
    } finally {
        fx.adapter.isDaemonAlive = wasAlive;
    }

    for (const stale of [
        { ...expectedPrelude, attempt: 'a_' + 'f'.repeat(32) },
        { ...expectedPrelude, bootstrap: { ...expectedPrelude.bootstrap, visitId: 'b_' + 'e'.repeat(32) } },
        { ...expectedPrelude, bootstrap: { ...expectedPrelude.bootstrap, decisionHash: 'd'.repeat(64) } },
    ]) {
        const rejected = await cli.run(['resume', '7'], { expectedPrelude: stale });

        assert.equal(rejected.code, 22);
        assert.match(rejected.stderr, /изменил|состояни/i);
    }

    assert.equal((await fx.adapter.readTrustedAttempt('7')).attempt, fx.attempt);
});

test('PIPE-PRELUDE-TERMINAL-LEDGER: abandon до cursor наблюдается как terminal', async (t) => {
    const { pipelineFixture } = await import('../tracker/helpers/pipelineFixture.mts');
    const fx = await fixture(t);
    const cli = await pipelineFixture(t, async (seen, response) => {
        const result = await fx.app.inject({
            method: seen.method,
            url: seen.url,
            headers: seen.headers,
            payload: seen.body.length ? seen.body : undefined,
        });

        response.statusCode = result.statusCode;
        response.setHeader('Content-Type', 'application/json');
        response.end(result.rawPayload);
    });
    const old = await cli.run(['prelude-state', '7']);

    assert.equal(old.code, 0, old.stderr);

    const expectedPrelude = JSON.parse(old.stdout).identity;

    await fx.factory('abandon', '--attempt', fx.attempt, '--reason', 'Fixture terminal');

    const trusted = await fx.adapter.readTrustedAttempt('7');

    assert.equal(trusted.cursor, null);
    assert.equal(trusted.terminal, 'abandoned');

    const read = await cli.run(['prelude-state', '7']);

    assert.equal(read.code, 0, read.stderr);
    assert.equal(JSON.parse(read.stdout).identity, null);
    assert.equal(JSON.parse(read.stdout).terminal, 'abandoned');
    assert.equal(JSON.parse(read.stdout).attempt, fx.attempt);

    const waited = await cli.run(['wait', '7', fx.attempt], undefined, {
        sleep: async () => assert.fail('terminal ledger уже подтверждён'),
        armDeadline: () => ({ signal: new AbortController().signal, dispose: () => undefined }),
    });

    assert.equal(waited.code, 0, waited.stderr);
    assert.equal(JSON.parse(waited.stdout).terminal, 'abandoned');
    assert.equal(JSON.parse(waited.stdout).attempt, fx.attempt);

    const staleAction = await cli.run(['resume', '7'], { expectedPrelude });

    assert.equal(staleAction.code, 22, 'terminal не получает actionable identity');
});
