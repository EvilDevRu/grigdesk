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
import { writeDeepSeekBinaryStub } from '../helpers/deepseekBinaryStub.mts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';

const exec = promisify(execFile);
// Корень репозитория не зависит от cwd: `npm test` запускает набор из server/.
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('binary Factory: coverage parser сохраняет packageId и у стабильной upstream версии', async (t) => {
  const info = runtimeInfoFixture();
  const { binary, root } = await writeDeepSeekBinaryStub(t,
    `process.stdout.write(${JSON.stringify(JSON.stringify(info))});`);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    FACTORY_HOME: path.join(ROOT, 'engine'),
  };
  const { stdout } = await exec(process.execPath, [path.join(ROOT, 'server/scripts/deepseekRuntimeInfo.mts'),
    '--binary', binary, '--cache-dir', path.join(root, 'cache'), '--probe'], { env });
  const version = stdout.trim();
  const parsed = await exec('bash', ['-c', `
    source "$FACTORY_HOME/lib/multi-runner.sh"
    _multi_probe_version "$1"
  `, 'fixture', version], { env });

  assert.match(version, new RegExp(info.packageId));
  assert.equal(parsed.stdout.trim(), version, 'Общий parser не обрезает packageId после stable version');
});

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

test('binary Factory: dispatcher запрещает старый probe после A→B без failover', {
  timeout: 900000,
}, async (t) => {
  const f = await binaryFixture(t);
  const config = path.join(f.root, 'runners.env');

  await fs.writeFile(config, 'MODEL_DEFAULT_DEEPSEEK_FAMILY=default\n');

  const { stdout, stderr } = await f.run(`
    source "$FACTORY_HOME/lib/multi-runner.sh"
    runner_registry_add deepseek "$FACTORY_HOME/lib/runners/deepseek.sh"
    config_file=$1
    multi_runner_config_file() { printf '%s\\n' "$config_file"; }
    MULTI_STAGE=BUILD
    MULTI_CATALOG_ROOT="$PWD/catalog"
    mkdir "$MULTI_CATALOG_ROOT"
    declare -A MULTI_PROBE_READY=() MULTI_PROBE_VERSION=() MULTI_PLAN_LEVEL=() MULTI_PLAN_DEGRADED=()
    _multi_resolve deepseek || exit 51
    [[ "$DISPATCH_RUNNER_VERSION" == *"$2"* ]] || exit 52
    ln -s "$3" "$GRIGDESK_DEEPSEEK_BIN.next"
    mv "$GRIGDESK_DEEPSEEK_BIN.next" "$GRIGDESK_DEEPSEEK_BIN"
    _multi_resolve deepseek && exit 53
    [[ "$DISPATCH_RESOLVE_RESULT" == runtime_changed ]] || exit 54
    printf '%s\\n' "$DISPATCH_RESOLVE_RESULT"
  `, [config, f.pair.a.info.packageId, f.pair.b.binary]);

  assert.equal(stdout.trim(), 'runtime_changed');
  assert.match(stderr, /FACTORY_ERROR=runtime_changed/u);
});

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

test('binary metadata probe/catalog/version parser сохраняют полный suffix и exact min/max', async (t) => {
  const f = await fixture(t);
  const { stdout } = await f.run(`
    source "$FACTORY_HOME/lib/runners/deepseek.sh"
    source "$FACTORY_HOME/lib/runners/catalog.sh"
    version=$(runner_deepseek_probe) || exit
    [[ "$version" == "$1" ]] || exit 41
    parsed=$(grep -oE '[0-9]+([.][0-9]+)+(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?' <<<"$version")
    [[ "$parsed" == "$version" ]] || exit 42
    mkdir snapshot
    runner_deepseek_catalog >snapshot/models.tsv || exit
    awk -F '\t' -v version="$version" \
      'NF != 11 || $10 != version || $11 != version {exit 43}' snapshot/models.tsv
    catalog_resolve snapshot deepseek default latest auto "$version" || exit
    catalog_resolve snapshot deepseek default latest auto "$2" >/dev/null && exit 44
    exit 0
  `, [f.a.runnerVersion, f.b.runnerVersion]);

  assert.match(stdout, /deepseek-v4-flash/);
});

test('долгоживущий dispatcher не использует probe A для нового узла B', async (t) => {
  const f = await fixture(t);
  const config = path.join(f.root, 'runners.env');

  await fs.writeFile(config, 'MODEL_DEFAULT_DEEPSEEK_FAMILY=default\n');

  const { stdout, stderr } = await f.run(`
    source "$FACTORY_HOME/lib/multi-runner.sh"
    runner_registry_add deepseek "$FACTORY_HOME/lib/runners/deepseek.sh"
    multi_runner_config_file() { printf '%s\n' "$1"; }
    config_file=$1
    multi_runner_config_file() { printf '%s\n' "$config_file"; }
    MULTI_STAGE=BUILD
    MULTI_CATALOG_ROOT="$PWD/catalog"
    mkdir "$MULTI_CATALOG_ROOT"
    declare -A MULTI_PROBE_READY=() MULTI_PROBE_VERSION=() MULTI_PLAN_LEVEL=() MULTI_PLAN_DEGRADED=()
    _multi_resolve deepseek || exit 51
    [[ "$DISPATCH_RUNNER_VERSION" == "$2" ]] || exit 52
    ln -sfn builds/B "$3/current"
    _multi_resolve deepseek && exit 53
    [[ "$DISPATCH_RESOLVE_RESULT" == runtime_changed ]] || exit 54
    printf '%s\n' "$DISPATCH_RESOLVE_RESULT"
  `, [config, f.a.runnerVersion, f.runtimeRoot]);

  assert.equal(stdout.trim(), 'runtime_changed');
  assert.match(stderr, /FACTORY_ERROR=runtime_changed/);
});

test('runtime_changed остаётся отдельным понятным отказом route hash', () => {
  const failure = routeFailure('FACTORY_ERROR=runtime_changed RUNNERS=deepseek');

  assert.equal(failure?.error, 'runtime_changed');
  assert.match(failure.message, /runtime|сборк/i);
});

test('новая сборка DeepSeek в резерве обновляет host coverage, узел Claude продолжает', async (t) => {
  const f = await fixture(t);
  const profiles = path.join(f.root, 'profiles');
  const config = path.join(profiles, 'fixture/runners.env');
  const bin = path.join(f.root, 'bin');

  // Claude CLI нужен preflight только как версия; prompt этот fixture не исполняет.
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\nprintf "2.1.220 (Claude Code)\\n"\n',
    { mode: 0o755 });
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'RUNNERS_COVERAGE=required',
    'PROJECT_RUNNER_PRIMARY=claude', 'PROJECT_RUNNER_FAILOVER=deepseek',
    'MODEL_DEFAULT_DEEPSEEK_FAMILY=default', '',
  ].join('\n'));

  const { stdout, stderr } = await f.run(`
    export FACTORY_PROFILES_DIR="$1"
    PROFILE_NAME=fixture
    source "$FACTORY_HOME/lib/profile-preflight.sh"
    flog() { printf '%s\\n' "$*" >>"$PWD/flog"; }
    profile_runner_host_preflight fixture || exit 61
    host="$STATE_DIR/coverage/fixture/host.env"
    [[ "$(coverage_artifact_get "$host" RUNTIME_VERSION_deepseek)" == "$3" ]] || exit 62
    [[ -z "$(coverage_artifact_get "$host" RUNTIME_VERSION_claude)" ]] || exit 63
    _multi_require_coverage 1 BUILD "$2" claude deepseek || exit 64
    [[ ! -e flog ]] || exit 65
    ln -sfn builds/B "$4/current"
    _multi_require_coverage 1 BUILD "$2" claude deepseek || exit 66
    [[ "$(coverage_artifact_get "$host" RUNTIME_VERSION_deepseek)" == "$5" ]] || exit 67
    grep -q 'сменилась сборка' flog || exit 68
    ln -sfn builds/missing "$4/current"
    _multi_require_coverage 1 BUILD "$2" claude deepseek || exit 69
    [[ "$(coverage_artifact_get "$host" PROVIDER_deepseek)" == unavailable ]] || exit 70
    [[ "$(coverage_artifact_get "$host" PROVIDER_claude)" == ready ]] || exit 71
    _multi_require_coverage 1 BUILD "$2" deepseek '' && exit 72
    runner_transition_allowed preflight runtime_changed auto 0 && exit 73
    printf 'refreshed-then-blocked\\n'
  `, [profiles, config, f.a.runnerVersion, f.runtimeRoot, f.b.runnerVersion], {
    PATH: `${bin}:${process.env.PATH}`,
  });

  assert.equal(stdout.trim(), 'refreshed-then-blocked');
  assert.doesNotMatch(stderr, /FACTORY_ERROR=runtime_changed/);
});

test('отказ каталога без смены сборки сохраняет invalid_config и route_unavailable', async (t) => {
  const f = await fixture(t);
  const config = path.join(f.root, 'runners.env');

  const { stdout, stderr } = await f.run(`
    source "$FACTORY_HOME/lib/multi-runner.sh"
    runner_registry_add deepseek "$FACTORY_HOME/lib/runners/deepseek.sh"
    config_file=$1
    multi_runner_config_file() { printf '%s\\n' "$config_file"; }
    MULTI_STAGE=BUILD
    MULTI_CATALOG_ROOT="$PWD/catalog"
    mkdir "$MULTI_CATALOG_ROOT"
    declare -A MULTI_PROBE_READY=() MULTI_PROBE_VERSION=() MULTI_PLAN_LEVEL=() MULTI_PLAN_DEGRADED=()
    printf 'MODEL_DEFAULT_DEEPSEEK_EXACT=["deepseek-official","missing"]\\n' >"$config_file"
    _multi_resolve deepseek && exit 81
    printf '%s\\n' "$DISPATCH_RESOLVE_RESULT"
    printf 'MODEL_DEFAULT_DEEPSEEK_FAMILY=default\\n' >"$config_file"
    _multi_resolve deepseek || exit 82
    printf 'MODEL_DEFAULT_DEEPSEEK_EXACT=["deepseek-official","missing"]\\n' >"$config_file"
    _multi_resolve deepseek && exit 83
    printf '%s\\n' "$DISPATCH_RESOLVE_RESULT"
    printf 'MODEL_DEFAULT_DEEPSEEK_FAMILY=missing\\n' >"$config_file"
    _multi_resolve deepseek && exit 84
    printf '%s\\n' "$DISPATCH_RESOLVE_RESULT"
  `, [config]);

  assert.deepEqual(stdout.trim().split('\n'), ['invalid_config', 'invalid_config', 'route_unavailable']);
  assert.doesNotMatch(stderr, /runtime_changed/);
});

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
