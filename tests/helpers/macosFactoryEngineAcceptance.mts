import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { executableIdentity } from '../../server/src/lib/providerInstall/executableIdentity.ts';
import { inspectDarwinSession } from '../../server/src/lib/factoryDarwinSessions.ts';
import { readDarwinProcessIdentity, type DarwinProcessIdentity } from '../../shared/node/processIdentity.ts';
import { decodeStageRunnerOptions } from '../../shared/pipeline/stageRunnerSettings.ts';
import { awaitAcceptance, type platformFixture } from './platformReleaseAcceptance.mts';
import { installLaunchFsyncFault } from './macosFactoryLaunchFault.mts';
import { withRuntimePinFault, type macosRuntimePinFixture } from './macosRuntimePinFixture.mts';

const execute = promisify(execFile);

type Fixture = Awaited<ReturnType<typeof macosRuntimePinFixture>>;
type Installed = Awaited<ReturnType<typeof platformFixture>>;

interface ReaderEntry {
  mode: string;
  child: { pid: number } | null;
  sessionId: number;
}

/**
 * Убирает ровно один физический executable только на одноразовом verify runner.
 * При восстановлении сверяет inode и не подменяет неожиданно появившийся файл.
 */
async function withMissingFlock<T>(run: () => Promise<T>): Promise<T> {
  assert.equal(process.env.GRIGDESK_ACCEPTANCE_DISPOSABLE_MAC, '1',
    'mac_engine_tool_fault_requires_hosted_verify');

  const target = await fs.realpath('/opt/homebrew/opt/flock/bin/flock');

  assert.match(target, /^\/opt\/homebrew\/Cellar\/flock\/[\w.+-]+\/bin\/flock$/u);

  const before = await fs.lstat(target, { bigint: true });

  assert.ok(before.isFile() && before.uid === BigInt(process.getuid!()) && before.nlink === 1n);

  const directory = await fs.mkdtemp(path.join(path.dirname(target), '.grigdesk-flock-'));
  const parked = path.join(directory, 'flock');

  try {
    await fs.rename(target, parked);

    try {
      return await run();
    } finally {
      const retained = await fs.lstat(parked, { bigint: true });

      assert.equal(retained.dev, before.dev);
      assert.equal(retained.ino, before.ino);
      await fs.link(parked, target);
      await fs.unlink(parked);
    }
  } finally {
    await fs.rmdir(directory);
  }
}

/**
 * Проверяет один и тот же typed error после короткого и detached preflight.
 * Ответ содержит только закрытое имя недоступного инструмента.
 */
function assertFlockRefusal(result: { status: number; body: Record<string, unknown> }, status = 409) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error, 'macos_engine_dependency_missing');
  assert.equal(result.body.tool, 'flock');
  assert.doesNotMatch(JSON.stringify(result.body), /\/opt\/homebrew\//u);
}

/**
 * Короткий engine check завершает свои проверки с доступным flock. Утилита
 * пропадает между его ответом и подготовкой первого detached запуска той же задачи.
 */
async function verifyDetachedToolRefusal(box: Installed, fixture: Fixture,
  launchUrl: string, input: Record<string, unknown>) {
  const directory = path.dirname(fixture.workspace);
  const reached = path.join(directory, 'launch-check-complete');
  const release = path.join(directory, 'launch-check-release');
  const boundary = '  printf \'\\n\'\n  exit 0\nfi\n\nif [[ "$MODE" == start';

  assert.match(directory, /^\/[\w./-]+$/u);

  await withRuntimePinFault(fixture.runtime.engineBin, (source) => {
    assert.ok(source.includes(boundary));

    const beforeReturn = [
      '  if [[ -z "$TASK$EXPECTED_ATTEMPT" && "$ROUTE" == debug ]]; then',
      `    : > '${reached}' || exit 78`,
      `    while [[ ! -e '${release}' ]] && (( SECONDS < 20 )); do /bin/sleep 0.1; done`,
      `    [[ -e '${release}' ]] || exit 78`,
      '  fi',
      '',
    ].join('\n');

    return source.replace(boundary, () => beforeReturn + boundary);
  }, async () => {
    const operation = box.api(launchUrl, input, 60_000)
      .then((result) => ({ result }), (error: unknown) => ({ error }));

    try {
      await awaitAcceptance(async () => Boolean(await fs.lstat(reached)) || null,
        'mac_engine_short_check_barrier_missing', 15_000);

      await withMissingFlock(async () => {
        await fs.writeFile(release, '', { flag: 'wx', mode: 0o600 });

        const observed = await operation;

        if ('error' in observed) {
          throw observed.error;
        }

        assertFlockRefusal(observed.result, 500);
      });
    } finally {
      await fs.writeFile(release, '', { mode: 0o600 });
      await operation;
    }
  });
}

/**
 * Использует progress и result из установленного runtime. Они читают один и
 * тот же FD, проверяют полномочия запуска и отклоняют позднюю запись.
 */
export async function verifyPackagedEngineStatusChannel(fixture: Fixture) {
  const { task, stateRoot } = fixture.identity;
  const stage = 'INSTRUMENT';
  const token = path.join(path.dirname(fixture.workspace), 'engine-status-token');
  const projection = path.join(stateRoot, `t${task}.pipeline`);

  await fs.writeFile(token, 'acceptance-status\n', { flag: 'wx', mode: 0o600 });

  const { stdout } = await execute(fixture.env.FACTORY_DARWIN_BASH!, ['-euc', `
    source "$FACTORY_HOME/lib/run-state.sh"
    task=$1 stage=$2
    IFS= read -r capability <"$3"
    run_state_begin "$task" "$stage" release-native 1 "$capability"
    unset capability
    export FACTORY_STATUS_FD=7
    exec 7<"$3"
    args=(--task "$task" --stage "$stage" --run-id release-native --epoch 1)
    progress="$FACTORY_HOME/lib/stage-progress.sh"
    result="$FACTORY_HOME/lib/stage-result.sh"

    "$BASH" "$progress" "\${args[@]}" SIZE M 7</dev/null && exit 10
    [[ $? == 74 ]]
    "$BASH" "$progress" "\${args[@]}" SIZE M
    [[ "$(pipeline_store_get "$task" SIZE)" == M ]]
    "$BASH" "$result" "\${args[@]}" done 'packaged status FD'
    [[ "$(pipeline_store_get "$task" "$stage")" == done ]]
    "$BASH" "$progress" "\${args[@]}" SIZE L && exit 11
    [[ $? == 75 ]]
    IFS= read -r untouched <&7
    [[ "$untouched" == acceptance-status ]]
    printf '%s\\n' 'native-status-complete'
  `, '--', task, stage, token], {
    cwd: fixture.workspace,
    env: fixture.env,
    timeout: 30_000,
  });

  assert.equal(stdout.trim().split('\n').at(-1), 'native-status-complete');
  assert.match(await fs.readFile(projection, 'utf8'), /^INSTRUMENT=done$/mu);
  assert.match(await fs.readFile(projection, 'utf8'), /^SIZE=M$/mu);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Bundled engine запускает абсолютный fixture CLI под штатным helper reader.
 * Подмена executable отпечатывается в descriptor и не запускает новую копию.
 */
export async function verifyPackagedEngineExternalLease(fixture: Fixture) {
  const directory = path.dirname(fixture.workspace);
  const executable = path.join(directory, 'fixture tool');
  const descriptor = path.join(directory, 'external-cli.json');
  const leaseDirectory = path.join(directory, 'leases');
  const providerId = 'codex';
  const records = path.join(leaseDirectory, sha256(providerId), 'records.json');
  const marker = path.join(directory, 'external-cli.pid');
  const release = path.join(directory, 'external-cli.release');
  const helper = path.join(fixture.runtime.runtimeRoot, 'server/runtime/helpers/external-cli-lease.mjs');

  await fs.writeFile(executable, [
    '#!/bin/bash',
    'set -eu',
    'printf "%s\\n" "$$" >"$1"',
    'while [[ ! -f "$2" ]] && (( SECONDS < 45 )); do /bin/sleep 0.1; done',
    '[[ -f "$2" ]]',
    'printf "%s\\n" "fixture-external-complete"',
    '',
  ].join('\n'), { flag: 'wx', mode: 0o700 });
  await fs.writeFile(descriptor, JSON.stringify({
    schemaVersion: 1,
    unavailable: {},
    providers: {
      [providerId]: {
        bin: executable,
        identity: await executableIdentity(executable),
        providerId,
        resourceKey: sha256(executable),
        leaseDirectory,
        leaseCommand: [fixture.runtime.node, helper],
        env: { PATH: '/usr/bin:/bin' },
      },
    },
  }), { flag: 'wx', mode: 0o600 });

  const run = () => execute(fixture.env.FACTORY_DARWIN_BASH!, ['-euc', `
    source "$FACTORY_HOME/lib/executor.sh"
    factory_external_exec codex /dev/null "$1" "$2"
  `, '--', marker, release], {
    cwd: fixture.workspace,
    env: { ...fixture.env, FACTORY_EXTERNAL_CLI_DESCRIPTOR: descriptor },
    timeout: 55_000,
  });
  const execution = run().then((result) => ({ result }), (error: unknown) => ({ error }));

  try {
    const pid = await awaitAcceptance(async () => Number((await fs.readFile(marker, 'utf8')).trim()) || null,
      'mac_engine_external_pid_missing', 15_000);
    const current = JSON.parse(await fs.readFile(records, 'utf8'));

    assert.equal(current.length, 1);
    assert.equal(current[0].mode, 'reader');
    assert.equal(current[0].phase, 'active');
    assert.equal(current[0].child.pid, pid);
    assert.equal(current[0].sessionId, pid);
  } finally {
    await fs.writeFile(release, '', { flag: 'wx', mode: 0o600 });

    const exited = await execution;

    if ('error' in exited) {
      throw exited.error;
    }

    assert.equal(exited.result.stdout.trim(), 'fixture-external-complete');
  }

  assert.deepEqual(JSON.parse(await fs.readFile(records, 'utf8')), []);
  await fs.unlink(marker);
  await fs.appendFile(executable, '# identity changed\n');
  await assert.rejects(run(), /GrigDesk: installation_changed/u);
  await assert.rejects(fs.lstat(marker), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(records, 'utf8')), []);
}

/**
 * Готовый runtime usage читает удержанные writer/reader и имя в dirfd.
 * Прежний inode остаётся открытым и после удаления или замены имени.
 */
export async function verifyPackagedEngineUsage(fixture: Fixture) {
  const directory = path.join(path.dirname(fixture.workspace), 'usage-run');
  const eventPath = path.join(directory, 'events.jsonl');
  const output = path.join(directory, 'prepared.json');
  const context = path.join(directory, 'context.json');
  const usageDirectory = path.join(directory, 'usage');
  const script = path.join(fixture.runtime.engineHome, 'lib/runtime-usage.mjs');
  const runId = 'fixture-run';
  const { task, attempt } = fixture.identity;
  const suffix = '0'.repeat(32);
  const model = 'gpt-5.4-sol';

  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(eventPath, [
    '{"type":"thread.started","thread_id":"fixture-thread"}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":60,'
      + '"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":3}}',
    '',
  ].join('\n'), { mode: 0o600 });

  const writer = await fs.open(eventPath, 'r+');
  const reader = await fs.open(eventPath, 'r');
  const dir = await fs.open(directory, 'r');

  try {
    const fileStat = await reader.stat({ bigint: true });
    const dirStat = await dir.stat({ bigint: true });
    const retained = ({ dev, ino }: { dev: bigint; ino: bigint }) => ({ dev: String(dev), ino: String(ino) });
    const current = await readDarwinProcessIdentity(process.pid);

    assert.equal(current.state, 'alive');
    await fs.writeFile(context, JSON.stringify({
      identity: {
        taskId: `t${task}`,
        attemptId: attempt,
        nodeVisitId: `nv_${suffix}`,
        nodeExecutionId: `ne_${suffix}`,
        dispatchId: `d_${suffix}`,
        runId,
        epoch: '1',
      },
      process: {
        pid: current.identity.pid,
        processGroupId: current.identity.pgid,
        sessionId: current.identity.sid,
        startTimeTicks: current.identity.starttime,
      },
      provider: 'codex',
      dialect: 'codex-jsonl-v1',
      resolvedModel: model,
      requestedModel: model,
      runKey: 'INSTRUMENT',
      providerSessionMode: 'fresh',
      requestedProviderScope: null,
      parentUsageRef: null,
      startedAt: '2026-08-19T10:00:00.000Z',
      quiescedAt: '2026-08-19T10:05:00.000Z',
      processComplete: true,
      runnerStartedEventHash: 'a'.repeat(64),
      usageDirectory,
      runDirectoryPath: directory,
      runDirectoryIdentity: retained(dirStat),
      eventsIdentity: retained(fileStat),
      statusMode: 'fd',
      runReason: 'fixture',
      runnerVersion: '0.166.0',
      rc: 0,
    }), { flag: 'wx', mode: 0o600 });

    const run = (command: string, ...args: string[]) => spawnSync(fixture.runtime.node,
      [script, command, context, ...args], {
        cwd: directory,
        env: fixture.env,
        encoding: 'utf8',
        stdio: [
          'ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', reader.fd, writer.fd, dir.fd,
        ],
        timeout: 20_000,
      });
    const initial = run('meta', 'initial');

    assert.equal(initial.status, 0, initial.stderr);
    assert.match(await fs.readFile(path.join(directory, 'meta.env'), 'utf8'), /^RUN_ID=fixture-run$/mu);

    const prepared = run('prepare');

    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(JSON.parse(prepared.stdout).normalization.completeness, 'complete');
    await fs.writeFile(output, prepared.stdout, { flag: 'wx', mode: 0o600 });

    const published = run('publish', output);

    assert.equal(published.status, 0, published.stderr);
    assert.equal(JSON.parse(published.stdout).tokenSummary.uncachedInput, '40');

    const final = run('meta', 'final', output, 'ok');

    assert.equal(final.status, 0, final.stderr);
    assert.match(await fs.readFile(path.join(directory, 'meta.env'), 'utf8'), /^USAGE_COMPLETE=1$/mu);

    const document = path.join(usageDirectory, `${runId}.json`);
    const documentBytes = await fs.readFile(document);

    await fs.rename(eventPath, `${eventPath}.retained`);

    const missing = run('prepare');

    assert.equal(missing.status, 78);
    assert.match(missing.stderr, /\[FACTORY_ERROR=eventsPathMissing\]/u);
    await fs.writeFile(eventPath, 'replacement stays unchanged\n', { flag: 'wx', mode: 0o600 });

    const replaced = run('prepare');

    assert.equal(replaced.status, 78);
    assert.match(replaced.stderr, /\[FACTORY_ERROR=eventsIdentityMismatch\]/u);
    assert.equal(replaced.stdout, '');
    assert.equal(await fs.readFile(eventPath, 'utf8'), 'replacement stays unchanged\n');
    assert.deepEqual(await fs.readFile(document), documentBytes);
  } finally {
    await Promise.all([dir.close(), reader.close(), writer.close()]);
  }
}

/**
 * Создаёт подготовленный worktree для новой задачи. HTTP launch и Stop сами
 * ведут попытку, scope изменений, процесс и поколение runtime.
 */
export async function verifyPackagedHttpEngineStop(box: Installed, fixture: Fixture) {
  const task = '77';
  const baseline = 'baseline from fixture\n';
  const { repository, workspace } = fixture;
  const file = path.join(workspace, 'scope.txt');
  const status = path.join(fixture.identity.stateRoot, `t${task}.pipeline`);
  const fixtureRoot = path.dirname(workspace);
  const configRoot = path.join(fixtureRoot, 'config');
  const codex = path.join(fixtureRoot, 'codex');
  const claude = path.join(fixtureRoot, 'claude');
  const finish = path.join(fixtureRoot, 'finish-stage');
  const stand = path.join(fixtureRoot, 'stand-ready');
  const modelHome = path.join(box.env.HOME!, '.codex');

  assert.match(fixtureRoot, /^\/[\w./-]+$/u);
  assert.match(file, /^\/[\w./-]+$/u);

  const git = (...args: string[]) => execute('/usr/bin/git', args, {
    cwd: repository,
    env: box.env,
    timeout: 30_000,
  });

  await git('init', '--quiet', '--initial-branch=base', '--template=');
  await fs.writeFile(path.join(repository, 'scope.txt'), baseline, { flag: 'wx', mode: 0o600 });
  await git('add', 'scope.txt');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'baseline');
  await fs.rmdir(workspace);
  await git('worktree', 'add', '--quiet', '-b', 'fixture', workspace);

  const { stdout: indexPath } = await git('-C', workspace,
    'rev-parse', '--path-format=absolute', '--git-path', 'index');
  const baselineIndex = await fs.readFile(indexPath.trim());

  await fs.writeFile(path.join(fixture.identity.stateRoot, `t${task}.env`), [
    `TASK=${task}`, 'SB_K=0', 'FE_PORT=', 'API_PORT=', 'WORKSPACE_MODE=isolated', 'STAND_OWNERSHIP=task',
    'SOURCE_BRANCH=fixture', 'REPO_COUNT=1', 'REPO_0_NAME=fixture', `REPO_0_SOURCE=${repository}`,
    `REPO_0_WT=${workspace}`, 'REPO_0_BRANCH=fixture', '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  await fs.mkdir(modelHome, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(modelHome, 'models_cache.json'), JSON.stringify({
    models: [{
      slug: 'gpt-5.4-sol',
      visibility: 'list',
      priority: 1,
    }],
  }), { flag: 'wx', mode: 0o600 });

  const profile = path.join(fixture.identity.profileRoot, fixture.identity.profile);

  await fs.appendFile(path.join(profile, 'runners.env'), 'PROJECT_RUNNER_FAILOVER=claude\n');
  await fs.appendFile(path.join(profile, 'profile.sh'), [
    'profile_stand_alive() {',
    `  if [[ "\${1:-}" == '${task}' ]]; then printf '%s\\n' "$1" > '${stand}'; fi`,
    '  return 0',
    '}',
    '',
  ].join('\n'));

  for (const binary of [codex, claude]) {
    const version = binary === codex ? 'codex-cli 0.166.0' : '2.1.80 (Claude Code)';
    const invocation = binary === codex ? 'exec' : '-p';

    await fs.writeFile(binary, [
      '#!/bin/bash',
      'set -eu',
      `if [[ "\${1:-}" == --version ]]; then printf '%s\\n' '${version}'; exit 0; fi`,
      `[[ "\${1:-}" == '${invocation}' && "\${FACTORY_RUN_STAGE:-}" == INSTRUMENT ]] || exit 4`,
      ...(binary === codex ? ['/bin/cat >/dev/null'] : []),
      'args=(--task "$FACTORY_RUN_TASK" --stage "$FACTORY_RUN_STAGE"',
      '      --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH")',
      '"$FACTORY_DARWIN_BASH" "$FACTORY_HOME/lib/stage-progress.sh" "${args[@]}" SIZE M',
      `printf 'write from fixture tool\\n' > '${file}'`,
      `printf '%s\\n' "$$" > '${binary}.started'`,
      `while [[ ! -f '${finish}' ]] && (( SECONDS < 120 )); do /bin/sleep 0.1; done`,
      `[[ -f '${finish}' ]] || exit 4`,
      '"$FACTORY_DARWIN_BASH" "$FACTORY_HOME/lib/stage-progress.sh" "${args[@]}" SIZE L',
      '"$FACTORY_DARWIN_BASH" "$FACTORY_HOME/lib/stage-result.sh" "${args[@]}" done "fixture result"',
      '',
    ].join('\n'), { flag: 'wx', mode: 0o700 });
  }

  await fs.mkdir(configRoot, { mode: 0o700 });
  await fs.appendFile(path.join(box.dataHome, '.env'), [
    '',
    `GRIGDESK_CODEX_BIN=${codex}`,
    `GRIGDESK_CLAUDE_BIN=${claude}`,
    `FACTORY_CONFIG_ROOT=${configRoot}`,
    '',
  ].join('\n'));
  await box.ctl(['server', 'start', '--wait']);

  const catalogUrl = `/api/routes/${fixture.identity.profile}`;
  const currentCatalog = await box.api(`${catalogUrl}/current`);

  assert.equal(currentCatalog.status, 200, JSON.stringify(currentCatalog.body));

  const catalogHash = currentCatalog.body.catalogHash;
  const publishedCatalog = await box.api(`${catalogUrl}/catalog/${catalogHash}`);

  assert.equal(publishedCatalog.status, 200, JSON.stringify(publishedCatalog.body));

  const { catalog, bootstrap, prompts } = publishedCatalog.body;
  const replay = await box.api(`${catalogUrl}/catalog`, {
    catalog,
    bootstrap,
    prompts,
    expectedCatalogHash: catalogHash,
  });

  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.catalogHash, catalogHash);
  assert.equal(replay.body.currentChanged, false);

  const owner = (await box.api('/api/system/runtime-identity')).body;
  let provider: DarwinProcessIdentity | undefined;
  let attempt = '';

  /**
   * Считывает PID после записи точным executable. Проверка SID исключает
   * дочернюю команду старого запуска и применяется до проверки reader lease.
   */
  async function currentProvider(binary = codex) {
    const marker = await fs.readFile(`${binary}.started`, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') {
        return '';
      }

      throw error;
    });
    const pid = Number(marker.trim());

    if (!pid) {
      return null;
    }

    const observed = await readDarwinProcessIdentity(pid);

    return observed.state === 'alive' && observed.identity.sid === pid ? observed.identity : null;
  }

  try {
    const launchUrl = `/api/tasks/${task}/launch`;
    const input = {
      profile: fixture.identity.profile,
      route: 'debug',
      title: 'Проверочный запуск установленного движка',
      description: 'Внешняя CLI изменяет ровно один файл и ждёт Stop.',
      sourceUrl: 'https://fixture.invalid/task/77',
      instrumentationFiles: ['fixture:scope.txt'],
      diagnosisKind: 'performance',
      diagnosisSignal: 'Проверка штатной остановки.',
    };

    await withMissingFlock(async () => {
      assertFlockRefusal(await box.api(launchUrl, input, 30_000));
      await assert.rejects(fs.lstat(status), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(`${codex}.started`), { code: 'ENOENT' });
    });

    await verifyDetachedToolRefusal(box, fixture, launchUrl, input);
    await assert.rejects(fs.lstat(status), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(`${codex}.started`), { code: 'ENOENT' });

    const witness = path.join(fixtureRoot, 'launch-fsync.json');
    const engineStarted = path.join(fixtureRoot, 'launch-engine-started');
    const anchor = 'set -uo pipefail\n';

    await withRuntimePinFault(fixture.runtime.engineBin, (source) => {
      assert.ok(source.includes(anchor));

      return source.replace(anchor, () => anchor
        + `if [[ "\${1:-}" == '${task}' && "\${2:-}" == start ]]; then : > '${engineStarted}'; fi\n`);
    }, async () => {
      await installLaunchFsyncFault(box, fixture.identity.controlRoot, fixture.runtime.node, task, witness);

      const denied = await box.api(launchUrl, input, 60_000);

      assert.equal(denied.status, 500, JSON.stringify(denied.body));
      assert.equal(denied.body.outcome, 'invalid');
      assert.match(denied.body.message, /до выдачи разрешения/u);
    });

    const failed = JSON.parse(await fs.readFile(witness, 'utf8'));

    assert.equal(failed.task, task);
    assert.equal(failed.phase, 'registered');
    assert.equal(failed.owner.pid, owner.pid);
    assert.match(failed.launchId, /^[a-f0-9-]{36}$/u);
    assert.equal((await inspectDarwinSession(failed.process, undefined, [], true)).state, 'dead');
    await assert.rejects(fs.lstat(engineStarted), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(status), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(fixture.identity.controlRoot,
      'launch-processes', `t${task}.${failed.launchId}.json`)), { code: 'ENOENT' });
    assert.equal((await box.api('/api/system/runtime-identity')).body.instanceId, owner.instanceId);

    const launch = await box.api(launchUrl, input, 60_000);

    assert.equal(launch.status, 200, JSON.stringify(launch.body));
    assert.equal(launch.body.outcome, 'launched');
    assert.match(launch.body.attempt, /^a_[a-f0-9]{32}$/u);
    attempt = launch.body.attempt;

    const first = await awaitAcceptance(currentProvider, 'mac_engine_http_provider_not_started', 35_000);
    const fileName = path.join(box.dataHome, 'provider-cli-leases', sha256('codex'), 'records.json');
    const readers: ReaderEntry[] = JSON.parse(await fs.readFile(fileName, 'utf8'));

    provider = first;
    assert.ok(readers.some(({ mode, child, sessionId }) => mode === 'reader'
      && child?.pid === first.pid && sessionId === first.sid));
    assert.equal(await fs.readFile(file, 'utf8'), 'write from fixture tool\n');
    await awaitAcceptance(async () => /^SIZE=M$/mu.test(await fs.readFile(status, 'utf8')) || null,
      'mac_engine_http_progress_missing', 10_000);

    const settings = `/api/tasks/${task}/runner/settings`;
    const query = new URLSearchParams({
      profile: fixture.identity.profile,
      attempt: launch.body.attempt,
      node: 'instrument',
      stage: 'INSTRUMENT',
    });
    const optionsUrl = `/api/tasks/${task}/runner/options?${query}`;
    const optionsResponse = await box.api(optionsUrl, undefined, 30_000);

    assert.equal(optionsResponse.status, 200, JSON.stringify(optionsResponse.body));

    const options = decodeStageRunnerOptions(optionsResponse.body);

    assert.ok(options.actual);
    assert.equal(options.actual.provider, 'codex');

    const expectedRun = options.actual.run;
    const request = {
      identity: options.identity,
      expectedRevision: options.revision,
      expectedRun,
      catalogRevision: options.catalogRevision,
      requestId: randomUUID(),
      mode: 'restart',
      selection: options.selection,
    };
    const restart = await box.api(settings, request, 35_000);

    assert.equal(restart.status, 200, JSON.stringify(restart.body));

    const restarted = await awaitAcceptance(async () => {
      const child = await currentProvider();

      if (!child || child.pid === first.pid) {
        return null;
      }

      const response = await box.api(optionsUrl, undefined, 4000);

      if (response.status !== 200) {
        return null;
      }

      const active = decodeStageRunnerOptions(response.body);

      return active.actual && active.actual.run.epoch > expectedRun.epoch ? { active, child } : null;
    }, 'mac_engine_restart_run_not_confirmed', 35_000);

    provider = restarted.child;
    assert.notEqual(restarted.active.actual?.run.id, expectedRun.id);
    assert.equal((await inspectDarwinSession(first, undefined, [], true)).state, 'dead');

    const stale = await box.api(settings, {
      ...request,
      expectedRevision: restarted.active.revision,
      catalogRevision: restarted.active.catalogRevision,
      requestId: randomUUID(),
    }, 20_000);

    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal((await currentProvider())?.starttime, provider.starttime);

    const switchUrl = `/api/tasks/${task}/runner/switch`;
    const selection = {
      stage: 'INSTRUMENT',
      target: 'claude',
    };

    await withMissingFlock(async () => {
      assertFlockRefusal(await box.api(switchUrl, selection, 30_000));
      assert.equal((await currentProvider())?.starttime, restarted.child.starttime);
      await assert.rejects(fs.lstat(`${claude}.started`), { code: 'ENOENT' });
    });

    const switched = await box.api(switchUrl, selection, 35_000);

    assert.equal(switched.status, 200, JSON.stringify(switched.body));

    const switchedProvider = await awaitAcceptance(() => currentProvider(claude),
      'mac_engine_switch_provider_not_started', 35_000);

    assert.equal((await inspectDarwinSession(restarted.child, undefined, [], true)).state, 'dead');
    provider = switchedProvider;

    const afterSwitch = await box.api(optionsUrl, undefined, 30_000);

    assert.equal(afterSwitch.status, 200, JSON.stringify(afterSwitch.body));

    const selected = decodeStageRunnerOptions(afterSwitch.body);

    assert.equal(selected.actual?.provider, 'claude');
    assert.ok(selected.actual && restarted.active.actual
      && selected.actual.run.epoch > restarted.active.actual.run.epoch);
  } finally {
    const stop = await box.api(`/api/tasks/${task}/stop`, {}, 55_000);

    if (stop.status === 409) {
      assert.equal(stop.body.error, 'release_task_cleanup_required');
    } else {
      assert.equal(stop.status, 200);
      assert.equal(stop.body.ok, true);
    }
  }

  assert.ok(provider);

  const liveProvider = provider;

  await awaitAcceptance(async () => {
    const proof = await inspectDarwinSession(liveProvider, undefined, [], true);

    return proof.state === 'dead' || null;
  }, 'mac_engine_http_session_not_drained', 15_000);

  const repeat = await box.api(`/api/tasks/${task}/stop`, {}, 55_000);

  assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
  assert.equal(repeat.body.ok, true);
  assert.equal(await fs.readFile(file, 'utf8'), baseline);
  assert.deepEqual(await fs.readFile(indexPath.trim()), baselineIndex);
  assert.equal((await box.api('/api/system/runtime-identity')).body.instanceId, owner.instanceId);

  await fs.unlink(stand);
  await Promise.all([fs.unlink(`${codex}.started`), fs.unlink(`${claude}.started`)]);

  try {
    const resumeUrl = `/api/tasks/${task}/resume`;
    const input = {
      profile: fixture.identity.profile,
      attempt,
    };

    await withMissingFlock(async () => {
      const projection = await fs.readFile(status);

      assertFlockRefusal(await box.api(resumeUrl, input, 30_000));
      assert.deepEqual(await fs.readFile(status), projection);
      await assert.rejects(fs.lstat(stand), { code: 'ENOENT' });
    });

    const resumed = await box.api(resumeUrl, input, 55_000);

    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.outcome, 'launched');
    assert.equal(resumed.body.attempt, attempt);

    const child = await awaitAcceptance(async () => await currentProvider() ?? await currentProvider(claude),
      'mac_engine_resume_provider_not_started', 35_000);

    assert.equal(await fs.readFile(stand, 'utf8'), `${task}\n`);
    await fs.writeFile(finish, '', { flag: 'wx', mode: 0o600 });
    await awaitAcceptance(async () => {
      const projection = await fs.readFile(status, 'utf8');
      const session = await inspectDarwinSession(child, undefined, [], true);

      return /^INSTRUMENT=done$/mu.test(projection) && /^SIZE=L$/mu.test(projection)
        && session.state === 'dead' || null;
    }, 'mac_engine_result_not_committed', 45_000);
  } finally {
    const stopped = await box.api(`/api/tasks/${task}/stop`, {}, 55_000);

    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.ok, true);
  }
}
