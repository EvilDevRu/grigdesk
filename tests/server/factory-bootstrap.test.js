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

  await Promise.all([stateDir, controlDir, routesDir, workspace,
    path.join(profilesDir, 'demo-profile')].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })));
  await exec('git', ['init', '-q', workspace]);
  await exec('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.invalid']);
  await exec('git', ['-C', workspace, 'config', 'user.name', 'Fixture']);
  await writeFile(path.join(workspace, 'source.txt'), 'baseline\n');
  await exec('git', ['-C', workspace, 'add', 'source.txt']);
  await exec('git', ['-C', workspace, 'commit', '-qm', 'baseline']);

  const { stdout: published } = await exec(process.execPath, [
    path.join(root, 'tests/engine/fixtures/routes-catalog-publish.mjs'), routesDir, 'null',
  ]);
  const catalog = JSON.parse(published);
  const script = path.join(directory, 'prepare.sh');

  await writeFile(script, `#!/usr/bin/env bash
set -uo pipefail
export FACTORY_HOME=$1 STATE_DIR=$2 FACTORY_STATE=$2 FACTORY_ROUTE_STATE_DIR=$2
export FACTORY_CONTROL_ROOT=$3 FACTORY_PROFILES_DIR=$4 FACTORY_TESTING=1 FACTORY_FORBID_LIVE=1
routes=$5 workspace=$6 outcome=$7
source "$FACTORY_HOME/lib/route-runtime.sh"
route_v2_workspace_roots() { printf '%s\\n' "$workspace"; }
v2_log() { :; }
route_v2_context_for_node() {
  cat >"$5" <<JSON
{"task":{"id":"$1"},"attempt":{"id":"$2"},"project":{"profile":"demo-profile"},
"workspace":{"service":{"path":"$workspace"}},"services":{},"artifacts":{"root":"$STATE_DIR"},
"diagnosis":{},"instrumentation":{},"evidence":{},"decisions":{},
"delivery":{"mode":"disabled","actions":[],"targetBranches":{}},
"routeCatalog":{"debug":"fixture"},"stage":{"id":"scout","runKey":"SCOUT"}}
JSON
}
run_agent() {
  MULTI_LAST_RUN_ID=bootstrap-fixture
  MULTI_LAST_RUN_EPOCH=1
  run_state_begin "$1" SCOUT "$MULTI_LAST_RUN_ID" 1 fixture-token
  if [[ "$outcome" == failed ]]; then
    FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh" --task "$1" --stage SCOUT \\
      --run-id "$MULTI_LAST_RUN_ID" --epoch 1 --failure-owner human \\
      --finding 'owner-choice=Какой вариант выбрать?' failed 'Нужен выбор владельца' 7<<<fixture-token
  else
    FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh" --task "$1" --stage SCOUT \\
      --run-id "$MULTI_LAST_RUN_ID" --epoch 1 --finding-deferred 'external-check=Внешняя проверка' \\
      done 'Разведка завершена' 7<<<fixture-token
  fi
}
attempt=$(attempt_state_begin_v2 7 demo-profile "$routes") || exit $?
attempt_state_select_route_v2 7 "$attempt" debug >/dev/null || exit $?
set +e
result=$(route_v2_dispatch_bootstrap 7 "$attempt")
rc=$?
set -e
[[ "$rc" == 0 || "$rc" == 22 ]] || exit "$rc"
printf '%s\\n' "$attempt"
printf '%s\\n' "$result"
`);

  const { stdout } = await exec('bash', [script, path.join(root, 'engine'), stateDir, controlDir,
    profilesDir, routesDir, workspace, outcome]);
  const [attempt, ...resultLines] = stdout.trim().split('\n');
  const result = JSON.parse(resultLines.join('\n'));
  const attemptDir = path.join(controlDir, 'protocol-v2/tasks/t7/attempts', attempt);

  await writeFile(path.join(attemptDir, 'artifacts/profile-contract.tsv'), [
    'schema\t1', 'repos-mode\tgeneric', 'workspace-mode\tisolated', 'stand-ownership\ttask',
    'source-branch\tfixture', 'container\tfixture', 'service-host\t127.0.0.1',
    `repo\tfixture\t${workspace}\t${workspace}\tfixture`, '',
  ].join('\n'), { mode: 0o400 });
  await writeFile(path.join(stateDir, 't7.pipeline'), [
    'PROFILE=demo-profile', 'ROUTE=debug', 'RUN_PROTOCOL=2', 'CATALOG_PROTOCOL=route-v2',
    `ATTEMPT_ID=${attempt}`, `CATALOG_HASH=${catalog.catalogHash}`,
    `ROUTE_HASH=${catalog.routeHashes.debug}`, 'QUEUE_DISPATCH_ID=', 'RUNNER_OVERRIDE_PRIMARY=',
    'WF_STATUS=running', 'STALLED_HUMAN=0', 'SCOUT=failed', '',
  ].join('\n'));

  const config = {
    rootDir: root,
    factoryHome: path.join(root, 'engine'),
    factoryBin: path.join(root, 'engine/bin/factory'),
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
    b24: null,
    analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null },
  });
  await app.ready();
  t.after(async () => app.close());

  return {
    app,
    adapter,
    attempt,
    attemptDir,
    result,
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
