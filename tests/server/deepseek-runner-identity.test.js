import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { routeFailure } from '../../server/src/lib/factoryRouteCli.ts';
import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { ensureTestDeepSeekBinaryPair } from '../helpers/deepseekBinary.mts';
import { prepareDeepSeekLaunch } from '../../server/src/lib/deepseek/runtime.ts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';

const exec = promisify(execFile);
// Корень репозитория не зависит от cwd: `npm test` запускает набор из server/.
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// Coverage-parser проверка удалена: она сорсила engine/lib/multi-runner.sh
// (_multi_probe_version), удалённый Go-переходом 3510328a1. Парсинг версии теперь
// выполняет deepseekRuntimeInfo.mts и проверяется остальными probe-тестами набора.

/**
 * Настоящая пара ELF проверяет Factory без model call и без доступного legacy current.
 * Выбор меняется через собственный symlink; пробелы и cache проходят отдельными argv.
 */
async function binaryFixture(t) {
  const pair = await ensureTestDeepSeekBinaryPair();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-binary-identity-'));
  const binary = path.join(root, 'selected binary');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink(pair.a.binary, binary);

  const env = {
    PATH: process.env.PATH,
    HOME: root,
    FACTORY_HOME: path.join(ROOT, 'engine'),
    FACTORY_TESTING: '1',
    FACTORY_FORBID_LIVE: '0',
    FACTORY_STATE: path.join(root, 'state'),
    STATE_DIR: path.join(root, 'state'),
    NODE_BIN: process.execPath,
    GRIGDESK_DEEPSEEK_NODE_BIN: process.execPath,
    GRIGDESK_DEEPSEEK_RUNTIME_MODE: 'binary',
    GRIGDESK_DEEPSEEK_BIN: binary,
    GRIGDESK_DEEPSEEK_CACHE_DIR: pair.a.cacheDir,
    GRIGDESK_DEEPSEEK_GENERATION_ROOT: path.join(root, 'missing-legacy'),
  };

  return {
    pair,
    root,
    binary,
    env,
    config: {
      deepseekRuntimeMode: 'binary',
      deepseekBin: binary,
      deepseekCacheDir: pair.a.cacheDir,
    },
    selectB: async () => {
      await fs.symlink(pair.b.binary, `${binary}.next`);
      await fs.rename(`${binary}.next`, binary);
    },
    run: (script, args = [], extra = {}) => exec('bash', ['-c', script, 'fixture', ...args], {
      env: { ...env, ...extra },
      cwd: root,
      timeout: 30000,
    }),
    info: (args = []) => exec(process.execPath, [path.join(ROOT, 'server/scripts/deepseekRuntimeInfo.mts'),
      '--binary', binary, '--cache-dir', pair.a.cacheDir, ...args], {
      env,
      cwd: root,
      timeout: 30000,
    }),
  };
}

test('binary Factory: descriptor равен чату, probe/catalog/coverage видят packageId A→B', {
  timeout: 900000,
}, async (t) => {
  const f = await binaryFixture(t);
  const chat = await resolveDeepSeekRuntimeAsync(f.config);
  const a = JSON.parse((await f.info()).stdout);

  assert.equal(a.kind, 'binary');
  assert.equal(a.identity, chat.identity);
  assert.equal(a.command, chat.command);
  assert.deepEqual(a.prefixArgs, chat.prefixArgs);
  assert.match(a.runnerVersion, new RegExp(f.pair.a.info.packageId));
  assert.equal((await f.info(['--probe'])).stdout.trim(), a.runnerVersion);

  const catalogA = (await f.info(['--catalog'])).stdout.trim().split('\n');

  assert.equal(catalogA.length, 4);
  assert.ok(catalogA.every((row) => row.split('\t').slice(9).every((value) => value === a.runnerVersion)));
  await f.selectB();

  const b = JSON.parse((await f.info()).stdout);

  assert.equal(b.metadata.buildId, a.metadata.buildId, 'Одинаковая generation у пары S08');
  assert.notEqual(b.runnerVersion, a.runnerVersion, 'Coverage различает поставки с одной generation');
  assert.match(b.runnerVersion, new RegExp(f.pair.b.info.packageId));
  assert.equal((await f.info(['--probe'])).stdout.trim(), b.runnerVersion);

  const catalogB = (await f.info(['--catalog'])).stdout.trim().split('\n');

  assert.ok(catalogB.every((row) => row.split('\t').slice(9).every((value) => value === b.runnerVersion)));
});

// Dispatcher-проверка старого probe после A→B удалена: она использовала внутренности
// shell-движка (multi-runner.sh, MULTI_PROBE_*, _multi_resolve), удалённые Go-переходом.
// Отказ runtime_changed при смене binary покрыт chat-runtime-binding и тестом ниже.

test('binary Factory: служебный Harness probe передаёт cache/prefix и завершает ACP без prompt', {
  timeout: 900000,
}, async (t) => {
  const f = await binaryFixture(t);
  const launch = await prepareDeepSeekLaunch({
    config: { ...f.config, deepseekRuntimeHome: path.join(f.root, 'runtime-home') },
    cwd: f.root,
    workspaceRoot: f.root,
    projectRoot: f.root,
    chatKey: 'metadata-probe',
    mode: 'read-only',
    approval: 'never',
    transport: 'acp',
  });
  const { stdout } = await exec(process.execPath, [path.join(ROOT, 'server/scripts/deepseekHarnessProbe.mts'),
    '--bin', f.binary, '--cache-dir', f.pair.a.cacheDir,
    '--cwd', f.root, '--home', launch.dshHome,
    '--launch-dir', launch.launchDir, '--overlay', launch.overlayPath], {
    env: f.env,
    cwd: f.root,
    timeout: 45000,
  });
  const report = JSON.parse(stdout);

  assert.equal(report.ok, true);
  assert.equal(report.packageId, f.pair.a.info.packageId);
  assert.ok(report.prefixArgs.includes(f.pair.a.cacheDir));
  assert.equal(report.processExit.code, 0, 'Успех сообщает только завершившийся процесс');
  assert.ok(report.configOptions.some((option) => option.id === 'model'));
});

/**
 * Fixture запускает настоящий runner, parser и dispatcher в изолированном состоянии.
 * Metadata-only executable запрещает prompt; current переключается только внутри fixture.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-runner-builds-'));
  const runtimeRoot = path.join(root, 'runtime');
  const a = runtimeInfoFixture();
  const b = runtimeInfoFixture();

  b.packageId = 'f'.repeat(64);
  b.buildId = 'e'.repeat(64);
  b.runtimeVersion = '9.2.0.grigdesk.beeeeeeeeeeeeeeee';

  for (const [name, info] of [['A', a], ['B', b]]) {
    const directory = path.join(runtimeRoot, 'builds', name);

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'deepseek'), [
      `#!${process.execPath}`,
      'if (!process.argv.includes("--runtime-info")) throw new Error("Только metadata fixture");',
      `process.stdout.write(${JSON.stringify(JSON.stringify(info))});`,
    ].join('\n') + '\n', { mode: 0o755 });
  }

  await fs.symlink('builds/A', path.join(runtimeRoot, 'current'));
  await fs.mkdir(path.join(root, 'state'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const env = {
    PATH: process.env.PATH,
    HOME: root,
    FACTORY_HOME: path.join(ROOT, 'engine'),
    FACTORY_TESTING: '1',
    FACTORY_FORBID_LIVE: '0',
    FACTORY_STATE: path.join(root, 'state'),
    STATE_DIR: path.join(root, 'state'),
    NODE_BIN: process.execPath,
    GRIGDESK_DEEPSEEK_NODE_BIN: process.execPath,
    GRIGDESK_DEEPSEEK_RUNTIME_MODE: 'binary',
    GRIGDESK_DEEPSEEK_BIN: path.join(runtimeRoot, 'current/deepseek'),
    GRIGDESK_DEEPSEEK_CACHE_DIR: path.join(root, 'cache'),
  };

  return {
    root,
    runtimeRoot,
    a: { ...a, runnerVersion: `${a.runtimeVersion.replace('.grigdesk.', '-grigdesk.')}.p${a.packageId}` },
    b: { ...b, runnerVersion: `${b.runtimeVersion.replace('.grigdesk.', '-grigdesk.')}.p${b.packageId}` },
    run: (script, args = [], extra = {}) => exec('bash', ['-c', script, 'fixture', ...args], {
      env: { ...env, ...extra },
      cwd: root,
      timeout: 30_000,
    }),
  };
}

// Metadata probe/catalog/version parser и долгоживущий dispatcher удалены: они
// сорсили shell-адаптеры engine/lib/runners/*.sh и multi-runner.sh (MULTI_PROBE_*,
// _multi_resolve, catalog_resolve), удалённые Go-переходом 3510328a1. Probe версии
// и catalog покрыты descriptor-тестом выше и Go-тестами фабрики.

test('runtime_changed остаётся отдельным понятным отказом route hash', () => {
  const failure = routeFailure('FACTORY_ERROR=runtime_changed RUNNERS=deepseek');

  assert.equal(failure?.error, 'runtime_changed');
  assert.match(failure.message, /runtime|сборк/i);
});

// Проверки host coverage при смене сборки и отказа каталога удалены: они сорсили
// engine/lib/profile-preflight.sh, coverage.sh и multi-runner.sh (_multi_require_coverage,
// coverage_artifact_get, _multi_resolve), удалённые Go-переходом 3510328a1. Coverage и
// invalid_config/route_unavailable теперь покрыты Go-тестами фабрики и route-наборами.

test('смена binary после preflight запрещает рабочий spawn; missing ELF не ищет PATH dsh', async (t) => {
  const f = await fixture(t);

  await f.run(`
    source "$FACTORY_HOME/lib/runners/deepseek.sh"
    export FACTORY_RUNNER_VERSION="$1" FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write
    ln -sfn builds/B "$2/current"
    factory_exec() {
      # Metadata helper тоже provider; sentinel отмечает только рабочий запуск.
      [[ "$1" != provider || "$3" == "$FACTORY_HOME/../server/scripts/deepseekRuntimeInfo.mts" ]] \
        || { touch launched; return 0; }
      shift
      "$@"
    }
    runner_deepseek_run 1 fixture BUILD \
      '["deepseek-official","deepseek-v4-flash"]' off 10 "$PWD/run" && exit 71
    [[ ! -e launched ]] || exit 72
    rm "$2/current"
    mkdir bin
    printf '#!/bin/sh\ntouch "$PWD/fallback"\n' >bin/dsh
    chmod +x bin/dsh
    export PATH="$PWD/bin:$PATH"
    runner_deepseek_probe && exit 73
    [[ ! -e fallback ]] || exit 74
    exit 0
  `, [f.a.runnerVersion, f.runtimeRoot]);
});
