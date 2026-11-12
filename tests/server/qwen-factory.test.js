import assert from 'node:assert/strict';
import { access, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { spawnRouteEngine } from '../../server/src/lib/factoryRouteCli.ts';
import { buildHelper, loadHelpers } from '../../server/scripts/sea/helpers.mts';
import { compareInventory, scanProject } from '../../server/scripts/sea/inventory.mts';
import { cliJson, sourceRoot } from '../helpers/stageRunnerSettingsFixture.mjs';
import { qwenFactoryFixture, qwenRouteFixture, routePublicOutput } from '../helpers/qwenFactoryFixture.mjs';
import {
  QWEN_KEY, SECOND_KEY, qwenAdapter, qwenFixture, shellRun, until,
} from '../helpers/qwenFixture.mjs';

/**
 * Новый раннер вызывается через общий shell registry с настоящими probe/catalog.
 * Дефолт проверяется по именованным полям, порядок строк не является контрактом.
 */
function runnerScript(body) {
  return [
    'set -e',
    'source "$FACTORY_HOME/lib/runners/index.sh"',
    'runner_registry_load "$FACTORY_RUNNERS_DIR"',
    body,
  ].join('\n');
}

test('qwen-runner-catalog-and-default', async (t) => {
  const { stage } = await qwenFactoryFixture(t);
  const ready = stage.shell(runnerScript('runner_call qwen probe\nrunner_contract_check qwen'));

  assert.equal(ready.status, 0, ready.stderr);

  const catalog = stage.shell(runnerScript('runner_call qwen catalog'));

  assert.equal(catalog.status, 0, catalog.stderr);

  const rows = catalog.stdout.trim().split('\n').map((line) => line.split('\t'));

  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.length === 11));
  assert.ok(rows.some((row) => row[0] === 'shared-model(openai)'));
  assert.ok(rows.some((row) => row[0] === 'shared-model(anthropic)'));
  assert.ok(rows.every((row) => row[1] === 'qwen'));
  assert.equal(rows.find((row) => row[0] === 'shared-model(openai)')[2], 'default');

  const policy = stage.shell(runnerScript('runner_call qwen default_policy'));
  const fields = Object.fromEntries(policy.stdout.trim().split('\n').map((line) => line.split('=')));

  assert.equal(policy.status, 0, policy.stderr);
  assert.equal(fields.FAMILY, 'default');
  assert.equal(fields.VERSION, 'latest');
  assert.equal(fields.VARIANT, 'auto');
});

test('qwen-runner-model-options-refresh', async (t) => {
  const { qwen, stage } = await qwenFactoryFixture(t);
  const first = cliJson(stage.cli('options', ['--provider', 'qwen']));

  assert.equal(first.models.length, 2);
  assert.ok(first.models.every((model) => JSON.stringify(model.efforts) === '[""]'));
  qwen.settings.modelProviders.openai.push({
    id: 'runner-new',
    name: 'Новая модель',
    envKey: 'QWEN_TEST_KEY',
    baseUrl: 'http://127.0.0.1:9/v1',
  });
  await qwen.writeSettings(qwen.settings);

  const next = cliJson(stage.cli('options', ['--provider', 'qwen']));
  const adapter = await qwenAdapter();
  const chat = await adapter.catalog(qwen.config);

  assert.notEqual(first.catalogRevision, next.catalogRevision);
  assert.deepEqual(next.models.map((model) => model.id).sort(), chat.map((model) => model.id).sort());
  assert.equal(next.models.length, 3);
  assert.equal(await readFile(qwen.config.modelsPath, 'utf8'), 'sentinel-owner-registry');
  await qwen.writeSettings('{broken');

  const invalid = stage.cli('options', ['--provider', 'qwen']);

  assert.notEqual(invalid.status, 0);
  assert.match(`${invalid.stdout} ${invalid.stderr}`, /unavailable|недоступ|настро|конфиг|JSON/i);
});

test('qwen-secrets-systemd-and-detached', async (t) => {
  for (const [systemd, service] of [[true, true], [false, true], [true, false], [false, false]]) {
    const fixture = await qwenRouteFixture(t, systemd, { service });

    process.env.GRIGDESK_QWEN_SERVICE = 'qwencloud-intl';

    const result = await spawnRouteEngine(fixture.config, {
      task: 77,
      args: ['route', 'start', '77'],
      accessProviderIds: ['qwen'],
      extraEnv: {
        QWEN_TEST_KEY: 'hostile-key',
        SECOND_QWEN_KEY: 'hostile-key',
        UNRELATED_QWEN_KEY: 'foreign-key-must-not-leak',
        GRIGDESK_QWEN_BIN: '/evil/qwen',
        GRIGDESK_QWEN_SERVICE: 'openrouter',
      },
    });

    assert.equal(result.ok, true, JSON.stringify(result));

    const captured = await until(async () => {
      const content = await readFile(fixture.capture, 'utf8').catch(() => '');

      return content ? JSON.parse(content) : null;
    }, 'окружение движка');

    assert.equal(captured.env.QWEN_TEST_KEY, QWEN_KEY);
    assert.equal(captured.env.SECOND_QWEN_KEY, SECOND_KEY);
    assert.equal(captured.env.UNRELATED_QWEN_KEY, undefined);
    assert.equal(captured.env.GRIGDESK_QWEN_BIN, fixture.bin);
    assert.equal(captured.env.GRIGDESK_QWEN_HOME, fixture.qwenHome);
    assert.equal(captured.env.GRIGDESK_QWEN_SERVICE, 'qwencloud-intl');

    const output = await routePublicOutput(fixture, result);

    assert.equal(output.text.includes(QWEN_KEY), false);
    assert.equal(output.text.includes(SECOND_KEY), false);

    if (systemd) {
      const args = JSON.parse(output.argv.trim());
      const option = args.find((arg) => arg.startsWith('--property=EnvironmentFile='));

      assert.ok(option, 'Systemd должен получить ключи через EnvironmentFile');

      const file = option.slice('--property=EnvironmentFile='.length);

      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.ok((await readFile(file, 'utf8')).includes(QWEN_KEY));
    }
  }
});

test('qwen-secret-repeat-and-invalid', async (t) => {
  const fixture = await qwenRouteFixture(t, true, { service: false });
  const staticKey = 'synthetic-static-route-key';
  const input = {
    task: 77,
    args: ['route', 'start', '77'],
    accessProviderIds: ['qwen'],
  };

  process.env.DEEPSEEK_API_KEY = staticKey;
  fixture.accessEnv.DEEPSEEK_API_KEY = staticKey;

  const first = await spawnRouteEngine(fixture.config, input);

  assert.equal(first.ok, true);

  const output = await routePublicOutput(fixture, first);
  const args = JSON.parse(output.argv.trim().split('\n').at(-1));
  const option = args.find((arg) => arg.startsWith('--property=EnvironmentFile='));

  assert.ok(option, 'Нужен первоначальный файл ключей');

  const secretFile = option.slice('--property=EnvironmentFile='.length);

  for (const key of ['QWEN_TEST_KEY', 'SECOND_QWEN_KEY', 'DASHSCOPE_API_KEY']) {
    delete fixture.accessEnv[key];
    delete process.env[key];
  }

  const repeated = await spawnRouteEngine(fixture.config, input);

  assert.equal(repeated.ok, true);

  const remaining = await readFile(secretFile, 'utf8');

  assert.ok(remaining.includes(`DEEPSEEK_API_KEY="${staticKey}"`),
    'Удаление Qwen-ключей сохраняет статический секрет другого исполнителя');
  assert.doesNotMatch(remaining, /^(?:QWEN_TEST_KEY|SECOND_QWEN_KEY|DASHSCOPE_API_KEY)=/m);
  delete process.env.DEEPSEEK_API_KEY;
  delete fixture.accessEnv.DEEPSEEK_API_KEY;

  const empty = await spawnRouteEngine(fixture.config, input);

  assert.equal(empty.ok, true);
  await assert.rejects(access(secretFile), { code: 'ENOENT' });

  // NUL сохраняется в объекте access.env, но обрезается при записи в process.env.
  // Проверка недопустимых значений использует тот же источник, что и ветка service.
  const invalidFixture = await qwenRouteFixture(t, true);
  const valid = await spawnRouteEngine(invalidFixture.config, input);

  assert.equal(valid.ok, true);

  for (const invalid of ['bad\rkey', 'bad\nkey', 'bad\0key']) {
    invalidFixture.accessEnv.QWEN_TEST_KEY = invalid;

    const before = await readFile(path.join(invalidFixture.root, 'systemd.argv'), 'utf8');
    const rejected = await spawnRouteEngine(invalidFixture.config, input);

    assert.equal(rejected.ok, false, 'Некорректный секрет отклоняется до spawn');
    assert.equal(await readFile(path.join(invalidFixture.root, 'systemd.argv'), 'utf8'), before);
    assert.equal(JSON.stringify(rejected).includes(invalid), false);
  }
});

/**
 * Настоящий launcher владеет run identity и каналом stage_result.
 * Fake модели получает статусный MCP из wrapper, самостоятельно его не изобретает.
 */
async function launchQwen(t, { mode = 'workspace-write', options = {}, timeout = 8 } = {}) {
  const { qwen, stage } = await qwenFactoryFixture(t);
  const runDir = path.join(stage.env.STATE_DIR, 'logs/runs/t43/CHECK/run-qwen');

  if (mode === 'state-only') {
    qwen.trace = path.join(stage.env.STATE_DIR, 'fake-trace.jsonl');
  }

  const own = path.join(mode === 'state-only' ? stage.env.STATE_DIR : qwen.workspace, 'own-effect');
  const denied = [
    path.join(stage.root, 'sibling-canary'),
    path.join(stage.env.FACTORY_CONTROL_ROOT, 'private-canary'),
    ...(mode === 'state-only' ? [path.join(qwen.workspace, 'code-canary')] : []),
  ];

  for (const file of denied) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'original');
  }

  await qwen.fake({
    status: true,
    trace: qwen.trace,
    bounds: { allowed: [own], denied },
    ...(options.partial ? {
      eofAfterTool: true,
      effect: own,
      stderr: QWEN_KEY,
      tool: { name: 'run_shell_command', args: { command: 'printf allowed > own-effect' } },
    } : {}),
    ...options,
  });

  const result = await shellRun([
    'set -uo pipefail',
    'source "$FACTORY_HOME/lib/core.sh"',
    'source "$FACTORY_HOME/lib/pipeline-store.sh"',
    'source "$FACTORY_HOME/lib/run-state.sh"',
    'source "$FACTORY_HOME/lib/runners/index.sh"',
    'source "$FACTORY_HOME/lib/runner-launcher.sh"',
    'pipeline_store_route_init 43 CHECK || exit $?',
    'factory_control_init synthetic-control || exit $?',
    'run_state_begin 43 CHECK run-qwen 1 synthetic-status-token || exit $?',
    'runner_registry_load "$FACTORY_RUNNERS_DIR" || exit $?',
    'runner_call qwen probe || exit $?',
    'runner_launch qwen 43 "Выполни этап" CHECK "shared-model(openai)" "" \\',
    `  ${timeout} "$QWEN_TEST_RUN_DIR" run-qwen 1 synthetic-status-token`,
    'rc=$?',
    'printf "CLASSIFICATION=%s\\n" "$(runner_call qwen classify "$QWEN_TEST_RUN_DIR" "$rc")"',
    'exit "$rc"',
  ].join('\n'), {
    cwd: qwen.workspace,
    env: {
      ...stage.env,
      FACTORY_ROUTE_FILESYSTEM_POLICY: mode,
      QWEN_TEST_RUN_DIR: runDir,
    },
    timeout: 45000,
  });

  return {
    qwen,
    stage,
    runDir,
    result,
    own,
    denied,
  };
}

test('qwen-node-never-status-and-bounds', async (t) => {
  for (const mode of ['state-only', 'workspace-write']) {
    const { qwen, stage, runDir, result, own, denied } = await launchQwen(t, {
      mode,
      options: {
        ask: true,
        askDeniedContinues: true,
        tool: { name: 'ask_user_question', args: { question: 'Можно?' } },
      },
    });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /CLASSIFICATION=ok/);
    assert.equal(await readFile(path.join(runDir, 'last.md'), 'utf8'), 'Новый ответ');
    assert.match(await readFile(path.join(stage.env.STATE_DIR, 't43.pipeline'), 'utf8'), /CHECK=done/);

    const frames = (await qwen.records()).filter((item) => item.frame?.method === 'session/new');

    assert.ok(frames.length > 0);

    const expectedCwd = mode === 'state-only' ? stage.env.STATE_DIR : qwen.workspace;

    assert.equal(frames.at(-1).frame.params.cwd, expectedCwd);
    assert.equal(JSON.stringify(await qwen.records()).includes(QWEN_KEY), false);
    assert.equal(await readFile(own, 'utf8'), 'allowed');

    for (const file of denied) {
      assert.equal(await readFile(file, 'utf8'), 'original');
    }

    const attempts = (await qwen.records()).filter((item) => item.event === 'bounds');

    assert.equal(attempts.length, denied.length, 'Проверяются эффекты внутри child, а не только argv');
    assert.ok(attempts.every((attempt) => attempt.denied));

    const permission = (await qwen.records()).find((item) => item.frame?.id === 'permission-1'
      && !item.frame.method);

    assert.ok(permission, 'Wrapper обязан ответить на запрос разрешения');
    assert.notEqual(permission.frame.result?.outcome?.optionId, 'allow_once');

    const status = (await qwen.records()).filter((item) => item.event.startsWith('status-'));

    assert.equal(status.length, 2, 'MCP должен отклонить stale и принять текущий статус');
  }
});

test('qwen-timeout-cleans-own-tree', async (t) => {
  const { qwen, runDir, result } = await launchQwen(t, { options: { hold: true }, timeout: 1 });

  assert.equal(result.status, 124, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /CLASSIFICATION=timeout/);

  const meta = await readFile(path.join(runDir, 'meta.env'), 'utf8');
  const pid = Number(/^PID=(\d+)$/m.exec(meta)?.[1]);

  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

  const prompts = (await qwen.records()).filter((item) => item.frame?.method === 'session/prompt');

  assert.equal(prompts.length, 1, 'Timeout не запускает повторный ход');
});

test('qwen-partial-failure-not-replayed', async (t) => {
  const { qwen, result, own } = await launchQwen(t, { options: { partial: true } });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /CLASSIFICATION=unknown/);
  assert.equal((await qwen.records()).filter((item) => item.frame?.method === 'session/prompt').length, 1);
  assert.equal(await readFile(own, 'utf8'), 'effect', 'Сбой воспроизводится после выполненного эффекта');
  assert.equal(`${result.stdout}${result.stderr}`.includes(QWEN_KEY), false);
});

test('qwen-source-and-packaged-helper', async (t) => {
  const fixture = await qwenFixture(t);
  const helpers = await loadHelpers(path.join(sourceRoot, 'server/build/helpers.json'), sourceRoot);
  const helper = helpers.helpers.find((entry) => entry.id === 'qwen-runner');

  assert.ok(helper, 'Qwen host-wrapper отсутствует в поставке helper-ов');

  const compatibility = JSON.parse(await readFile(path.join(sourceRoot, 'server/build/compatibility.json')));

  assert.ok(compatibility.wrappers.some((entry) =>
    entry.helper === helper.id && entry.path === helper.entry));

  const inventory = JSON.parse(await readFile(path.join(sourceRoot, 'server/build/sea-inventory.json')));
  const belongsToQwen = (point) => point.file === helper.entry
    || point.file === 'engine/lib/runners/qwen.sh' || point.file.startsWith('server/src/lib/qwen/');
  const scanned = await scanProject(sourceRoot, {
    codeRoots: ['server/scripts', 'server/src/lib/qwen'],
    codeExtensions: ['.ts', '.mts', '.js', '.mjs'],
    shellRoots: ['engine/lib/runners'],
    shellExtensions: ['.sh'],
  });

  const inventoryErrors = compareInventory(
    inventory.points.filter(belongsToQwen), scanned.filter(belongsToQwen),
  );

  assert.deepEqual(inventoryErrors, [],
    'Точки поставки Qwen сверяются штатным scanner, соседний долг не участвует');

  const bundleRoot = path.join(fixture.root, 'bundle');
  const helpersDirectory = path.join(bundleRoot, 'server/runtime/helpers');

  await mkdir(helpersDirectory, { recursive: true });
  await mkdir(path.join(bundleRoot, 'runtime/node/bin'), { recursive: true });
  await symlink(process.execPath, path.join(bundleRoot, 'runtime/node/bin/node'));
  await symlink(path.join(sourceRoot, 'server/node_modules'), path.join(bundleRoot, 'node_modules'));
  await writeFile(path.join(helpersDirectory, 'helpers.json'), JSON.stringify(helpers));

  const built = await buildHelper({
    manifestPath: path.join(sourceRoot, 'server/build/helpers.json'),
    id: 'qwen-runner',
    root: sourceRoot,
    outDir: helpersDirectory,
    workDir: path.join(fixture.root, 'build'),
  });

  for (const file of [path.join(sourceRoot, helper.entry), built.file]) {
    const result = await shellRun('"$NODE_BIN" "$QWEN_WRAPPER" --invalid value', {
      cwd: fixture.workspace,
      env: {
        ...fixture.env,
        NODE_BIN: process.execPath,
        QWEN_WRAPPER: file,
      },
    });

    assert.notEqual(result.status, 0);

    const events = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const error = events.find((event) => event.event === 'wrapper_error');

    assert.ok(error, 'Отказ должен исходить из wrapper, а не из загрузчика Node');
    assert.match(error.message, /аргумент|неизвест|invalid|unknown/i);
    assert.equal(`${result.stdout}${result.stderr}`.includes(QWEN_KEY), false);
  }

  assert.equal(fileURLToPath(new URL('../../server/scripts/qwenRunner.mts', import.meta.url)),
    path.join(sourceRoot, helper.entry));
});
