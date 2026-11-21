import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { spawnRouteEngine } from '../../server/src/lib/factoryRouteCli.ts';
import { buildHelper, loadHelpers } from '../../server/scripts/sea/helpers.mts';
import { compareInventory, scanProject } from '../../server/scripts/sea/inventory.mts';
import { stageFactoryCandidate } from '../../server/scripts/binary/factoryCandidate.mts';
import { testFactoryBinary } from '../helpers/factoryBinary.mjs';
import { cliJson, sourceRoot } from '../helpers/stageRunnerSettingsFixture.mjs';
import { qwenFactoryFixture, qwenRouteFixture, routePublicOutput } from '../helpers/qwenFactoryFixture.mjs';
import {
  QWEN_KEY, SECOND_KEY, qwenAdapter, qwenFixture, shellRun, until,
} from '../helpers/qwenFixture.mjs';
import { expectAttempt, prepareCommandServer } from './helpers/factoryGoRuntime.mts';

const execute = promisify(execFile);

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

test('Go проводит Qwen через metadata, ворота и один результат ACP', {
  skip: process.platform !== 'linux',
  timeout: 60_000,
}, async (t) => {
  const qwen = await qwenFixture(t);
  const binary = testFactoryBinary();
  const fx = await prepareCommandServer(t, qwen.root, binary, true);
  const { config } = fx;
  const trace = path.join(config.stateDir, 'qwen-trace.jsonl');
  const profile = path.join(config.profilesDir, 'demo-profile/runners.env');
  const ticket = path.join(qwen.root, 'ticket.json');

  await chmod(config.stateDir, 0o700);
  await qwen.fake({
    status: true,
    trace,
    metadataTraceOptional: true,
  });
  await writeFile(profile, (await readFile(profile, 'utf8')).replace(
    'PROJECT_RUNNER_PRIMARY=deepseek', 'PROJECT_RUNNER_PRIMARY=qwen',
  ));
  await writeFile(path.join(qwen.root, 'release-command'), '');
  await writeFile(ticket, JSON.stringify({
    schema: 1,
    taskId: '71',
    title: 'Factory Qwen',
    description: 'Локальный ACP',
    acceptanceCriteria: ['Один результат этапа'],
    sourceUrl: 'https://example.test/71',
  }));

  const paths = [
    '--profile', 'demo-profile', '--routes-dir', config.routesDir,
    '--state-dir', config.stateDir, '--control-dir', config.factoryControlDir,
  ];
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    SHELL: '/bin/bash',
    HOME: qwen.home,
    GRIGDESK_HOME: qwen.dataHome,
    GRIGDESK_QWEN_HOME: qwen.qwenHome,
    GRIGDESK_QWEN_BIN: qwen.bin,
    FACTORY_HOME: path.join(sourceRoot, 'engine'),
    FACTORY_PROFILES_DIR: config.profilesDir,
    NODE_BIN: process.execPath,
    TMPDIR: '/tmp',
    FACTORY_QWEN_CREDENTIAL_NAMES: 'QWEN_TEST_KEY,SECOND_QWEN_KEY',
    QWEN_TEST_KEY: QWEN_KEY,
    SECOND_QWEN_KEY: SECOND_KEY,
  };
  const invoke = (operation, ...args) => execute(binary, ['71', operation, ...paths, ...args], {
    env,
    timeout: 25_000,
  });

  try {
    await execute(process.execPath, [path.join(sourceRoot, 'server/scripts/qwenRunner.mts'),
      '--metadata', 'options', '--bin', qwen.bin], { env, timeout: 10_000 });
    await invoke('start', '--route', 'command', '--ticket-json', ticket);

    const waiting = await expectAttempt(fx.adapter, (attempt) => attempt.cursor?.node === 'gate_accept');

    await invoke('gate', '--attempt', waiting.attempt, '--node', 'gate_accept',
      '--decision', 'approved', '--commit-only');
    await invoke('resume', '--attempt', waiting.attempt);
    await expectAttempt(fx.adapter, (attempt) => attempt.terminal === 'completed');
  } catch (error) {
    const dir = path.join(config.stateDir, 'logs/runs/t71/BUILD');
    const runs = await readdir(dir).catch(() => []);
    const diagnostics = await Promise.all(runs.map((run) =>
      readFile(path.join(dir, run, 'stderr.log'), 'utf8').catch(() => '')));

    throw new Error(diagnostics.join('\n') || String(error), { cause: error });
  }

  const records = (await readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(records.filter((row) => row.event === 'status-current').length, 1);
  assert.equal(records.find((row) => row.event === 'status-current').response.result.isError, false);
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
    || point.file.startsWith('server/src/lib/qwen/');
  const scanned = await scanProject(sourceRoot, {
    codeRoots: ['server/scripts', 'server/src/lib/qwen'],
    codeExtensions: ['.ts', '.mts', '.js', '.mjs'],
    shellRoots: [],
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
  await stageFactoryCandidate({
    root: bundleRoot,
    binary: testFactoryBinary(),
    profileAbi: path.join(sourceRoot, 'engine/lib/delivery_contract.py'),
    os: process.platform,
    arch: process.arch,
  });

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
