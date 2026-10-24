import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const SAMPLE = path.join(ROOT, 'server/seed/pipeline-sample');
export const ENGINE = path.join(ROOT, 'engine');
export const TASK = '42';
export const ATTEMPT = 'a_00000000000000000000000000000001';
export const RUN = '00000000-0000-4000-8000-000000000001';
export const SEQUENCES = {
  feature: ['plan', 'skeptic', 'gate_plan', 'tests', 'build', 'verify', 'browser', 'audit', 'gate_accept'],
  small: ['build', 'verify', 'review', 'recheck', 'browser', 'gate_accept'],
  debug: ['repro', 'diagnose', 'build', 'verify', 'review', 'recheck', 'browser', 'gate_accept'],
};

/**
 * Запускает только явную команду фикстуры, без shell и домашней конфигурации Git.
 * Ненулевой код возвращается тесту как наблюдение, а не теряется в исключении spawn.
 */
export function run(file, args = [], options = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      PYTHONDONTWRITEBYTECODE: '1',
      ...options.env,
    },
  });

  assert.ifError(result.error);

  return result;
}

/**
 * Проверяет код команды вместе с диагностикой, чтобы RED называл контракт продукта.
 * Таймаут, пропажа бинарника и падение фикстуры не маскируются под ожидаемый отказ.
 */
export function ok(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);

  return result.stdout.trim();
}

/**
 * Создаёт каталог только для текущего теста и регистрирует очистку до первых эффектов.
 * TEST_ROOT позволяет shell-обёртке использовать ту же изолированную фикстуру.
 */
export async function scratch(t) {
  const parent = process.env.TEST_ROOT || os.tmpdir();
  const root = await mkdtemp(path.join(parent, 'pipeline-sample-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

/**
 * Создаёт родительский каталог и записывает синтетический файл.
 * Все пути вызывающего теста расположены внутри его временной фикстуры.
 */
export async function put(root, relative, text) {
  const file = path.join(root, relative);

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);

  return file;
}

/**
 * Проверяет будущий ресурс внутри subtest до импорта или исполнения.
 * На исходном коде отсутствие образца является явным нарушением К1, а не ошибкой загрузчика.
 */
export async function requireSample(relative = 'profile/project.json') {
  const file = path.join(SAMPLE, relative);
  const bytes = await readFile(file).catch((error) => {
    assert.equal(error.code === 'ENOENT', false, `К1: в комплекте отсутствует образец ${relative}`);

    throw error;
  });

  return bytes;
}

/**
 * Делает маленький локальный Git-проект с тестом и правилами продукта.
 * Ожидаемые ветки и base SHA берутся из этого же репозитория, а не из внешнего файла.
 */
export async function repository(root, name = 'app', branch = 'main') {
  const source = path.join(root, name);

  await mkdir(source, { recursive: true });
  ok(run('git', ['init', '-q', '-b', branch, source]));
  ok(run('git', ['-C', source, 'config', 'user.name', 'Fixture']));
  ok(run('git', ['-C', source, 'config', 'user.email', 'fixture@example.test']));
  await put(source, 'app.mjs', 'export const answer = 42;\n');
  await put(source, 'PRODUCT.md', '# Правила продукта\nСохранять ответ.\n');
  await put(source, 'tests/old.test.mjs',
    'import assert from "node:assert/strict";\nassert.equal(42, 42);\n');
  ok(run('git', ['-C', source, 'add', '.']));
  ok(run('git', ['-C', source, 'commit', '-qm', 'Синтетическая база']));

  return source;
}

/**
 * Единственный проектный ввод фикстуры повторяет закрытую схему принятого плана.
 * Все команды записывают argv или работают с временным Git, сервисы не запускаются.
 */
export function declaration(root, source) {
  return {
    schema: 1,
    id: 'sample-profile',
    repositories: [{
      name: 'app',
      source,
      baseBranch: 'main',
      targetBranch: 'main',
      productRules: 'PRODUCT.md',
    }],
    workspace: {
      mode: 'isolated',
      root: path.join(root, 'workspaces'),
      prepare: [],
    },
    checks: {
      tests: [{
        repo: 'app',
        match: 'tests/**/*.test.mjs',
        argv: [process.execPath, path.join(root, 'adapter.mjs'), '{files}'],
        timeoutSeconds: 5,
      }],
      style: [],
      build: [],
    },
    stand: {
      hasInterface: false,
      frontendUrl: null,
      apiUrl: null,
      health: [],
      entryInstructions: '',
    },
    stack: ['Синтетический runtime'],
    guardrails: ['Сохранять ответ'],
    permissions: { allow: [], deny: [] },
    volatilePaths: [],
    delivery: {
      strategy: 'commit',
      remote: 'origin',
      pullRequestCommand: [process.execPath, path.join(root, 'pr.mjs')],
    },
    executors: {
      author: {
        provider: 'alpha',
        model: 'alpha-model',
        effort: 'medium',
        failover: [],
      },
      reviewer: {
        provider: 'alpha',
        model: 'alpha-reviewer',
        effort: 'medium',
        failover: [],
      },
    },
  };
}

/**
 * Копирует только tracked образец и заполняет его синтетическим описанием.
 * Машинные профили и данные владельца не читаются и не изменяются.
 */
export async function fixture(t) {
  await requireSample();

  const root = await scratch(t);
  const source = await repository(root);
  const profile = path.join(root, 'profiles', 'sample-profile');
  const state = path.join(root, 'state');
  const control = path.join(root, 'control');
  const project = declaration(root, source);

  await cp(path.join(SAMPLE, 'profile'), profile, { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(control, { recursive: true });
  await put(root, 'adapter.mjs', [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(path.join(root, 'calls.jsonl'))},`,
    'JSON.stringify(process.argv.slice(2)) + "\\n");',
  ].join('\n'));
  await put(root, 'pr.mjs', [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(path.join(root, 'pr.calls'))}, "PR\\n");`,
  ].join('\n'));
  await put(root, 'runners/alpha.sh', [
    'source "$FACTORY_TESTS_HOME/fakes/runners/alpha.sh"',
    'runner_alpha_catalog() {',
    "  printf 'alpha-model\\talpha\\tfixture\\t1\\tdefault\\t1\\t1\\t0\\t1\\t0.0.0\\t999.0.0\\n'",
    "  printf 'alpha-reviewer\\talpha\\tfixture\\t2\\tdefault\\t1\\t1\\t0\\t1\\t0.0.0\\t999.0.0\\n'",
    '}',
  ].join('\n'));
  await writeFile(path.join(profile, 'project.json'), JSON.stringify(project));

  const env = {
    FACTORY_HOME: ENGINE,
    FACTORY_PROFILES_DIR: path.join(root, 'profiles'),
    FACTORY_TESTS_HOME: path.join(ROOT, 'tests/engine'),
    FACTORY_RUNNERS_DIR: path.join(root, 'runners'),
    TEST_ROOT: root,
    FACTORY_TESTING: '1',
    FACTORY_FORBID_LIVE: '0',
    FACTORY_CONFIG_ROOT: path.join(root, 'config'),
    FACTORY_STATE: state,
    STATE_DIR: state,
    FACTORY_CONTROL_ROOT: control,
    GRIGDESK_HOME: path.join(root, 'home'),
    GRIGDESK_ROUTES_KIT: path.join(ROOT, 'server/src/modules/routes/publishKit.ts'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    GRIGDESK_PROVIDER_PREFS_PATH: path.join(root, 'provider-prefs.json'),
  };

  return {
    root,
    source,
    profile,
    state,
    control,
    project,
    env,
  };
}

export const saveProject = (f) => writeFile(path.join(f.profile, 'project.json'), JSON.stringify(f.project));

/**
 * Вызывает существующую границу shell hooks с позиционными аргументами.
 * Значения JSON и пути не становятся исполняемым текстом оболочки.
 */
export function hook(f, name, args = []) {
  return run('bash', ['-c', 'source "$1" || exit; shift; "$@"', 'fixture',
    path.join(f.profile, 'profile.sh'), name, ...args], { env: f.env, cwd: f.root });
}

export const configure = (f) => run('python3', [path.join(f.profile, 'configure.py'),
  '--factory', path.join(ENGINE, 'bin/factory')], { cwd: f.root, env: f.env });

/**
 * Публикует образец исключительно во временный store, затем читает его настоящим движком.
 * Ожидаемые hashes берутся из current, а не из формата stdout будущего publisher.
 */
export async function published(f) {
  const routes = path.join(f.root, 'routes');
  const publisher = path.join(f.profile, 'routes/publish.mjs');

  ok(run(process.execPath, [publisher, '--validate'], { env: f.env, cwd: f.root }));
  ok(run(process.execPath, [publisher, '--publish', '--base-dir', routes,
    '--expected-catalog-hash', 'null'], { env: f.env, cwd: f.root }));

  const cli = (...args) => run(path.join(ENGINE, 'bin/factory-route'),
    ['--routes-dir', routes, '--profile', f.project.id, ...args], { env: f.env });
  const current = JSON.parse(ok(cli('current')));
  const args = ['--catalog-hash', current.catalogHash];
  const describe = (route) => JSON.parse(ok(cli('describe-route', ...args, '--route', route))).machine;

  return {
    routes,
    cli,
    args,
    current,
    describe,
  };
}

/**
 * Строит настоящий typed context через engine CLI на основе профиля и временного Git.
 * Последующие тесты меняют ровно поля проверяемого сценария.
 */
export async function context(f, route = 'small', workspace = f.source) {
  const branch = ok(run('git', ['-C', workspace, 'branch', '--show-current']));
  const ticket = await put(f.root, 'ticket.json', JSON.stringify({
    schema: 1,
    taskId: TASK,
    title: 'Сохранить ответ',
    description: 'Проверить ответ целиком',
    acceptanceCriteria: ['Ответ равен 42', 'Правила сохранены'],
    sourceUrl: 'https://example.test/task/42',
  }));
  const result = run(path.join(ENGINE, 'bin/factory-context'), [
    '--task', TASK, '--profile', f.project.id, '--attempt', ATTEMPT,
    '--catalog-hash', 'a'.repeat(64), '--route', route, '--route-hash', 'b'.repeat(64),
    '--node', 'build', '--run-key', 'BUILD', '--ticket-json', ticket,
    '--project-context-json', JSON.stringify({ stack: f.project.stack, guardrails: f.project.guardrails }),
    '--repo', `app:${workspace}:${f.source}:${branch}`,
    '--state-dir', f.state, '--workspace-mode', f.project.workspace.mode,
    '--container-name', 'sample-task-42', '--frontend-port', '5173', '--api-port', '8000',
    '--source-branch', branch, '--acceptance-decision', 'approved',
    '--delivery-action', 'commit', '--delivery-action', 'push', '--delivery-action', 'pull-request',
    '--delivery-target', 'app=main',
  ], { env: f.env });
  const value = JSON.parse(ok(result));

  return value;
}

/**
 * Вызывает command hook по commandId из опубликованного определения.
 * Stdout проверяется тем же parser, который принимает вердикт в реальном запуске.
 */
export async function command(f, value, node) {
  const commandContext = { ...value, stage: { id: node.id, runKey: node.runKey } };
  const file = await put(f.root, 'context.json', JSON.stringify(commandContext));
  const result = hook(f, 'profile_route_command', [TASK, value.attempt.routeId || 'small',
    node.id, node.runKey, node.commandId, file]);
  const verdictFile = await put(f.root, 'verdict.json', result.stdout);
  const parsed = run('bash', ['-c',
    'source "$FACTORY_HOME/lib/route-runtime.sh"; _route_v2_command_result "$1"',
    'fixture', verdictFile], { env: f.env });

  ok(parsed);

  return JSON.parse(result.stdout);
}
