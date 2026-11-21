import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Writable } from 'node:stream';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

import { prepareDarwinFactoryEnvironment } from '../../server/src/lib/factoryDarwinRuntime.ts';
import { legacyRuntimeContext } from '../../server/src/lib/factoryLegacyRuntimeContext.ts';
import { readExistingFactoryRuntimePin } from '../../server/src/lib/factoryRuntimePins.ts';
import { factoryMobileIdentity } from '../../server/src/lib/mobile/factoryIdentity.ts';
import { RUNTIME_TOKEN } from '../../server/src/binary/leases.ts';
import { writeFactoryLedger } from './factoryLedgerFixture.mjs';
import { dataPath } from '../../shared/runtime/dataHome.ts';
import { assertRuntimePinDirectory } from '../../tools/ci/runtimePinEvidence.mts';
import type { platformFixture } from './platformReleaseAcceptance.mts';

const execute = promisify(execFile);
const checkout = path.resolve(import.meta.dirname, '../..');

type Installed = Awaited<ReturnType<typeof platformFixture>>;

/**
 * Извлекает подписанное поколение штатной командой серверного бинарника.
 * Бинарник A может подготовить свой runtime в D установленного сервера B.
 */
export async function prepareRuntime(box: Installed, binary: string) {
  const { stdout } = await execute(binary, ['--prepare', '--json'], {
    env: {
      ...box.env,
      GRIGDESK_HOME: box.dataHome,
    },
    timeout: 180_000,
  });
  const { packageId, preparationToken } = JSON.parse(stdout);

  assert.match(packageId, /^[a-f0-9]{64}$/u);
  assert.match(preparationToken, RUNTIME_TOKEN);

  const runtimeRoot = path.join(dataPath(box.dataHome, 'serverRuntime'), 'packages', packageId);

  assert.equal(await fs.realpath(runtimeRoot), runtimeRoot);

  return {
    runtimeRoot,
    packageId: packageId as string,
    preparationToken: preparationToken as string,
  };
}

/**
 * Подставляет четыре приватных корня конвейера. Порты и остальные параметры
 * установленного сервера остаются результатом штатной установки.
 */
export async function configureDecisionApi(box: Installed, fixture: PinFixture) {
  const envFile = path.join(box.dataHome, '.env');
  const baseEnvironment = (await fs.readFile(envFile, 'utf8')).split('\n')
    .filter((line) => !/^(FACTORY_(CONTROL_ROOT|STATE_DIR|PROFILES_DIR)|GRIGDESK_ROUTES_DIR)=/u.test(line));

  await fs.writeFile(envFile, [...baseEnvironment,
    `FACTORY_CONTROL_ROOT=${fixture.identity.controlRoot}`,
    `FACTORY_STATE_DIR=${fixture.identity.stateRoot}`,
    `FACTORY_PROFILES_DIR=${fixture.identity.profileRoot}`,
    `GRIGDESK_ROUTES_DIR=${fixture.routes}`,
    '',
  ].join('\n'));
}

/**
 * Seeds a real stopped bootstrap on the selected engine without running an agent.
 * All events and active pointers are produced by the ordinary engine writers.
 */
export async function macosRuntimePinFixture(
  directory: string, runtimeRoot: string, packageId: string | null, mode: 'bootstrap' | 'gate' = 'bootstrap',
) {
  const controlRoot = path.join(directory, 'control');
  const stateRoot = path.join(directory, 'state');
  const profileRoot = path.join(directory, 'profiles');
  const routes = path.join(directory, 'routes');
  const task = '42';
  const profile = 'demo-profile';
  const cacheDir = packageId ? path.dirname(path.dirname(runtimeRoot)) : path.join(directory, 'node-runtime');
  const runtimeNode = packageId ? path.join(runtimeRoot, 'runtime/node/bin/node')
    : await fs.realpath(process.execPath);
  const helper = packageId ? path.join(runtimeRoot, 'server/runtime/helpers/factory-runtime-pin.mjs')
    : path.join(runtimeRoot, 'server/scripts/factoryRuntimePin.mts');
  const engineHome = path.join(runtimeRoot, 'engine');
  const engineBin = path.join(runtimeRoot, packageId ? 'engine/bin/factory' : 'bin/factory');
  const answer = path.join(directory, 'answer.txt');

  for (const folder of [controlRoot, stateRoot, profileRoot, routes]) {
    await fs.mkdir(folder, { mode: 0o700 });
  }

  const toolEnv = await prepareDarwinFactoryEnvironment({
    root: runtimeRoot,
    packaged: packageId !== null,
    controlRoot,
    node: runtimeNode,
  });
  const env: NodeJS.ProcessEnv = {
    ...toolEnv,
    HOME: directory,
    TMPDIR: directory,
    FACTORY_HOME: engineHome,
    FACTORY_PROFILES_DIR: profileRoot,
    FACTORY_STATE: stateRoot,
    FACTORY_ROUTE_STATE_DIR: stateRoot,
    STATE_DIR: stateRoot,
    ROUTES_DIR: routes,
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const publisher = path.join(checkout, 'tests/engine/fixtures/routes-publish.mjs');

  const published = JSON.parse((await execute(process.execPath,
    [publisher, routes, 'Bootstrap fixture', 'null'], { env })).stdout);

  await fs.writeFile(answer, 'Ответ для проверяемого визита.\n', { mode: 0o600 });

  const attempt = writeFactoryLedger(directory, 'begin', {
    task,
    profile,
    route: 'debug',
    skipStage: true,
  }) as string;
  const { visit, stopHash } = mode === 'bootstrap' ? writeFactoryLedger(directory, 'bootstrap-stop', {
    task,
    attempt,
    reason: 'Проверочная остановка.',
  }) as { visit: string; stopHash: string } : {};

  assert.match(attempt!, /^a_[a-f0-9]{32}$/u);

  if (mode === 'bootstrap') {
    assert.match(visit!, /^b_[a-f0-9]{32}$/u);
    assert.match(stopHash!, /^[a-f0-9]{64}$/u);
  }

  const orchestrators = path.join(controlRoot, 'protocol-v2/orchestrators');

  await fs.mkdir(orchestrators, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(orchestrators, `t${task}.lock`), '', { mode: 0o600, flag: 'wx' });

  const identity = {
    controlRoot,
    stateRoot,
    profileRoot,
    cacheDir,
    task,
    attempt: attempt!,
    profile,
  };
  const runtime = {
    packageId,
    runtimeRoot,
    engineHome,
    engineBin,
    node: runtimeNode,
  };
  const context = await legacyRuntimeContext(identity, runtime);
  const attemptRoot = path.join(controlRoot, 'protocol-v2/tasks', `t${task}`, 'attempts', attempt!);
  const journal = path.join(attemptRoot, 'bootstrap-results');
  const artifacts = path.join(attemptRoot, 'artifacts');
  const workspace = path.join(directory, 'workspace');
  const repository = path.join(directory, 'repository');

  await fs.mkdir(artifacts, { mode: 0o700, recursive: true });
  await fs.mkdir(workspace, { mode: 0o700 });
  await fs.mkdir(repository, { mode: 0o700 });
  await fs.writeFile(path.join(artifacts, 'profile-contract.tsv'), [
    'schema\t1', 'repos-mode\tgeneric', 'workspace-mode\tisolated', 'stand-mode\tnone',
    'stand-ownership\ttask', 'source-branch\tfixture', 'container\tfixture', 'service-host\t127.0.0.1',
    `repo\tfixture\t${repository}\t${workspace}\tfixture`, '',
  ].join('\n'), { mode: 0o400 });
  await fs.writeFile(path.join(artifacts, 'project-context.json'),
    '{"guardrails":[],"stack":["fixture"]}\n', { mode: 0o400 });
  await fs.writeFile(path.join(stateRoot, `t${task}.pipeline`), [
    `ATTEMPT_ID=${attempt}`, `PROFILE=${profile}`, 'ROUTE=debug', 'CATALOG_PROTOCOL=route-v2',
    `ROUTE_HASH=${published.routeHash}`, `CATALOG_HASH=${published.catalogHash}`, 'STALLED_HUMAN=1', '',
  ].join('\n'), { mode: 0o600 });

  const options = ['--profile', profile, '--attempt', attempt!, '--state-dir', stateRoot,
    '--control-dir', controlRoot, '--routes-dir', routes, '--require-host-runtime-context'];
  const writerEnv = {
    ...env,
    GRIGDESK_SERVER_RUNTIME_NODE: runtimeNode,
    GRIGDESK_SERVER_RUNTIME_PIN_HELPER: helper,
  };

  /**
   * Передаёт закрытый контекст настоящему writer или CLI выбранного поколения.
   * Отсутствующий FD и открытый FD без payload остаются отдельными входами.
   */
  async function runWithContext(executable: string, argv: string[], fd: string | undefined) {
    const child = spawn(executable, argv, {
      env: writerEnv,
      cwd: directory,
      stdio: fd === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(70_000),
    });
    const out: Buffer[] = [];
    const errors: Buffer[] = [];

    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => errors.push(chunk));

    if (fd !== undefined) {
      const channel = child.stdio[3] as Writable;

      channel.on('error', () => channel.destroy());
      channel.end(fd);
    }

    const [code, signal] = await once(child, 'close');

    return {
      code,
      signal,
      stdout: Buffer.concat(out).toString(),
      stderr: Buffer.concat(errors).toString(),
    };
  }

  /**
   * Вызывает штатный вход выбранного движка с теми же scope и точной попыткой.
   * В собранной поставке запуск обязательно проходит через lease wrapper.
   */
  function invokeFactory(mode: string, flags: string[], fd: string | undefined) {
    const args = [task, mode, ...options, ...flags];

    return packageId
      ? runWithContext(runtimeNode, [helper, 'run', '--cache-dir', cacheDir, '--package-id', packageId,
        '--engine', engineBin, '--', ...args], fd)
      : runWithContext(engineBin, args, fd);
  }

  return {
    context,
    identity,
    runtime,
    answer,
    journal,
    routes,
    env,
    workspace,
    repository,
    visitId: visit!,
    stopHash: stopHash!,
    invoke: (fd: string | undefined) => invokeFactory('bootstrap-answer', ['--node', 'scout',
      '--visit', visit!, '--stop-hash', stopHash!, '--answer-file', answer], fd),
    invokeFactory,
    commit: () => runWithContext(runtimeNode,
      [helper, 'commit-legacy', task, attempt!, profile, controlRoot], context),
    commitThrough: (script: string) => runWithContext(runtimeNode,
      [script, helper, 'commit-legacy', task, attempt!, profile, controlRoot], context),
  };
}

type PinFixture = Awaited<ReturnType<typeof macosRuntimePinFixture>>;
export type FdScenario = 'FD-VALID' | 'FD-MISSING' | 'FD-EOF' | 'FD-INVALID';

/**
 * Готовит точные ворота настоящим writer курсора в том же каталоге попытки.
 * Фикстура не запускает модель и не подменяет решение ворот.
 */
export async function seedRuntimePinGate(fixture: PinFixture, stop: 'gate' | 'human' = 'gate') {
  const { identity, journal, env, repository, workspace } = fixture;
  const profile = path.join(identity.profileRoot, identity.profile);
  const pipeline = path.join(identity.stateRoot, `t${identity.task}.pipeline`);

  assert.match(repository, /^\/[\w./-]+$/u);
  assert.match(workspace, /^\/[\w./-]+$/u);
  await fs.mkdir(profile, { mode: 0o700 });
  await fs.writeFile(path.join(profile, 'profile.sh'), [
    'profile_workspace_mode() { printf "isolated\\n"; }',
    'profile_stand_mode() { printf "none\\n"; }',
    `profile_repositories() { printf "fixture\\t%s\\t%s\\n" '${repository}' '${workspace}'; }`,
    'profile_source_branch() { printf "fixture\\n"; }',
    'profile_container() { printf "fixture\\n"; }',
    'profile_stand_alive() { return 0; }',
    'profile_project_context() { printf \'%s\\n\' \'{"guardrails":[],"stack":["fixture"]}\'; }',
    '',
  ].join('\n'), { mode: 0o600 });
  await fs.writeFile(path.join(profile, 'graph.json'), '{"capabilities":["route-v2"]}\n', { mode: 0o600 });
  await fs.writeFile(path.join(profile, 'runners.env'), [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'RUNNERS_COVERAGE=required',
    'PROJECT_RUNNER_PRIMARY=codex', '',
  ].join('\n'), { mode: 0o600 });

  const scope = { task: identity.task, attempt: identity.attempt };
  const location = env.HOME!;
  const verdict = {
    owner: 'tests',
    findings: [{
      id: 'fixture',
      severity: 'blocking',
      summary: 'Проверочная остановка арбитра.',
    }],
  };

  writeFactoryLedger(location, 'init', scope);
  writeFactoryLedger(location, 'commit', {
    ...scope,
    node: 'instrument',
    outcome: 'done',
  });

  const cursor = writeFactoryLedger(location, 'commit', {
    ...scope,
    node: 'check',
    outcome: stop === 'human' ? 'failed' : 'done',
    ...(stop === 'human' ? { verdict, failureOwner: verdict.owner } : {}),
  });

  const stopped = stop === 'gate' ? writeFactoryLedger(location, 'pause', {
    ...scope,
    reason: 'Проверочное решение',
  }) : cursor;

  if (stop === 'gate') {
    assert.equal(stopped.CurrentNode, 'gate_plan');
    assert.equal(stopped.State, 'paused');
  } else {
    assert.equal(stopped.State, 'stopped');
    assert.equal(stopped.Stop, 'human');
  }

  await fs.appendFile(pipeline, [
    'RUN_PROTOCOL=2', 'WF_STATUS=running', stop === 'gate' ? 'GATE_PLAN=waiting' : 'CHECK=failed',
    'DELIVERY_MODE=disabled', '',
  ].join('\n'));

  const expectedMobile = factoryMobileIdentity({
    profile: identity.profile,
    attempt: identity.attempt,
    cursor: {
      node: stopped.CurrentNode,
      state: stopped.State,
      stop: stopped.Stop || null,
    },
    stageIdentity: {
      sequence: stopped.Sequence,
      headEventHash: stopped.HeadEventHash,
    },
  }, {});

  assert.ok(expectedMobile);

  return {
    pipeline,
    stage: path.join(path.dirname(journal), 'stage-results'),
    expectedMobile,
  };
}

/**
 * Удерживает штатный flock с наблюдаемым барьером. Закрытие своего stdin
 * освобождает ровно один lock и подтверждает ненарушенный выход holder.
 */
export async function holdRuntimePinTaskLock(t: TestContext, fixture: PinFixture, file: string) {
  const child = spawn(fixture.env.FACTORY_DARWIN_BASH!, ['-euc', `
    exec 9<"$1"
    flock -n 9
    printf 'held\\n'
    IFS= read -r value || true
  `, '--', file], {
    env: fixture.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: AbortSignal.timeout(50_000),
  });
  const finished = once(child, 'close');
  const ready = once(child.stdout, 'data', { signal: AbortSignal.timeout(6000) });

  async function release() {
    if (!child.stdin.writableEnded) {
      child.stdin.end();
    }

    assert.deepEqual(await finished, [0, null]);
  }

  t.after(release);

  const [record] = await Promise.race([ready, finished.then(() => [])]);

  assert.equal(record?.toString(), 'held\n');

  return release;
}

/**
 * Воспроизводит durable границу поздней финализации штатным writer.
 * Без stalled TX отказ даёт поздняя проверка записи. С TX проверяется обязательный Stop.
 */
export async function seedRuntimePinStopRecord(fixture: PinFixture, stalled: boolean) {
  const { identity, env } = fixture;
  const finalization = path.join(identity.controlRoot, 'transaction-finalization');
  const file = path.join(finalization, `t${identity.task}.json`);
  const txid = `v2-${identity.attempt.slice(2)}-s1`;
  const receiptInput = stalled ? path.join(identity.controlRoot, 'transactions', `t${identity.task}`, txid)
    : await fs.mkdtemp(path.join(env.HOME!, 'stop-receipt-'));

  await fs.mkdir(receiptInput, { mode: 0o700, recursive: true });
  await fs.mkdir(finalization, { mode: 0o700, recursive: true });
  await fs.writeFile(path.join(receiptInput, 'baseline.tsv'), 'Проверочная база\n', { mode: 0o600 });
  await fs.writeFile(path.join(receiptInput, 'scope.list'), 'Проверочная область\n', { mode: 0o600 });

  const write = (phase: 'pending' | 'restored' | 'synced') => execute(env.FACTORY_DARWIN_BASH!, ['-euc', `
    source "$FACTORY_HOME/lib/runtime-analytics.sh"
    source "$FACTORY_HOME/lib/instrumentation-transaction.sh"
    if [[ "$5" == true && "$6" == pending ]]; then
      FACTORY_INSTRUMENTATION_ISOLATION=exclusive-worktree-v1 \
        _instrumentation_tx_write_state "$4" stalled 0 out_of_scope_change
      _instrumentation_tx_sync_state "$4"
    fi
    _instrumentation_tx_finalization_write "$1" "$2" "$3" "$4" "$6"
  `, '--', identity.task, identity.attempt, txid, receiptInput, String(stalled), phase],
  { env, timeout: 20_000 });

  await write('pending');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).phase, 'pending');

  return {
    file,
    state: stalled ? path.join(receiptInput, 'state.env') : null,
    finish: async () => {
      await write('restored');
      await write('synced');
    },
  };
}

/**
 * Сохраняет активную транзакцию без stop record на границе решения Gate.
 * Проверяемый state.env публикуется обычным writer состояния транзакции.
 */
export async function seedRuntimePinOpenTx(fixture: PinFixture) {
  const { identity, env } = fixture;
  const txid = `v2-${identity.attempt.slice(2)}-s1`;
  const root = path.join(identity.controlRoot, 'transactions', `t${identity.task}`);
  const directory = path.join(root, txid);

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, 'baseline.tsv'), 'Проверочная база\n', { mode: 0o600 });
  await execute(env.FACTORY_DARWIN_BASH!, ['-euc', `
    source "$FACTORY_HOME/lib/runtime-analytics.sh"
    source "$FACTORY_HOME/lib/instrumentation-transaction.sh"
    FACTORY_INSTRUMENTATION_ISOLATION=exclusive-worktree-v1 _instrumentation_tx_write_state "$1" active 0
    _instrumentation_tx_sync_state "$1"
  `, '--', directory], { env, timeout: 20_000 });
  await fs.writeFile(path.join(root, 'active.env'), `SCHEMA=1\nTRANSACTION_ID=${txid}\n`, { mode: 0o600 });

  return path.join(directory, 'state.env');
}

/**
 * Вносит отказ только в распакованный runtime приватной приёмки.
 * Архив кандидата не затрагивается. До штатного повтора возвращаются исходные байты и права.
 */
export async function withRuntimePinFault<T>(file: string, script: (original: string) => string,
  run: () => Promise<T>): Promise<T> {
  const directory = path.dirname(file);
  const parent = await fs.lstat(directory);
  const info = await fs.lstat(file);

  assert.equal(await fs.realpath(directory), directory);
  assert.ok(parent.isDirectory() && parent.uid === process.getuid!());
  assert.ok(info.isFile() && info.uid === parent.uid && info.nlink === 1);

  const before = await fs.readFile(file);
  const suffix = path.extname(file);
  const backup = path.join(directory, path.basename(file, suffix) + '.fault-original' + suffix);
  const directoryMode = parent.mode & 0o777;

  await assert.rejects(fs.lstat(backup), { code: 'ENOENT' });

  let moved = false;

  try {
    await fs.chmod(directory, directoryMode | 0o200);
    await fs.rename(file, backup);
    moved = true;
    await fs.writeFile(file, script(backup), { mode: info.mode & 0o777, flag: 'wx' });
    await fs.chmod(directory, directoryMode);

    return await run();
  } finally {
    try {
      if (moved) {
        await fs.chmod(directory, directoryMode | 0o200);
        await fs.rename(backup, file);
      }
    } finally {
      await fs.chmod(directory, directoryMode);
    }

    assert.deepEqual(await fs.readFile(file), before);
    assert.equal((await fs.stat(file)).mode, info.mode);
  }
}

/**
 * Открывает настоящий канал визита портом из выбранной поставки.
 * Обычный close завершает тот же сеанс и остаётся cleanup при падении теста.
 */
export async function openRuntimePinProfileChannel(t: TestContext, fixture: PinFixture) {
  const { identity, runtime, env } = fixture;
  const root = path.join(identity.profileRoot, identity.profile);
  const profile = path.join(root, 'profile.sh');
  const broker = path.join(root, 'broker.mjs');
  const close = path.join(root, 'close.mjs');
  const helper = env.FACTORY_DARWIN_PROCESS_HELPER!;
  const launcher = env.FACTORY_DARWIN_SETSID!;
  const port = path.join(runtime.engineHome, 'lib/darwin-profile-channel.py');
  const args = [identity.controlRoot, identity.task, identity.attempt, profile, helper];
  const options = { env, timeout: 15_000 };

  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(profile, '# Профиль проверки канала\n', { mode: 0o600 });
  await fs.writeFile(broker, [
    `#!${runtime.node}`,
    'import fs from "node:fs";',
    'const context = JSON.parse(fs.readFileSync(Number(process.env.GRIGDESK_PROFILE_CONTEXT_FD), "utf8"));',
    'const ready = Number(process.env.GRIGDESK_PROFILE_READY_FD);',
    'fs.writeSync(ready, JSON.stringify({ version: 1, channelId: context.channel }) + "\\n");',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), { mode: 0o700 });
  await fs.writeFile(close, [
    `#!${runtime.node}`,
    'import fs from "node:fs";',
    'import { execFileSync } from "node:child_process";',
    'import { setTimeout as pause } from "node:timers/promises";',
    'const context = JSON.parse(fs.readFileSync(Number(process.env.GRIGDESK_PROFILE_CONTEXT_FD), "utf8"));',
    'if (!context.broker) process.exit(0);',
    'const { pid, sid, pgid, starttime } = context.broker;',
    'const target = ["signal-stage-member", String(pid), starttime, String(sid), String(pgid), "TERM"];',
    'execFileSync(process.argv[2], target);',
    'for (let step = 0; step < 50; step++) {',
    '  const census = JSON.parse(execFileSync(process.argv[2], ["uid-census"], { encoding: "utf8" }));',
    '  if (census.every((row) => row.sid !== sid)) process.exit(0);',
    '  await pause(50);',
    '}',
    'process.exit(1);',
    '',
  ].join('\n'), { mode: 0o700 });

  const closeChannel = () => execute('python3', [port, 'close', ...args, '143'], options);

  t.after(async () => {
    await closeChannel();
  });

  const child = execFile('python3', [port, 'open', ...args, 'SCOUT', fixture.visitId,
    '', String(process.pid), launcher], options);
  const errors: Buffer[] = [];

  child.stderr!.on('data', (chunk: Buffer) => errors.push(chunk));
  child.stdin!.on('error', () => child.stdin!.destroy());
  child.stdin!.end(JSON.stringify({
    version: 1,
    brokerArgv: [broker],
    closeArgv: [close, helper],
  }));

  const [code] = await once(child, 'close');

  assert.equal(code, 0, Buffer.concat(errors).toString());

  const pointer = path.join(identity.controlRoot, 'profile-channels', `t${identity.task}`, 'active.json');

  return { pointer, close: closeChannel };
}

/**
 * Asserts real journal CAS and read-back authority for a valid request.
 * Invalid descriptor states cannot write a decision, intent, or authority.
 */
export async function verifyRuntimePinFd(fixture: PinFixture, scenario: FdScenario) {
  const before = (await fs.readdir(fixture.journal)).sort();
  const fd = {
    'FD-VALID': fixture.context,
    'FD-MISSING': undefined,
    'FD-EOF': '',
    'FD-INVALID': fixture.context.replace('"task":"42"', '"task":"43"'),
  }[scenario];
  const result = await fixture.invoke(fd);

  if (scenario !== 'FD-VALID') {
    const detail = scenario.slice(3).toLowerCase();

    assert.equal(result.code, 78, result.stderr);
    assert.match(result.stderr, new RegExp('^FACTORY_ERROR=factory_runtime_context_' + detail + '$', 'm'));
    assert.deepEqual((await fs.readdir(fixture.journal)).sort(), before);
    assert.equal(await readExistingFactoryRuntimePin(fixture.identity), null);

    return;
  }

  assert.equal(result.code, 0, result.stderr);

  const decision = JSON.parse(result.stdout);
  const saved = await readExistingFactoryRuntimePin(fixture.identity);

  assert.equal(decision.kind, 'decision');
  assert.equal(decision.answer, await fs.readFile(fixture.answer, 'utf8'));
  assert.equal((await fs.readdir(fixture.journal)).length, before.length + 1);
  assert.equal(saved?.packageId, fixture.runtime.packageId);
  assert.equal(saved?.engineBin, fixture.runtime.engineBin);
  assert.equal(saved?.node, fixture.runtime.node);
}

/**
 * Writes a witness only after the assertions finish.
 * Test runners without an evidence scope can still run the assertions.
 */
export async function writeMacRuntimePinWitness(id: string, barrier: string) {
  const directory = process.env.GRIGDESK_RUNTIME_PIN_WITNESS_DIR;

  if (directory) {
    await assertRuntimePinDirectory(directory);
    await fs.writeFile(path.join(directory, id + '.json'), JSON.stringify({
      id,
      outcome: 'passed',
      barrier,
    }) + '\n', { flag: 'wx', mode: 0o600 });
  }
}
