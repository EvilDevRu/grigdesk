import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildReleaseUtility } from '../../tools/goReleaseUtility.mts';
import { runStages, type ReleaseRecipe } from '../../tools/releasePipeline.mts';
import {
  configureDarwinBuildProcessHelper, readDarwinProcessIdentity, quiesceDarwinRunnerFile,
} from '../../shared/node/processIdentity.ts';
import { loggedStage } from '../../server/scripts/buildBinary.mts';
import { writeRuntimeJson } from '../../server/src/binary/leases.ts';
import { hasPendingDarwinLaunch, readDarwinLaunchRecords, spawnDarwinRouteProcess }
  from '../../server/src/lib/factoryDarwinLaunch.ts';
import { initializeDarwinOwnershipRoots, verifyDarwinOwnershipRoots }
  from '../../server/src/lib/factoryDarwinOwnershipRoots.ts';
import { readDarwinTaskOwnership } from '../../server/src/lib/factoryDarwinInventory.ts';
import { decodeCompleteFactoryOwnership } from '../../shared/runtime/factoryOwnership.ts';

const execute = promisify(execFile);

test('MAC-CLI: сборка выпускает автономные ARM64-команды',
  { timeout: 1200000 }, async (t) => {
    assert.equal(`${process.platform}-${process.arch}`, 'darwin-arm64');

    const root = path.resolve(import.meta.dirname, '../..');
    const work = await fs.mkdtemp('/private/tmp/gd-cli-native-');
    const out = path.join(work, 'bin');
    const cache = path.join(work, 'cache');
    const env = { HOME: work, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

    t.after(() => fs.rm(work, { recursive: true, force: true }));
    await fs.mkdir(out);

    const version = (await fs.readFile(path.join(root, 'VERSION'), 'utf8')).trim();
    const commands = ['tracker', 'pipeline', 'routes', 'voice', 'grigdesk-relay', 'grigdesk-ctl',
      'grigdesk-maintenance', 'deepseek'] as const;

    for (const name of commands) {
      await t.test(name, async () => {
        if (name === 'deepseek') {
          await execute(process.execPath, ['tools/bundle.mts', '--prepare-deepseek', cache], {
            cwd: root, timeout: 360000,
          });
          await execute('npm', ['--prefix', path.join(root, 'deepseek'), 'run', 'build', '--',
            '--out-dir', out, '--node-cache-dir', cache], {
            cwd: root,
            timeout: 360000,
            maxBuffer: 8 * 1024 * 1024,
          });
        } else {
          await buildReleaseUtility(name, {
            root,
            output: path.join(out, name),
            cache,
            version,
            env: process.env,
          });
        }

        const binary = path.join(out, name);
        const { stdout: architecture } = await execute('/usr/bin/file', ['-b', binary], { env });

        assert.match(architecture, /Mach-O.*arm64/u);
        await execute('/usr/bin/codesign', ['--verify', '--strict', binary], { env });

        const { stdout } = await execute(binary, ['--runtime-info', '--json'], {
          cwd: work,
          env,
          timeout: 30000,
        });

        if (name === 'deepseek') {
          const value = JSON.parse(stdout);

          assert.equal(value.platform, 'darwin');
          assert.equal(value.arch, 'arm64');

          const proof = await execute(binary, ['--cache-dir', path.join(work, 'runtime-cache'),
            '--verify', '--json'], {
            cwd: work,
            env,
            timeout: 120000,
          });

          assert.equal(JSON.parse(proof.stdout).glmPlugin, true);
        } else {
          assert.deepEqual(JSON.parse(stdout), {
            schema: 1,
            kind: name,
            version,
            runtime: 'go',
            go: 'go1.27.4',
            os: 'darwin',
            arch: 'arm64',
          });
        }
      });
    }
  });

test('MAC-SERVER-STAGE: код, журнал и таймаут без GNU timeout', { timeout: 45000 }, async (t) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-mac-stage-'));

  t.after(() => fs.rm(work, { recursive: true, force: true }));

  const prefix = path.join(work, 'stage-');
  const marker = path.join(work, 'started');
  const input = {
    file: process.execPath,
    cwd: work,
    env: process.env,
    prefix,
  };

  await assert.rejects(loggedStage({
    ...input,
    name: 'exit',
    args: ['-e', 'process.stdout.write("stage wrote\\n", () => process.exit(17))'],
  }), { code: 17, cleanupConfirmed: true });
  assert.equal(await fs.readFile(`${prefix}exit.exit`, 'utf8'), '17\n');
  assert.equal(await fs.readFile(`${prefix}exit.log`, 'utf8'), 'stage wrote\n');

  await assert.rejects(loggedStage({
    ...input,
    name: 'timeout',
    args: ['-e', 'require("fs").writeFileSync(process.argv[1], "1"); setInterval(() => {}, 1000)', marker],
    timeoutMs: 3000,
  }), { code: 124, cleanupConfirmed: true });
  assert.equal(await fs.readFile(marker, 'utf8'), '1');
  assert.equal(await fs.readFile(`${prefix}timeout.exit`, 'utf8'), '124\n');
});

test('MAC-RECIPE-TIMEOUT: квитанция сохраняет 124 и блокирует независимую стадию',
  { timeout: 45000 }, async (t) => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-mac-recipe-'));
    const receipts = path.join(work, 'receipts');
    const marker = path.join(work, 'forbidden');

    t.after(() => fs.rm(work, { recursive: true, force: true }));

    const recipe: ReleaseRecipe = {
      format: 1,
      stages: [
        {
          id: 'timeout',
          group: 'test',
          argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
          timeoutMs: 3000,
        },
        {
          id: 'unexpected',
          group: 'build',
          argv: [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], "bad")', marker],
        },
      ],
    };
    const result = await runStages({
      recipe,
      cwd: work,
      env: process.env,
      logFile: path.join(work, 'pipeline.log'),
      receiptDir: receipts,
      darwinToolchain: {
        nodeVersion: 'v24.21.0',
        npmVersion: '11.0.0',
      },
    });

    assert.equal(result.code, 124);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.outcomes.unexpected?.status, 'cancelled');
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });

    const receiptFile = path.join(receipts, `pipeline-${result.runId}.json`);
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));

    assert.equal(receipt.code, 124);
    assert.equal(receipt.environment.nodeVersion, 'v24.21.0');
    assert.equal(receipt.environment.setsidSha256, process.env.GRIGDESK_BUILD_SETSID_SHA256);
  });

test('MAC-SEA-SERVER: server metadata доступна без Node в PATH', async (t) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-mac-server-'));

  t.after(() => fs.rm(work, { recursive: true, force: true }));

  const root = path.resolve(import.meta.dirname, '../..');
  const cache = path.join(work, 'cache');
  const out = path.join(work, 'out');

  await execute(process.execPath, ['server/scripts/ctlBuild.mts', 'prepare-runtime', cache], { cwd: root });
  await execute(process.execPath, [
    'server/scripts/buildBinary.mts', '--out-dir', out, '--cache-dir', cache,
  ], { cwd: root, timeout: 600_000 });

  const binary = path.join(out, 'grigdesk-server');
  const options = {
    cwd: work,
    env: { HOME: work, PATH: '/usr/bin:/bin' },
    timeout: 30_000,
  };
  const { stdout: description } = await execute('/usr/bin/file', ['-b', binary], options);

  assert.match(description, /Mach-O.*arm64/u);
  await execute('/usr/bin/codesign', ['--verify', '--strict', binary], options);

  const { stdout } = await execute(binary, ['--runtime-info', '--json'], options);
  const info = JSON.parse(stdout);

  assert.match(info.packageId, /^[a-f0-9]{64}$/u);
  assert.deepEqual(info.runtime, {
    platform: 'darwin',
    arch: 'arm64',
    node: '24.21.0',
    abi: '137',
  });

  const { stdout: proof } = await execute(binary, ['--verify', '--json'], options);

  assert.equal(JSON.parse(proof).verified, true);
  assert.deepEqual(JSON.parse(proof).runtime, info.runtime);
});

test('MAC-PROCESS: живой owner идентифицируется без procfs', async () => {
  await configureDarwinBuildProcessHelper();

  const { readUpdateProcess } = await import('../../shared/node/updateProcessOwner.ts');
  const owner = await readUpdateProcess(process.pid);

  assert.equal(owner.pid, process.pid);
  assert.match(owner.starttime, /^\d+$/u);
  assert.equal(owner.executable, await fs.realpath(process.execPath));
  assert.deepEqual(await readUpdateProcess(process.pid), owner);
});

test('MAC-CENSUS: родитель присутствует в снимке той же UID', async () => {
  await configureDarwinBuildProcessHelper();

  const helper = process.env.GRIGDESK_BUILD_PROCESS_HELPER;

  assert.ok(helper);

  const options = {
    cwd: '/',
    env: {},
    timeout: 5000,
  };
  const { stdout } = await execute(helper, ['uid-census'], options);
  const entries = JSON.parse(stdout) as { pid: number; starttime: string }[];
  const own = entries.find((entry) => entry.pid === process.pid);

  assert.ok(own);
  assert.match(own.starttime, /^\d+$/u);

  const { stdout: bootId } = await execute(helper, ['boot-id'], options);

  assert.match(bootId.trim(), /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
});

test('MAC-LOCK-OWNER: живой владелец и совпадение starttime защищают lock', async (t) => {
  const { acquireDirectoryLock, directoryLockState, processOwnerState } =
    await import('../../shared/node/directoryLock.ts');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-mac-lock-'));

  t.after(() => fs.rm(work, { recursive: true, force: true }));
  await configureDarwinBuildProcessHelper();

  const directory = path.join(work, 'runtime.lock');
  const lock = await acquireDirectoryLock(directory, { waitMs: 0 });

  try {
    assert.equal(await directoryLockState(directory), 'alive');
    assert.equal(await processOwnerState({ ...lock.owner, starttime: '0' }), 'dead');
    await assert.rejects(acquireDirectoryLock(directory, { waitMs: 0 }), {
      code: 'directory_lock_busy',
    });
  } finally {
    await lock.release();
  }

  assert.equal(await directoryLockState(directory), 'absent');
});

test('MAC-CONTAINED: отказ происходит до preflight или запуска Linux-песочницы', async () => {
  const { runContainedKimi } = await import('../../server/src/lib/kimi/runtime.ts');
  const { startQwenSandbox } = await import('../../server/src/lib/qwen/sandbox.ts');
  const fail = () => assert.fail('Linux-песочница попыталась запуститься');
  const qwen = {
    mode: 'default',
    authType: 'test',
    cwd: '/',
    home: '/',
  };

  await assert.rejects(runContainedKimi({
    config: {
      kimiLaunchMode: 'contained',
      kimiHome: '/',
      kimiRuntimeHome: '/',
      chatsDir: '/',
      kimiBin: '/bin/false',
    },
    deps: {
      assertVersion: fail,
      preflight: fail,
      spawn: fail,
    },
  }), { code: 'platform_capability_unsupported' });

  const snapshot = {
    models: [],
    settings: {},
    fingerprint: '',
    envKeys: [],
    automatic: false,
  };

  await assert.rejects(startQwenSandbox({}, snapshot, qwen), {
    code: 'platform_capability_unsupported',
  });
});

test('MAC-STATUS-FD: повторное чтение capability сохраняет смещение FD', async (t) => {
  const root = path.resolve(import.meta.dirname, '../..');
  const helper = process.env.GRIGDESK_BUILD_PROCESS_HELPER;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-status-fd-'));

  assert.ok(helper);
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  const tokenFile = path.join(temporary, 'token');

  await fs.writeFile(tokenFile, 'fixture-token\n', { mode: 0o600 });

  const script = [
    'source "$1"',
    'exec 7<"$2"',
    'read_status_token 7 || exit',
    'read_status_token 7 || exit',
    'IFS= read -r token <&7 || exit',
    'printf "%s\\n" "$token"',
    'exec 7<&-',
    'read_status_token 7',
    '[[ $? == 1 ]] || exit 10',
    'exec 7</dev/null',
    'read_status_token 7',
    '[[ $? == 74 ]]',
  ].join('\n');
  const { stdout } = await execute('/bin/bash', [
    '-c', script, 'fixture', path.join(root, 'engine/lib/status-request.sh'), tokenFile,
  ], {
    cwd: temporary,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: temporary,
      FACTORY_DARWIN_PROCESS_HELPER: helper,
    },
    timeout: 10_000,
  });

  assert.deepEqual(stdout.trim().split('\n'), ['fixture-token', 'fixture-token', 'fixture-token']);
});

test('MAC-RUN-DIR-FD: meta и events остаются привязаны к исходному inode каталога', async (t) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-mac-run-fd-'));
  const run = path.join(work, 'run');
  const moved = path.join(work, 'retained');
  const external = path.join(work, 'external');
  const helper = process.env.GRIGDESK_BUILD_PROCESS_HELPER;

  assert.ok(helper);
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  await fs.mkdir(run, { mode: 0o700 });
  await fs.writeFile(external, 'original');

  const directory = await fs.open(run, 'r');

  t.after(() => directory.close());
  await fs.rename(run, moved);
  await fs.mkdir(run, { mode: 0o700 });
  await fs.writeFile(path.join(moved, 'events.jsonl'), 'old events', { mode: 0o600 });
  await fs.writeFile(path.join(run, 'events.jsonl'), 'new events', { mode: 0o600 });
  await fs.symlink(external, path.join(moved, 'meta.env'));

  /**
   * Сохраняет один и тот же FD после переименования каталога.
   * Путь helper закрепляется внешней нативной подготовкой теста.
   */
  function runHelper(command: string, input?: string) {
    return spawnSync(helper!, [command, '3'], {
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe', directory.fd],
      encoding: 'utf8',
      timeout: 5000,
      input,
    });
  }

  const events = runHelper('run-events-stat');

  assert.equal(events.status, 0, events.stderr);
  assert.equal(JSON.parse(events.stdout).ino,
    String((await fs.stat(path.join(moved, 'events.jsonl'), { bigint: true })).ino));
  assert.equal(runHelper('write-run-meta', 'A=B\n').status, 0);
  assert.equal(await fs.readFile(path.join(moved, 'meta.env'), 'utf8'), 'A=B\n');
  assert.equal(await fs.readFile(external, 'utf8'), 'original');
  await assert.rejects(fs.stat(path.join(run, 'meta.env')), { code: 'ENOENT' });
  await fs.unlink(path.join(moved, 'events.jsonl'));
  assert.equal(runHelper('run-events-stat').status, 3);
  await fs.symlink(external, path.join(moved, 'events.jsonl'));
  assert.equal(runHelper('run-events-stat').status, 74);
});

test('MAC-RUN-FD-BROKER: операции получают только назначенные FD', { timeout: 20000 }, async (t) => {
  const work = await fs.mkdtemp('/private/tmp/gd-fds-');
  const run = path.join(work, 'run');
  const socketRoot = path.join(work, 'socket-'.repeat(18));
  const sentinel = path.join(work, 'inherited');
  const helper = process.env.GRIGDESK_BUILD_PROCESS_HELPER;

  assert.ok(helper);
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  await fs.mkdir(run, { mode: 0o700 });
  await fs.mkdir(socketRoot, { mode: 0o700 });
  await fs.writeFile(sentinel, 'test');

  const directory = await fs.open(run, 'r');
  const original = await directory.stat({ bigint: true });
  const rejected = spawnSync(helper, [
    'runner-fd-hold', socketRoot, run, '123', 'steady', '1', String(original.dev), String(original.ino + 1n),
  ], {
    stdio: ['ignore', 'pipe', 'ignore', directory.fd],
    timeout: 5000,
  });

  assert.equal(rejected.status, 74);
  await assert.rejects(fs.stat(path.join(run, 'events.jsonl')), { code: 'ENOENT' });

  const broker = spawn(helper, [
    'runner-fd-hold', socketRoot, run, '123', 'steady', '1', String(original.dev), String(original.ino),
  ], { stdio: ['pipe', 'pipe', 'ignore', directory.fd] });
  const done = once(broker, 'exit');
  const lines = createInterface({ input: broker.stdout! })[Symbol.asyncIterator]();

  t.after(async () => {
    if (!broker.stdin?.writableEnded) {
      broker.stdin?.end();
    }

    await done;
    await directory.close();
  });

  assert.match((await lines.next()).value ?? '', /^READY 123 steady 1 \d+ \d+ \d+ \d+$/u);

  /**
   * Передаёт одноразовый nonce только через анонимный канал в FD 4.
   * Дочерний Node показывает, какие дескрипторы пережили exec.
   */
  function borrow(operation: string, nonce: string) {
    return spawnSync('/bin/bash', ['-c', [
      'IFS= read -r nonce',
      'exec "$1" runner-fd-exec "$2" "$3" "$4" -e "$5" "$6" "$7" "$8"'
        + ' 4< <(printf %s "$nonce") 6<"$8"',
    ].join('\n'), 'test', helper!, socketRoot, operation, process.execPath, [
      'const fs = require("node:fs");',
      'const identity = (stat) => `${stat.dev}:${stat.ino}`;',
      'const inputs = process.argv.slice(1).map((file) => identity(fs.statSync(file, { bigint: true })));',
      'const known = [];',
      'for (let fd = 3; fd < 10; fd++) { try {',
      '  if (inputs.includes(identity(fs.fstatSync(fd, { bigint: true })))) known.push(fd);',
      '} catch {} }',
      'console.log(JSON.stringify({ known, cwd: process.cwd() }));',
    ].join('\n'), run, path.join(run, 'events.jsonl'), sentinel], {
      input: `${nonce}\n`,
      encoding: 'utf8',
      timeout: 5000,
    });
  }

  broker.stdin!.write('p');

  const permission = (await lines.next()).value ?? '';
  const nonce = /^PERMIT ([0-9a-f]{64})$/u.exec(permission)?.[1];

  assert.ok(nonce, 'Брокер должен выдать разрешение на prepare');
  assert.notEqual(borrow('m', nonce).status, 0);

  const prepared = borrow('p', nonce);

  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(JSON.parse(prepared.stdout), { known: [7, 8, 9], cwd: await fs.realpath(process.cwd()) });
  assert.notEqual(borrow('p', nonce).status, 0);
  broker.stdin!.end();
  assert.deepEqual(await done, [0, null]);
  await assert.rejects(fs.stat(path.join(socketRoot, 'fd')), { code: 'ENOENT' });
});

test('MAC-DURABLE-LAUNCH: отказ записи до permit закрывает wrapper и допускает повтор',
  { timeout: 30000 }, async (t) => {
    const root = await fs.mkdtemp('/private/tmp/gd-launch-');
    const marker = path.join(root, 'engine-spawned');
    const records = path.join(root, 'launch-processes');

    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await configureDarwinBuildProcessHelper();

    const input = {
      task: '123',
      attempt: null,
      dispatch: null,
      controlRoot: root,
      command: process.execPath,
      args: ['-e', [
        'const fs = require("node:fs");',
        'const [root, output] = process.argv.slice(1);',
        'const file = root + "/" + fs.readdirSync(root).find((name) => name.endsWith(".json"));',
        'fs.writeFileSync(output, JSON.parse(fs.readFileSync(file, "utf8")).phase);',
      ].join('\n'), records, marker],
      env: { FACTORY_DARWIN_SETSID: process.env.GRIGDESK_TEST_SETSID_BIN },
      logFile: path.join(root, 'launch.log'),
    };

    const refused = await spawnDarwinRouteProcess(input, async (file, value) => {
      await writeRuntimeJson(file, value);

      if ((value as { phase: string }).phase === 'registered') {
        throw Object.assign(new Error('Сбой синхронизации после rename'), { code: 'EIO' });
      }
    });

    assert.deepEqual(refused, { state: 'before-spawn' });
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    assert.deepEqual(await readDarwinLaunchRecords(root), []);

    const started = await spawnDarwinRouteProcess(input);

    assert.equal(started.state, 'launched');
    assert.equal(await fs.readFile(marker, 'utf8'), 'registered');

    const [registered] = await readDarwinLaunchRecords(root);

    assert.equal(registered?.task, '123');
    assert.equal(registered?.phase, 'registered');
    assert.ok(registered?.process);
    assert.equal(registered.process.sid, registered.process.pid);
    assert.equal(await hasPendingDarwinLaunch(root, '123'), true);
    assert.equal(await hasPendingDarwinLaunch(root, '124'), false);

    await fs.link(path.join(records, `t123.${registered.launchId}.json`), path.join(root, 'hardlink'));
    await assert.rejects(readDarwinLaunchRecords(root), /factory_launch_record_invalid/u);
  });

test('MAC-OWNERSHIP-ROOTS: пустые каталоги закрепляются один раз', async (t) => {
  const dataHome = await fs.mkdtemp('/private/tmp/gd-ownership-');
  const paths = {
    dataHome,
    stateDir: path.join(dataHome, 'factory/state'),
    factoryControlDir: path.join(dataHome, 'factory/control'),
  };

  t.after(() => fs.rm(dataHome, { recursive: true, force: true }));
  await initializeDarwinOwnershipRoots(paths);
  await verifyDarwinOwnershipRoots(paths);
  assert.deepEqual(await readDarwinLaunchRecords(paths.factoryControlDir), []);

  const known = new Set<string>();
  let generation = 1;
  const snapshot = () => ({ generation, tasks: [] });
  const verified = () => Promise.resolve(null);
  const initial = await readDarwinTaskOwnership(paths, known, snapshot, verified);

  assert.deepEqual(decodeCompleteFactoryOwnership(initial), []);

  const changing = await readDarwinTaskOwnership(paths, known,
    () => ({ generation: generation++, tasks: [] }), verified);

  assert.equal(changing.complete, false);

  const runner = path.join(paths.factoryControlDir, 'runner-processes');

  await fs.rename(runner, runner + '.old');
  await assert.rejects(initializeDarwinOwnershipRoots(paths), { code: 'ENOENT' });
  await assert.rejects(fs.stat(runner), { code: 'ENOENT' });

  await fs.mkdir(runner, { mode: 0o700 });
  await assert.rejects(verifyDarwinOwnershipRoots(paths), /factory_ownership_root_changed/u);
  assert.equal((await readDarwinTaskOwnership(paths, known, snapshot, verified)).complete, false);
});

test('MAC-PROFILE-CHANNEL: готовность привязана к каналу и закрытие повторяемо',
  { timeout: 45000 }, async (t) => {
    const helper = process.env.GRIGDESK_BUILD_PROCESS_HELPER;
    const setsid = process.env.GRIGDESK_TEST_SETSID_BIN;

    assert.ok(helper && setsid);

    const root = await fs.mkdtemp('/private/tmp/gd-profile-test-');
    const profile = path.join(root, 'profile.sh');
    const broker = path.join(root, 'broker.mjs');
    const close = path.join(root, 'close.mjs');
    const task = '123';
    const attempt = `a_${'2'.repeat(32)}`;
    const visit = `nv_${'3'.repeat(32)}`;
    const port = path.resolve(import.meta.dirname, '../../engine/lib/darwin-profile-channel.py');
    const args = [root, task, attempt, profile, helper];
    const closeChannel = () => execute('python3', [port, 'close', ...args, '143'], { timeout: 8000 });

    t.after(async () => {
      await closeChannel().catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    });
    await fs.writeFile(profile, '# fixture\n', { mode: 0o600 });
    await fs.writeFile(broker, [
      `#!${process.execPath}`,
      'import fs from "node:fs";',
      'const context = JSON.parse(fs.readFileSync(Number(process.env.GRIGDESK_PROFILE_CONTEXT_FD), "utf8"));',
      'const ready = Number(process.env.GRIGDESK_PROFILE_READY_FD);',
      'const channelId = process.argv[2] === "foreign" ? "c_" + "d".repeat(32) : context.channel;',
      'setTimeout(() => fs.writeSync(ready, JSON.stringify({ version: 1, channelId }) + "\\n"), 100);',
      'setInterval(() => {}, 1000);',
    ].join('\n') + '\n', { mode: 0o700 });
    await fs.writeFile(close, [
      `#!${process.execPath}`,
      'import fs from "node:fs";',
      'import { execFileSync } from "node:child_process";',
      'import { setTimeout as pause } from "node:timers/promises";',
      'const scope = JSON.parse(fs.readFileSync(Number(process.env.GRIGDESK_PROFILE_CONTEXT_FD), "utf8"));',
      'if (!scope.broker) process.exit(0);',
      'const { pid, sid, pgid, starttime } = scope.broker;',
      'const signalArgs = ["signal-stage-member", String(pid), starttime,',
      '  String(sid), String(pgid), "TERM"];',
      'execFileSync(process.argv[2], signalArgs);',
      'for (let step = 0; step < 50; step++) {',
      '  const census = JSON.parse(execFileSync(process.argv[2], ["uid-census"], { encoding: "utf8" }));',
      '  if (census.every((row) => row.sid !== sid)) process.exit(0);',
      '  await pause(50);',
      '}',
      'process.exit(1);',
    ].join('\n') + '\n', { mode: 0o700 });

    const openChannel = (mode: 'correct' | 'foreign') => spawnSync('python3', [port, 'open', ...args,
      'SCOUT', visit, '', String(process.pid), setsid], {
      encoding: 'utf8',
      input: JSON.stringify({
        version: 1,
        brokerArgv: [broker, mode],
        closeArgv: [close, helper],
      }),
      timeout: 15000,
    });
    const failed = openChannel('foreign');

    assert.equal(failed.status, 78);
    assert.match(failed.stderr, /release_task_cleanup_required/u);
    await closeChannel();

    const opened = openChannel('correct');
    const dir = opened.stdout.trim();

    assert.equal(opened.status, 0, opened.stderr);
    assert.equal((await fs.stat(dir)).isDirectory(), true);
    await closeChannel();
    await closeChannel();
    await assert.rejects(fs.lstat(dir), { code: 'ENOENT' });
  });

test('MAC-TX-FSYNC: синхронизация и CAS указателя используют удержанный каталог', async (t) => {
  const root = await fs.mkdtemp('/private/tmp/gd-tx-sync-');
  const helper = process.env.GRIGDESK_BUILD_PROCESS_HELPER;
  const pointer = path.join(root, 'active.env');
  const state = path.join(root, 'state.env');

  assert.ok(helper);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(pointer, 'SCHEMA=1\nTRANSACTION_ID=exact\n', { mode: 0o600 });
  await fs.writeFile(state, 'STATE=cleaning\n', { mode: 0o600 });

  const directory = await fs.open(root, 'r');

  t.after(() => directory.close());

  /**
   * Владелец передаёт только FD каталога и фиксированную операцию.
   * Точный содержательный статус возвращается через код native helper.
   */
  function run(operation: string, ...args: string[]) {
    return spawnSync(helper!, [operation, '3', ...args], {
      stdio: ['ignore', 'ignore', 'ignore', directory.fd],
      timeout: 4000,
    }).status;
  }

  assert.equal(run('sync-tx-state'), 0);
  assert.equal(run('clear-tx-pointer', 'foreign'), 74);
  assert.equal(await fs.readFile(pointer, 'utf8'), 'SCHEMA=1\nTRANSACTION_ID=exact\n');
  assert.equal(run('clear-tx-pointer', 'exact'), 0);
  assert.equal(run('clear-tx-pointer', 'exact'), 0);
  await fs.unlink(state);
  await fs.symlink('foreign', state);
  assert.equal(run('sync-tx-state'), 74);
  assert.equal(run('sync-restored-object', 'symlink', 'state.env'), 0);
  assert.equal(run('sync-restored-object', 'missing', 'state.env'), 74);
});

test('MAC-GIT-SNAPSHOT: свежий scratch сохраняет режим split index и реальный inode', async (t) => {
  const root = await fs.mkdtemp('/private/tmp/gd-git-');
  const repo = path.join(root, 'repo');
  const scratch = path.join(root, 'proof');
  const script = path.resolve(import.meta.dirname, '../../engine/lib/workspace-guard-darwin.py');
  const index = path.join(repo, '.git/index');
  const worktreeFile = path.join(repo, 'tracked.txt');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(repo);
  await fs.mkdir(scratch, { mode: 0o700 });

  const git = (...args: string[]) => execute('git', ['-C', repo, ...args], { timeout: 10000 });
  const proof = (action: string, ...args: string[]) => execute('python3',
    [script, action, scratch, ...args], { timeout: 10000 });

  await git('init', '--quiet', '--template=');
  await fs.writeFile(worktreeFile, 'same bytes\n');
  await git('add', 'tracked.txt');
  await git('-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid',
    'commit', '--quiet', '-m', 'initial');
  await git('config', 'diff.autoRefreshIndex', 'true');
  await git('update-index', '--split-index');

  const before = await fs.stat(index, { bigint: true });
  const bytes = await fs.readFile(index);
  const replacement = path.join(repo, '.tracked-new');

  await fs.writeFile(replacement, 'same bytes\n');
  await fs.rename(replacement, worktreeFile);
  await proof('prepare', repo);
  assert.equal((await proof('probe', 'diff', '--name-only', 'HEAD', '--')).stdout, '');
  await fs.writeFile(worktreeFile, 'diff bytes\n');
  assert.equal((await proof('probe', 'diff', '--name-only', 'HEAD', '--')).stdout, 'tracked.txt\n');
  await proof('verify');

  const after = await fs.stat(index, { bigint: true });

  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(await fs.readFile(index), bytes);
});

test('MAC-GIT-RESTORE: checkpoint отвергает чужой флаг, Git lock удерживается до release',
  { timeout: 30000 }, async (t) => {
    const home = await fs.mkdtemp('/private/tmp/gd-restore-');
    const repo = path.join(home, 'repo');
    const transaction = path.join(home, 'tx');
    const index = path.join(repo, '.git/index');
    const lock = index + '.lock';
    const guard = path.resolve(import.meta.dirname, '../../engine/lib/workspace-guard-darwin.py');
    const locks = path.resolve(import.meta.dirname, '../../engine/lib/workspace-index-locks.py');

    t.after(() => fs.rm(home, { recursive: true, force: true }));
    await fs.mkdir(repo);
    await fs.mkdir(transaction, { mode: 0o700 });
    await fs.writeFile(path.join(transaction, 'roots.list'), repo + '\n');
    await fs.writeFile(path.join(transaction, 'scope.list'), path.join(repo, 'scope.txt') + '\n');
    await fs.writeFile(path.join(repo, 'scope.txt'), 'base\n');
    await fs.writeFile(path.join(repo, 'unrelated.txt'), 'stays\n');

    const git = (...args: string[]) => execute('git', ['-C', repo, ...args], { timeout: 8000 });
    const proof = (operation: string, ...args: string[]) => execute('python3',
      [guard, operation, transaction, ...args], { timeout: 8000 });
    const own = (operation: string, ...args: string[]) => execute('python3',
      [locks, operation, transaction, String(process.pid), ...args], { timeout: 8000 });

    await git('init', '--quiet', '--template=');
    await git('add', 'scope.txt', 'unrelated.txt');
    await git('-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid',
      'commit', '--quiet', '-m', 'initial');
    await proof('backup-indexes');

    const baseline = await fs.readFile(index);
    const time = (await fs.stat(index, { bigint: true })).mtimeNs;
    const candidate = path.join(transaction, 'checkpoint-source.tsv');

    await fs.writeFile(path.join(repo, 'scope.txt'), 'provider\n');
    await git('add', 'scope.txt');
    await fs.writeFile(candidate, 'test snapshot\n', { mode: 0o600 });
    await git('update-index', '--assume-unchanged', 'unrelated.txt');
    await assert.rejects(proof('verify-checkpoint-indexes', '1', candidate), { code: 78 });
    await assert.rejects(fs.stat(path.join(transaction, 'indexes-expected-1.json')), { code: 'ENOENT' });
    await git('update-index', '--no-assume-unchanged', 'unrelated.txt');
    await proof('verify-checkpoint-indexes', '1', candidate);

    await fs.writeFile(lock, 'foreign');
    await assert.rejects(own('acquire'), { code: 75 });
    assert.equal(await fs.readFile(lock, 'utf8'), 'foreign');
    await fs.unlink(lock);

    await own('acquire');
    await own('verify', '1');
    await own('restore', '1');
    assert.deepEqual(await fs.readFile(index), baseline);
    assert.equal((await fs.stat(index, { bigint: true })).mtimeNs, time);
    assert.equal((await fs.stat(lock)).isFile(), true);
    await own('release');
    await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
  });

test('MAC-BOUND-RUNNER: подменённая запись не позволяет остановить сессию',
  { timeout: 25000 }, async (t) => {
    const directory = await fs.mkdtemp('/private/tmp/gd-bound-');
    const setsid = process.env.GRIGDESK_TEST_SETSID_BIN;

    assert.ok(setsid);
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await configureDarwinBuildProcessHelper();

    const child = spawn(setsid, ['/bin/sleep', '45'], { stdio: 'ignore' });
    const ended = once(child, 'exit');

    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    });
    assert.ok(child.pid);

    const deadline = Date.now() + 4000;
    let probe = await readDarwinProcessIdentity(child.pid);

    while (Date.now() < deadline && (probe.state !== 'alive' || probe.identity.sid !== child.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      probe = await readDarwinProcessIdentity(child.pid);
    }

    assert.equal(probe.state, 'alive');
    assert.equal(probe.identity.sid, child.pid);

    const record = path.join(directory, 't42.active');
    const moved = path.join(directory, 'old');
    const text = [
      'SCHEMA=1', 'TASK=42', 'STAGE=TEST', 'RUN_ID=test-run', 'EPOCH=1', 'RUNNER=fixture',
      `PID=${child.pid}`, `PGID=${child.pid}`, `SESSION=${child.pid}`,
      `STARTTIME=${probe.identity.starttime}`,
      'STATE=active', '',
    ].join('\n');

    const lockFile = path.join(directory, 't42.lock');

    await fs.writeFile(record, text, { mode: 0o600 });
    await fs.writeFile(lockFile, '', { mode: 0o600 });

    const parent = await fs.open(directory, 'r');
    const held = await fs.open(record, 'r');
    const lock = await fs.open(lockFile, 'r');
    const descriptors = {
      file: held.fd,
      directory: parent.fd,
      lock: lock.fd,
      lockDirectory: parent.fd,
    };

    t.after(() => Promise.all([parent.close(), held.close(), lock.close()]));
    await fs.rename(record, moved);
    await fs.writeFile(record, text, { mode: 0o600 });
    await assert.rejects(quiesceDarwinRunnerFile(descriptors, AbortSignal.timeout(12000)),
      /release_activity_unknown/u);
    assert.equal((await readDarwinProcessIdentity(child.pid)).state, 'alive');
    await fs.rename(moved, record);
    await quiesceDarwinRunnerFile(descriptors, AbortSignal.timeout(12000));
    assert.equal((await ended)[1], 'SIGTERM');
  });

test('MAC-WATCHDOG-TOOL: отсутствующий setsid останавливает watchdog до Node', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-mac-watchdog-'));
  const script = path.resolve(import.meta.dirname, '../run-node-tests-safe.sh');
  const sentinel = path.join(directory, 'spawned');

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const node = path.join(directory, 'node');

  await fs.writeFile(node, '#!/bin/sh\n: > "$WITNESS"\n', { mode: 0o700 });
  await assert.rejects(execute('/bin/bash', [script, '--test'], {
    cwd: directory,
    env: {
      HOME: directory,
      PATH: directory + ':/usr/bin:/bin',
      WITNESS: sentinel,
      GRIGDESK_TEST_SETSID_BIN: path.join(directory, 'missing'),
    },
    timeout: 10_000,
  }), { code: 2 });
  await assert.rejects(fs.stat(sentinel), { code: 'ENOENT' });
});
