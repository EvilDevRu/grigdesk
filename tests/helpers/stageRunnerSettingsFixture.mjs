import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const engine = path.join(sourceRoot, 'engine');
const fixtureShell = path.join(sourceRoot, 'tests/engine/lib/stage-runner-settings-fixture.sh');

/**
 * Создаёт настоящий trusted attempt, pinned route и временную модельную политику.
 * Только модельные адаптеры заменены: чтение, CLI, resolver и launcher принадлежат движку.
 */
export async function settingsFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-settings-'));
  const env = {
    PATH: `${sourceRoot}/tests/engine/fakes/bin:/usr/bin:/bin`,
    HOME: path.join(root, 'home'),
    GRIGDESK_HOME: path.join(root, 'data'),
    FACTORY_HOME: engine,
    FACTORY_TESTS_HOME: path.join(sourceRoot, 'tests/engine'),
    FACTORY_TESTING: '1',
    FACTORY_FORBID_LIVE: '1',
    FACTORY_CONTROL_ROOT: path.join(root, 'control'),
    FACTORY_CONFIG_ROOT: path.join(root, 'config'),
    FACTORY_STATE: path.join(root, 'state'),
    STATE_DIR: path.join(root, 'state'),
    TEST_ROOT: root,
    NODE_BIN: process.execPath,
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    GRIGDESK_PROVIDER_PREFS_PATH: path.join(root, 'prefs.json'),
    PYTHONDONTWRITEBYTECODE: '1',
    LC_ALL: 'C',
  };

  await Promise.all(['home', 'config', 'state', 'xdg-config', 'xdg-state', 'xdg-cache']
    .map((dir) => mkdir(path.join(root, dir), { recursive: true })));

  const initialized = execFileSync('bash', ['-c', [
    'set -e',
    'source "$1"',
    'settings_fixture',
    'jq -n --arg attempt "$attempt" --arg dir "$attempt_dir" --arg hash "$route_hash" \\',
    "  '{attempt: $attempt, attemptDir: $dir, routeHash: $hash}'",
  ].join('\n'), 'fixture', fixtureShell], {
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  const { attempt, attemptDir, routeHash } = JSON.parse(initialized);

  await writeFile(path.join(attemptDir, 'artifacts/profile-contract.tsv'), [
    'schema\t1', 'repos-mode\tgeneric', 'workspace-mode\tisolated', 'stand-ownership\ttask',
    'source-branch\tfixture', 'container\tfixture', 'service-host\t127.0.0.1',
    `repo\tapp\t${root}/work\t${root}/work`, '',
  ].join('\n'), { mode: 0o400 });

  const identity = {
    task: '81',
    profile: 'demo-profile',
    attempt,
    node: 'plan',
    stage: 'PLAN'
  };

  Object.assign(env, {
    FACTORY_PROFILES_DIR: path.join(root, 'profiles'),
    FACTORY_RUNNERS_DIR: path.join(root, 'runners'),
    FACTORY_LIFECYCLE_ATTEMPT_ID: attempt,
    FACTORY_LIFECYCLE_NODE_ID: 'plan',
    FACTORY_LIFECYCLE_RUN_KEY: 'PLAN',
    SETTINGS_ROUTE_HASH: routeHash,
    SETTINGS_ATTEMPT_DIR: attemptDir,
    FAKE_ALPHA_RESULT: 'done',
  });

  const prelude = [
    'PROFILE_NAME=demo-profile',
    'PROFILE_AGENT_CWD="$TEST_ROOT/work"',
    'PROFILE_AGENT_DIRS="$TEST_ROOT/work"',
    'source "$FACTORY_HOME/lib/core.sh"',
    'if [[ "${SETTINGS_LIFECYCLE:-0}" == 1 ]]; then',
    '  runtime_lifecycle_set_context_v2 81 "$FACTORY_LIFECYCLE_ATTEMPT_ID" demo-profile \\',
    '    "" "" os_11111111111111111111111111111111 >/dev/null || exit $?',
    '  runtime_lifecycle_session_begin_v2 initial >/dev/null || exit $?',
    '  runtime_lifecycle_set_route_v2 feature "$SETTINGS_ROUTE_HASH" || exit $?',
    '  pin=("$SETTINGS_ATTEMPT_DIR"/route-pin.*.json)',
    '  pin_hash=$(sha256sum "${pin[0]}" | cut -d" " -f1)',
    '  catalog=$(jq -r .catalogHash "$SETTINGS_ATTEMPT_DIR/attempt.json")',
    '  selected_at=$(jq -r .selectedAt "${pin[0]}")',
    '  [[ "$selected_at" == *.* ]] || selected_at="${selected_at%Z}.000Z"',
    '  runtime_lifecycle_route_selected_v2 "$catalog" "$pin_hash" "$selected_at" \\',
    '    operator_override >/dev/null || exit $?',
    '  runtime_lifecycle_node_visit_begin_v2 plan PLAN 1 initial >/dev/null || exit $?',
    '  runtime_lifecycle_node_execution_begin_v2 agent 0 1 >/dev/null || exit $?',
    'fi',
  ].join('\n');
  const children = [];

  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null) {
        continue;
      }

      spawnSync('bash', ['-c', `${prelude}\nruntime_interrupt_trusted_active 81 PLAN "" "" 1`], {
        env,
        timeout: 5000,
      });
      child.kill('SIGTERM');
    }

    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    env,
    identity,
    attemptDir,
    config: path.join(root, 'profiles/demo-profile/runners.env'),
    record: path.join(attemptDir, 'runner-settings/plan.json'),
    /**
     * Вызывает настоящий factory массивом argv без shell-подстановок payload.
     * Отказ сохраняется результатом, чтобы assert проверял ожидаемый код и причину.
     */
    cli(operation, extra = [], selectedIdentity = identity) {
      const args = [selectedIdentity.task, 'runner', 'settings', operation,
        '--profile', selectedIdentity.profile, '--attempt', selectedIdentity.attempt,
        '--node', selectedIdentity.node, '--stage', selectedIdentity.stage, ...extra];

      return spawnSync(path.join(engine, 'bin/factory'), args, {
        env,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
    },
    shell(script, extraEnv = {}) {
      return spawnSync('bash', ['-c', `${prelude}\n${script}`], {
        env: { ...env, ...extraEnv },
        encoding: 'utf8',
        timeout: 20_000,
      });
    },
    /**
     * Запускает реальный run_agent отдельно, позволяя удерживать живую попытку latch-ом.
     * Завершение child и остановка принадлежат только созданной здесь задаче.
     */
    start(extraEnv = {}) {
      const child = spawn('bash', ['-c', `${prelude}\nrun_agent 81 fixture PLAN`], {
        env: {
          ...env,
          SETTINGS_LIFECYCLE: '1',
          ...extraEnv
        }, stdio: ['ignore', 'pipe', 'pipe'],
      });

      children.push(child);

      let output = '';

      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        output += data;
      });

      const finished = new Promise((resolve) => {
        child.on('close', (code, signal) => resolve({
          status: code,
          signal,
          output
        }));
      });

      return { child, finished };
    },
    async seed(selection, revision = 1) {
      await mkdir(path.dirname(this.record), { recursive: true, mode: 0o700 });
      await writeFile(this.record, JSON.stringify({
        schema: 1,
        identity,
        revision,
        selection,
        failover: selection.primary === null ? null : ['beta'],
        receipt: null,
      }), { mode: 0o600 });
    },
    async captures() {
      const text = await readFile(path.join(root, 'argv.tsv'), 'utf8');

      return text.trim().split('\n').filter(Boolean).map((line) => {
        const [provider, model, effort, id, epoch] = line.split('\t');

        return {
          provider,
          model,
          effort,
          id,
          epoch: Number(epoch)
        };
      });
    },
  };
}

/**
 * Декодирует только успешный ответ CLI: отсутствие операции даёт поведенческий assert.
 * Ошибка импорта или JSON fixture не маскируется сообщением об ожидаемом RED.
 */
export function cliJson(result, label = 'settings CLI') {
  assert.equal(result.error, undefined, `${label}: процесс должен запускаться`);
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);

  return JSON.parse(result.stdout);
}

export const selection = (model = 'alpha-strong', effort = 'max', primary = null) => ({
  primary,
  parametersFor: 'alpha',
  model,
  effort,
});

/**
 * CAS-ожидания берутся из того же options, который читает пользовательский редактор.
 * Тест не фиксирует ревизию каталога из постороннего файла или прошлой попытки.
 */
export function applyPayload(options, selected = selection(), mode = 'next', requestId = 'settings-test') {
  return {
    identity: options.identity,
    expectedRevision: options.revision,
    expectedRun: options.actual?.run ?? null,
    catalogRevision: options.catalogRevision,
    requestId,
    mode,
    selection: selected,
  };
}

export const applyCli = (fixture, payload) => fixture.cli('apply', ['--payload', JSON.stringify(payload)]);

/**
 * Ждёт наблюдаемый эффект с конечным сроком, не полагаясь на фиксированную задержку.
 * Все обращения замкнуты на временный каталог теста.
 */
export async function waitFor(check, label) {
  const end = Date.now() + 8000;

  while (Date.now() < end) {
    const value = await check();

    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.fail(`Не дождались: ${label}`);
}

/**
 * Два независимых процесса конкурируют за одну CAS revision настоящего CLI.
 * Асинхронный запуск нужен именно для гонки, последовательный отказ её не доказывает.
 */
export function applyCliAsync(fixture, payload) {
  const identity = fixture.identity;
  const args = [identity.task, 'runner', 'settings', 'apply',
    '--profile', identity.profile, '--attempt', identity.attempt, '--node', identity.node,
    '--stage', identity.stage, '--payload', JSON.stringify(payload)];

  return new Promise((resolve) => {
    execFile(path.join(engine, 'bin/factory'), args, {
      env: fixture.env,
      encoding: 'utf8',
      timeout: 15_000,
    }, (error, stdout, stderr) => {
      resolve({
        status: error ? error.code : 0,
        stdout,
        stderr
      });
    });
  });
}
