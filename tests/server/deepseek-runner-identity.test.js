import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { writeDeepSeekArtifactFixture } from '../helpers/deepSeekArtifactFixture.mts';
import { routeFailure } from '../../server/src/lib/factoryRouteCli.ts';

const exec = promisify(execFile);
// Корень репозитория не зависит от cwd: `npm test` запускает набор из server/.
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Fixture запускает настоящий runner, parser и dispatcher в изолированном состоянии.
 * Малые manifests запрещают prompt, а смена current производится только внутри fixture.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-runner-builds-'));
  const runtimeRoot = path.join(root, 'runtime');
  const a = await writeDeepSeekArtifactFixture(path.join(runtimeRoot, 'builds/A'), 'A');
  const b = await writeDeepSeekArtifactFixture(path.join(runtimeRoot, 'builds/B'), 'B');

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
    GRIGDESK_DEEPSEEK_RUNTIME_MODE: 'embedded',
    GRIGDESK_DEEPSEEK_GENERATION_ROOT: runtimeRoot,
  };

  return {
    root,
    runtimeRoot,
    a,
    b,
    run: (script, args = [], extra = {}) => exec('bash', ['-c', script, 'fixture', ...args], {
      env: { ...env, ...extra },
      cwd: root,
      timeout: 30_000,
    }),
  };
}

test('embedded probe/catalog/version parser сохраняют build suffix и exact min/max', async (t) => {
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
  `, [f.a.runtimeVersion, f.b.runtimeVersion]);

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
  `, [config, f.a.runtimeVersion, f.runtimeRoot]);

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
    _multi_require_coverage 1 BUILD "$2" || exit 64
    [[ ! -e flog ]] || exit 65
    ln -sfn builds/B "$4/current"
    _multi_require_coverage 1 BUILD "$2" || exit 66
    [[ "$(coverage_artifact_get "$host" RUNTIME_VERSION_deepseek)" == "$5" ]] || exit 67
    grep -q 'сменилась сборка' flog || exit 68
    ln -sfn builds/missing "$4/current"
    _multi_require_coverage 1 BUILD "$2" && exit 69
    runner_transition_allowed preflight runtime_changed auto 0 && exit 70
    printf 'refreshed-then-blocked\\n'
  `, [profiles, config, f.a.runtimeVersion, f.runtimeRoot, f.b.runtimeVersion], {
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

test('смена current после preflight запрещает spawn; missing embedded не ищет PATH dsh', async (t) => {
  const f = await fixture(t);

  await f.run(`
    source "$FACTORY_HOME/lib/runners/deepseek.sh"
    export FACTORY_RUNNER_VERSION="$1" FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write
    ln -sfn builds/B "$2/current"
    factory_exec() {
      [[ "$1" != provider ]] || { touch launched; return 0; }
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
  `, [f.a.runtimeVersion, f.runtimeRoot]);
});
