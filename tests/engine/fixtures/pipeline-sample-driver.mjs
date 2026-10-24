import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readFactoryAttemptLedger, verifyFactoryAttemptEnvironment }
  from '../../../server/src/lib/factoryAttemptLedger.ts';

import {
  ROOT, ENGINE, TASK, ATTEMPT, scratch, repository, declaration, fixture, configure,
  published, context, put, run, ok, saveProject, hook,
} from '../../fixtures/pipelineSample.mjs';

const cleanups = [];
const t = { after: (callback) => cleanups.push(callback) };
const [scenario, strategy = 'commit'] = process.argv.slice(2);
const ACTIONS = {
  commit: ['commit'],
  merge: ['commit', 'merge'],
  'pull-request': ['commit', 'push', 'pull-request'],
};

/**
 * Подготавливает legacy-профиль только из известных движку hooks.
 * Этот соседний сценарий не зависит от будущего образца и обязан быть GREEN на базе.
 */
async function legacy() {
  const root = await scratch(t);
  const source = await repository(root);
  const other = await repository(root, 'other', 'release');
  const profile = path.join(root, 'profiles/demo-profile');
  const state = path.join(root, 'state');
  const control = path.join(root, 'control');
  const project = declaration(root, source);

  project.id = 'demo-profile';
  project.workspace.mode = 'shared';
  await mkdir(state, { recursive: true });
  await put(root, 'strategy', 'commit');
  await put(profile, 'runners.env', [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'RUNNERS_COVERAGE=required',
    'PROJECT_RUNNER_PRIMARY=alpha', 'PROJECT_RUNNER_FAILOVER=',
    'MODEL_DEFAULT_ALPHA_FAMILY=fixture', 'MODEL_DEFAULT_ALPHA_VERSION=latest', '',
  ].join('\n'));
  await put(profile, 'graph.json', '{"capabilities":["route-v2"]}');
  await put(profile, 'profile.sh', [
    'PROFILE_NAME=demo-profile', 'PROFILE_SERVICE_HOST=127.0.0.1',
    "profile_workspace_mode() { printf 'shared\\n'; }",
    'profile_repositories() {',
    `  printf 'app\\t%s\\t%s\\n' '${source}' '${source}'`,
    `  printf 'other\\t%s\\t%s\\n' '${other}' '${other}'`,
    '}',
    'profile_source_branch() {',
    '  if [[ "${2:-}" == other ]]; then printf "release\\n"; else printf "main\\n"; fi',
    '}',
    "profile_container() { printf 'fixture-stand\\n'; }",
    'profile_stand_alive() { return 0; }',
    'profile_project_context() { printf "%s\\n" \'{"stack":["fixture"],"guardrails":[]}\'; }',
    "profile_service_ports() { printf '5173\\t8000\\n'; }",
    'profile_exclusive_resources() {',
    `  printf '%s\\n' 'stand:fixture-stand' 'workspace:${source}' 'workspace:${other}'`,
    '}',
  ].join('\n'));
  await put(profile, 'up.sh', `#!/bin/bash\ntouch '${root}/up-called'\nexit 99\n`);
  await put(profile, 'down.sh', `#!/bin/bash\ntouch '${root}/down-called'\nexit 99\n`);
  await put(root, 'owner-sentinel', 'не менять');

  const env = {
    ...process.env,
    FACTORY_HOME: ENGINE,
    FACTORY_TESTS_HOME: path.join(ROOT, 'tests/engine'),
    FACTORY_PROFILES_DIR: path.join(root, 'profiles'),
    FACTORY_RUNNERS_DIR: path.join(ROOT, 'tests/engine/fakes/runners'),
    FACTORY_FORBID_LIVE: '0',
    FAKE_ALPHA_RESULT: 'done',
    FACTORY_STATE: state,
    STATE_DIR: state,
    FACTORY_CONFIG_ROOT: path.join(root, 'config'),
    GRIGDESK_HOME: path.join(root, 'home'),
    TEST_ROOT: root,
  };
  const routes = path.join(root, 'routes');

  ok(run(process.execPath, [path.join(ROOT, 'tests/engine/fixtures/routes-catalog-publish.mjs'),
    routes, 'null'], { env }));

  return {
    root,
    source,
    other,
    profile,
    state,
    control,
    project,
    env,
    routes,
  };
}

/**
 * Вызывает настоящий launcher с явными временными state/control/store.
 * Существующий fixture-каталог останавливается на воротах, без publish и внешних действий.
 */
async function launch(f, mode = 'start', attempt = null) {
  const ticket = await put(f.root, 'ticket.json', JSON.stringify({
    schema: 1,
    taskId: TASK,
    title: 'Проверка режимов',
    description: 'Синтетическая задача',
    acceptanceCriteria: ['Первый узел'],
    sourceUrl: 'https://example.test/task/42',
  }));
  const args = [TASK, mode, '--profile', f.project.id, '--state-dir', f.state,
    '--control-dir', f.control, '--routes-dir', f.routes];

  if (mode === 'start') {
    args.push('--route', f.sample ? 'small' : 'feature', '--ticket-json', ticket,
      '--delivery-target', 'app=main');

    if (f.other) {
      args.push('--delivery-target', 'other=release');
    }
  } else {
    args.push('--attempt', attempt);
  }

  return run(path.join(ENGINE, 'bin/factory'), args, { env: f.env, timeout: 60000 });
}

/**
 * Запускает guard SHIP независимо от constructor контекста.
 * Так новый CLI-флаг не скрывает дефект проверки exact actions в runtime.
 */
async function guard() {
  const f = await legacy();
  const value = await context(f);

  value.delivery.strategy = strategy;
  value.delivery.actions = ACTIONS[strategy];

  const file = await put(f.root, 'delivery.json', JSON.stringify(value));
  const check = () => run('bash', ['-c',
    'source "$FACTORY_HOME/lib/route-runtime.sh"; _route_v2_require_delivery_context "$1" ship',
    'fixture', file], { env: f.env });

  ok(check());

  for (const mutate of [
    (v) => {
      v.delivery.strategy = 'unknown';
    },
    (v) => {
      v.delivery.actions.push('task-comment');
    },
    (v) => {
      v.decisions.acceptance.status = 'pending';
    },
  ]) {
    const invalid = structuredClone(value);

    mutate(invalid);
    await writeFile(file, JSON.stringify(invalid));
    assert.notEqual(check().status, 0);
  }
}

/**
 * Constructor проверяется настоящим factory-context, а не повтором словаря в Python.
 * Команда берётся из проверенной legacy-фикстуры и меняет только delivery-флаги.
 */
async function constructor() {
  const f = await legacy();
  const value = await context(f);
  const ticket = path.join(f.root, 'ticket.json');
  const common = [
    '--task', TASK, '--profile', f.project.id, '--attempt', ATTEMPT,
    '--catalog-hash', 'a'.repeat(64), '--route', 'feature', '--route-hash', 'b'.repeat(64),
    '--node', 'ship', '--run-key', 'SHIP', '--ticket-json', ticket,
    '--project-context-json', JSON.stringify({
      stack: value.project.stack,
      guardrails: value.project.guardrails,
    }),
    '--repo', `app:${f.source}:${f.source}:main`, '--state-dir', f.state,
    '--workspace-mode', 'shared', '--container-name', 'fixture-stand',
    '--frontend-port', '5173', '--api-port', '8000', '--source-branch', 'main',
    '--delivery-target', 'app=main', '--acceptance-decision', 'approved',
    '--delivery-strategy', strategy,
  ];

  for (const action of ACTIONS[strategy]) {
    common.push('--delivery-action', action);
  }

  const built = JSON.parse(ok(run(path.join(ENGINE, 'bin/factory-context'), common, { env: f.env })));

  assert.equal(built.delivery.strategy, strategy);
  assert.deepEqual(built.delivery.actions, ACTIONS[strategy]);
  assert.equal(value.delivery.strategy, undefined, 'legacy JSON не получает opt-in поле');
  assert.notEqual(run(path.join(ENGINE, 'bin/factory-context'),
    [...common, '--delivery-action', 'task-comment'], { env: f.env }).status, 0);
}

/**
 * Проверяет pin на реальной попытке; изменение hook после старта не выбирает новую сдачу.
 * Повреждённый immutable файл отвергается до нового вызова runner.
 */
async function pin() {
  const f = await legacy();
  const profileText = await readFile(path.join(f.profile, 'profile.sh'), 'utf8');

  await writeFile(path.join(f.profile, 'profile.sh'), `${profileText}\n`
    + `profile_delivery_strategy() { cat '${f.root}/strategy'; }\n`);
  ok(await launch(f));

  const registry = await readFile(path.join(f.state, `t${TASK}.pipeline`), 'utf8');
  const attempt = registry.match(/^ATTEMPT_ID=(.+)$/m)[1];
  const artifact = path.join(f.control, 'protocol-v2/tasks', `t${TASK}`, 'attempts', attempt,
    'artifacts/delivery.tsv');
  const pinned = await readFile(artifact, 'utf8');

  assert.match(pinned, /^strategy\tcommit$/m);
  assert.deepEqual(pinned.split('\n').filter((line) => line.startsWith('action\t')), ['action\tcommit']);
  await writeFile(path.join(f.root, 'strategy'), 'pull-request');
  ok(await launch(f, 'resume', attempt));
  assert.equal(await readFile(artifact, 'utf8'), pinned);
  await chmod(artifact, 0o600);
  await writeFile(artifact, pinned.replace('strategy\tcommit', 'strategy\tunknown'));
  await chmod(artifact, 0o400);

  const before = await readFile(path.join(f.root, 'invocations'), 'utf8');

  assert.notEqual((await launch(f, 'resume', attempt)).status, 0);
  assert.equal(await readFile(path.join(f.root, 'invocations'), 'utf8'), before);
}

/**
 * Старый shared контракт проверяется без образца: обе ветки и чужой sentinel сохраняются.
 * Up/down профиля намеренно завершаются ошибкой, если launcher попробует их вызвать.
 */
async function shared() {
  const f = await legacy();
  const before = [f.source, f.other].map((source) => [
    ok(run('git', ['-C', source, 'rev-parse', 'HEAD'])),
    ok(run('git', ['-C', source, 'status', '--porcelain'])),
  ]);

  ok(await launch(f));

  for (const [index, source] of [f.source, f.other].entries()) {
    assert.equal(ok(run('git', ['-C', source, 'rev-parse', 'HEAD'])), before[index][0]);
    assert.equal(ok(run('git', ['-C', source, 'status', '--porcelain'])), before[index][1]);
  }

  const env = await readFile(path.join(f.state, `t${TASK}.env`), 'utf8');

  assert.match(env, /^FE_PORT=5173$/m);
  assert.match(env, /^API_PORT=8000$/m);
  assert.match(env, /^REPO_0_BRANCH=main$/m);
  assert.match(env, /^REPO_1_BRANCH=release$/m);
  assert.equal(await readFile(path.join(f.root, 'owner-sentinel'), 'utf8'), 'не менять');
  assert.ok(!(await readdir(f.root)).includes('up-called'));
  assert.ok(!(await readdir(f.root)).includes('down-called'));

  const registry = await readFile(path.join(f.state, `t${TASK}.pipeline`), 'utf8');
  const attempt = registry.match(/^ATTEMPT_ID=(.+)$/m)[1];
  const pinned = await readFile(path.join(f.control, 'protocol-v2/tasks', `t${TASK}`, 'attempts',
    attempt, 'artifacts/profile-contract.tsv'), 'utf8');

  assert.doesNotMatch(pinned, /^stand-mode\t/m);
}

/**
 * Новый isolated-none профиль доходит до BUILD через настоящий launcher с fake runner.
 * Runner останавливает задачу у человека, поэтому VERIFY и браузер не требуют фиктивной приёмки.
 */
async function isolated() {
  const f = await fixture(t);

  ok(configure(f));

  const p = await published(f);

  f.routes = p.routes;
  f.sample = true;

  const graphFile = path.join(f.profile, 'graph.json');
  const graph = JSON.parse(await readFile(graphFile, 'utf8'));

  graph.capabilities = ['route-v2'];
  await writeFile(graphFile, JSON.stringify(graph));
  await put(f.root, 'runners/alpha.sh', [
    await readFile(path.join(f.root, 'runners/alpha.sh'), 'utf8'),
    'runner_alpha_run() {',
    '  printf "%s\\n" "$3" >>"$TEST_ROOT/seen-stages"',
    '  printf "%s\\n" "$2" >"$TEST_ROOT/first-prompt.txt"',
    '  FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh"',
    '    --task "$FACTORY_RUN_TASK" --stage "$FACTORY_RUN_STAGE"',
    '    --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH"',
    '    --failure-owner human --finding "fixture-stop=Синтетическая остановка" failed "Готово для проверки"',
    '}',
  ].join('\n').replace('stage-result.sh"\n', 'stage-result.sh" \\\n')
    .replace('"$FACTORY_RUN_STAGE"\n', '"$FACTORY_RUN_STAGE" \\\n')
    .replace('"$FACTORY_RUN_EPOCH"\n', '"$FACTORY_RUN_EPOCH" \\\n'));

  const before = ok(run('git', ['-C', f.source, 'rev-parse', 'HEAD']));

  ok(await launch(f));
  assert.equal((await readFile(path.join(f.root, 'seen-stages'), 'utf8')).trim(), 'BUILD');

  const prompt = await readFile(path.join(f.root, 'first-prompt.txt'), 'utf8');

  assert.match(prompt, /unavailable/);
  assert.doesNotMatch(prompt, /http:\/\/127\.0\.0\.1:\d+/);
  assert.equal(ok(run('git', ['-C', f.source, 'rev-parse', 'HEAD'])), before);
  assert.equal(ok(run('git', ['-C', f.source, 'status', '--porcelain'])), '');

  const env = await readFile(path.join(f.state, `t${TASK}.env`), 'utf8');

  assert.match(env, /^FE_PORT=(?:''|"")?$/m);
  assert.match(env, /^API_PORT=(?:''|"")?$/m);

  const registryText = await readFile(path.join(f.state, `t${TASK}.pipeline`), 'utf8');
  const registry = Object.fromEntries(registryText.trim().split('\n').map((line) => {
    const index = line.indexOf('=');

    return [line.slice(0, index), line.slice(index + 1)];
  }));
  const trusted = await readFactoryAttemptLedger({
    controlDir: f.control,
    stateDir: f.state,
    task: TASK,
    registry,
  });
  const exported = ok(run('bash', ['-c', 'set -a; source "$1"; env -0', 'fixture',
    path.join(f.state, `t${TASK}.env`)], { env: f.env }));
  const sandboxEnv = Object.fromEntries(exported.split('\0').filter(Boolean).map((line) => {
    const index = line.indexOf('=');

    return [line.slice(0, index), line.slice(index + 1)];
  }));

  assert.equal(trusted.standMode, 'none');
  assert.equal(verifyFactoryAttemptEnvironment(trusted, sandboxEnv), true);

  const progress = await readFile(path.join(f.state, `t${TASK}.stage`), 'utf8').catch(() => '');

  assert.doesNotMatch(progress.trim().split('\n').at(-1), /\|\d+\/\d+\|/);

  for (const route of Object.values(graph.routes || {})) {
    assert.ok(!Object.hasOwn(route.pos || {}, 'sandbox'));
  }

  assert.equal(ok(hook(f, 'profile_stand_mode', [TASK])), 'none');

  const workspace = trusted.repositories[0].workspace;
  const copyCommit = ok(run('git', ['-C', workspace, 'rev-parse', 'HEAD']));

  assert.equal(copyCommit, before);
  assert.equal(ok(run('git', ['-C', workspace, 'branch', '--show-current'])), `task-${TASK}`);
  assert.ok(!path.relative(f.project.workspace.root, workspace).startsWith('..'));
  ok(run('bash', [path.join(f.profile, 'status.sh'), TASK], { env: f.env }));
  ok(run('bash', [path.join(f.profile, 'down.sh'), TASK], { env: f.env }));
  assert.equal(ok(run('git', ['-C', workspace, 'rev-parse', 'HEAD'])), copyCommit);
  assert.equal(ok(run('git', ['-C', f.source, 'rev-parse', 'HEAD'])), before);
}

/**
 * Без opt-in старый профиль всё ещё обязан объявлять оба порта сервисов.
 * Отказ происходит до агента и не превращается в неявный режим none.
 */
async function legacyPortless() {
  const f = await legacy();
  const file = path.join(f.profile, 'profile.sh');
  const source = await readFile(file, 'utf8');

  await writeFile(file, source + '\nprofile_service_ports() { printf "\\t\\n"; }\n');

  const result = await launch(f);

  assert.equal(result.status, 78, result.stderr);
  await assert.rejects(readFile(path.join(f.root, 'invocations')), { code: 'ENOENT' });
}

try {
  const cases = {
    constructor,
    guard,
    pin,
    shared,
    isolated,
    legacyPortless,
  };

  assert.ok(cases[scenario], `Неизвестный сценарий ${scenario}`);
  await cases[scenario]();
} finally {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
}
