import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { settingsFixture, sourceRoot } from './stageRunnerSettingsFixture.mjs';
import { QWEN_KEY, SECOND_KEY, qwenAdapter, qwenFixture } from './qwenFixture.mjs';
import { listInstalledRunners } from '../../server/src/lib/runnersCatalog.ts';

/**
 * В дочерний Factory попадают только пути и синтетические ключи этой фикстуры.
 * Родительские lifecycle, секреты и параметры чужого маршрута не наследуются.
 */
function qwenFactoryEnvironment(fixture) {
  const keys = [
    'HOME', 'GRIGDESK_HOME', 'GRIGDESK_ARTIFACTS_DIR',
    'QWEN_HOME', 'GRIGDESK_QWEN_HOME', 'GRIGDESK_QWEN_BIN',
    'QWEN_CODE_SYSTEM_SETTINGS_PATH', 'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
    'QWEN_TEST_KEY', 'SECOND_QWEN_KEY', 'DASHSCOPE_API_KEY', 'CI', 'NO_COLOR',
  ];

  return {
    ...Object.fromEntries(keys.map((key) => [key, fixture.env[key]])),
    SHELL: '/bin/bash',
  };
}

/**
 * Реальный реестр проверяется до копирования модуля во временный профиль.
 * Отсутствие Qwen на базе даёт assertion, а не ENOENT или shell command-not-found.
 */
export async function qwenFactoryFixture(t) {
  const qwen = await qwenFixture(t);
  const installed = await listInstalledRunners({ factoryHome: path.join(sourceRoot, 'engine') });

  assert.ok(installed.includes('qwen'), 'Реестр конвейера не содержит раннера Qwen');

  const stage = await settingsFixture(t);

  await copyFile(path.join(sourceRoot, 'engine/lib/runners/qwen.sh'),
    path.join(stage.env.FACTORY_RUNNERS_DIR, 'qwen.sh'));
  Object.assign(stage.env, qwenFactoryEnvironment(qwen), {
    FACTORY_HOME: path.join(sourceRoot, 'engine'),
    FACTORY_TESTS_HOME: path.join(sourceRoot, 'tests/engine'),
    FACTORY_RUNNERS_DIR: path.join(stage.root, 'runners'),
    FACTORY_PROFILES_DIR: path.join(stage.root, 'profiles'),
    FACTORY_STATE: path.join(stage.root, 'state'),
    STATE_DIR: path.join(stage.root, 'state'),
    FACTORY_CONTROL_ROOT: path.join(stage.root, 'control'),
    FACTORY_CONFIG_ROOT: path.join(stage.root, 'config'),
    TEST_ROOT: stage.root,
    NODE_BIN: process.execPath,
    FACTORY_FORBID_LIVE: '0',
    GRIGDESK_QWEN_BIN: qwen.bin,
    GRIGDESK_QWEN_CONFIG_ROOT: qwen.config.rootDir,
  });
  await writeFile(stage.config, [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'PROJECT_RUNNER_PRIMARY=qwen', 'PROJECT_RUNNER_FAILOVER=',
    'MODEL_DEFAULT_QWEN_FAMILY=default', 'MODEL_DEFAULT_QWEN_VERSION=latest',
    'MODEL_DEFAULT_QWEN_VARIANT=auto', '',
  ].join('\n'));

  return { qwen, stage };
}

/**
 * Systemd stub собирает env с нуля, разбирая настоящий EnvironmentFile.
 * Переменные вызывающего процесса сами по себе в сервис не попадают.
 */
function systemdSource(root, available) {
  return `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(${available ? 0 : 1});
fs.appendFileSync(${JSON.stringify(path.join(root, 'systemd.argv'))}, JSON.stringify(args) + '\\n');
const env = {};
let command;
for (const [index, arg] of args.entries()) {
  if (arg.startsWith('--setenv=')) {
    const pair = arg.slice(9);
    env[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1);
  } else if (arg.startsWith('--property=EnvironmentFile=')) {
    const file = arg.slice('--property=EnvironmentFile='.length);
    for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
      const match = /^([A-Z_][A-Z0-9_]*)="((?:[^"\\\\]|\\\\.)*)"$/.exec(line);
      if (line && !match) process.exit(65);
      if (match) env[match[1]] = match[2].replace(/\\\\(.)/g, '$1');
    }
  } else if (!arg.startsWith('--')) {
    command = args.slice(index);
    break;
  }
}
const result = spawnSync(command[0], command.slice(1), { env, stdio: 'ignore' });
process.exit(result.status ?? 1);
`;
}

/**
 * Обе ветки запуска идут через настоящий spawnRouteEngine с legacy adapter credentials.
 * Чужой ключ и hostile extraEnv нужны для проверки отбора только участников маршрута.
 */
export async function qwenRouteFixture(t, systemd, { service = true } = {}) {
  const fixture = await qwenFixture(t);
  const binDir = path.join(fixture.root, 'bin');
  const capture = path.join(fixture.root, 'engine-env.json');

  await mkdir(binDir);
  await writeFile(path.join(binDir, 'systemd-run'), systemdSource(fixture.root, systemd), { mode: 0o700 });

  const factoryBin = path.join(fixture.root, 'engine/bin/factory');

  await mkdir(path.dirname(factoryBin), { recursive: true });
  await writeFile(factoryBin, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(capture)},
  JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
`, { mode: 0o700 });
  await validateSystemdFixture(fixture.root, factoryBin, capture);

  const adapter = await qwenAdapter();

  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.UNRELATED_QWEN_KEY = 'foreign-key-must-not-leak';

  // Статические ключи имеют собственный контракт доставки и задаются самим тестом.
  // Их удаление из родительского env не даёт фикстуре читать секреты владельца.
  for (const key of ['DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'ZAI_CODING_API_KEY']) {
    delete process.env[key];
  }

  const env = {
    ...qwenFactoryEnvironment(fixture),
    QWEN_TEST_KEY: QWEN_KEY,
    SECOND_QWEN_KEY: SECOND_KEY,
    UNRELATED_QWEN_KEY: 'foreign-key-must-not-leak',
  };
  const foreign = {
    id: 'foreign', credentials: [{
      env: 'UNRELATED_QWEN_KEY',
      label: 'Чужой ключ',
      kind: 'secret',
    }],
  };
  const config = {
    ...fixture.config,
    routesDir: path.join(fixture.root, 'routes'),
    factoryControlDir: path.join(fixture.root, 'control'),
    factoryBin,
    installationBin: binDir,
    factoryHome: path.join(fixture.root, 'engine'),
    profilesDir: path.join(fixture.root, 'profiles'),
    factoryConfigRoot: path.join(fixture.root, 'config'),
    accessProfiles: service ? {
      env,
      adaptersOf: async () => new Map([['qwen', adapter], ['foreign', foreign]]),
      pinnedProviders: async () => [],
    } : undefined,
  };

  return {
    ...fixture,
    config,
    capture,
    accessEnv: env,
  };
}

/**
 * Разбор EnvironmentFile проверяется ещё до ожидаемого отсутствия карточки Qwen.
 * Фикстура запускает только свой маленький движок и затем удаляет пробные снимки.
 */
async function validateSystemdFixture(root, factoryBin, capture) {
  const file = path.join(root, 'probe.env');
  const systemd = path.join(root, 'bin/systemd-run');

  await writeFile(file, 'PROBE_KEY="synthetic-check"\n', { mode: 0o600 });

  const probe = spawnSync(process.execPath, [systemd,
    '--setenv=PROBE_PATH=host-path', `--property=EnvironmentFile=${file}`, factoryBin], {
    encoding: 'utf8', timeout: 5000,
  });

  assert.equal(probe.status, 0, `Фикстура systemd не запускается: ${probe.stderr}`);

  const captured = JSON.parse(await readFile(capture, 'utf8'));

  assert.equal(captured.env.PROBE_KEY, 'synthetic-check');
  assert.equal(captured.env.PROBE_PATH, 'host-path');
  await Promise.all([capture, file, path.join(root, 'systemd.argv')].map((item) => rm(item)));
}

/**
 * Аргументы и журналы фиксируются отдельно от приватного файла с секретами.
 * Каждая найденная утечка относится к синтетическим значениям этой фикстуры.
 */
export async function routePublicOutput(fixture, result) {
  const argv = await readFile(path.join(fixture.root, 'systemd.argv'), 'utf8').catch(() => '');
  const log = await readFile(result.logFile, 'utf8').catch(() => '');

  return {
    argv,
    log,
    text: JSON.stringify([result, argv, log]),
  };
}
