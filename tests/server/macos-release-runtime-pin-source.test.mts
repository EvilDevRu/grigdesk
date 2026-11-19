import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';

import { factoryRuntimeScope, initializeFactoryRuntimeRegistry, readRuntimeRootRegistry }
  from '../../server/src/lib/factoryRuntimePins.ts';
import { withPackageLock, withRuntimeGcLock } from '../../server/src/binary/leases.ts';
import { directoryLockState } from '../../shared/node/directoryLock.ts';
import {
  configureDarwinBuildProcessHelper, readDarwinProcessIdentity,
} from '../../shared/node/processIdentity.ts';
import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';
import factoryModule from '../../server/src/modules/factory/index.ts';
import {
  holdRuntimePinTaskLock, macosRuntimePinFixture, seedRuntimePinGate,
  verifyRuntimePinFd, writeMacRuntimePinWitness,
} from '../helpers/macosRuntimePinFixture.mts';

const source = new URL('../../', import.meta.url);
const requireFromServer = createRequire(new URL('server/package.json', source));
const legacyReclaimPath = new URL('tests/helpers/macosLegacyReclaimFixture.mts', source).href;

type LockMode = 'gc' | 'package';
type PinFixture = Awaited<ReturnType<typeof macosRuntimePinFixture>>;

/**
 * Waits for a real child to reach the requested storage boundary.
 * The exact spawned child is interrupted before the parent inspects durable state.
 */
async function interruptAt(t: TestContext, sourceCode: string, args: string[], expected: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', sourceCode, ...args], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const finished = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  let stderr = '';

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      child.kill('SIGKILL');
    }

    await finished;
    lines.close();
  });

  const line = await Promise.race([
    once(lines, 'line', { signal: AbortSignal.timeout(10_000) }).then(([value]) => value),
    finished.then(([exit, signal]) => {
      throw new Error(`Fixture exited before ${expected}: ${exit ?? signal} ${stderr}`);
    }),
  ]);

  assert.equal(line, expected, stderr);
  await stopFixture(child, finished);
}

async function stopFixture(child: ChildProcess, exit: Promise<unknown[]>): Promise<void> {
  assert.ok(child.kill('SIGKILL'));
  assert.deepEqual(await exit, [null, 'SIGKILL']);
}

async function temporaryCase(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gd-pin-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  return directory;
}

const childBootstrap = `
  import { configureDarwinBuildProcessHelper } from ${JSON.stringify(new URL('shared/node/processIdentity.ts',
    source).href)};
  await configureDarwinBuildProcessHelper();
  const hold = async () => {
    process.stdout.write('barrier\\n');
    await new Promise(resolve => process.stdin.once('end', resolve).resume());
  };
`;
const registryChild = childBootstrap + `
  import { initializeFactoryRuntimeRegistry } from ${JSON.stringify(new URL(
    'server/src/lib/factoryRuntimePins.ts', source).href)};
  await initializeFactoryRuntimeRegistry(process.argv[1], async phase => {
    if (phase === process.argv[2]) await hold();
  });
`;
const lockChild = childBootstrap + `
  import { acquireDirectoryLock } from ${JSON.stringify(new URL(
    'shared/node/directoryLock.ts', source).href)};
  const [directory, phase] = process.argv.slice(1);
  const lock = await acquireDirectoryLock(directory, {
    waitMs: 2000,
    checkpoint: async step => { if (step === phase) await hold(); },
  });
  if (phase === 'held') await hold();
  await lock.release();
`;
const legacyLockChild = childBootstrap + `
  import { legacyReclaim } from ${JSON.stringify(legacyReclaimPath)};
  const recovered = await legacyReclaim(process.argv[1], hold);
  if (!recovered) throw new Error('directory_lock_busy');
`;

/**
 * Создаёт изолированное source-дерево writer для тестового fault port. Само
 * решение, движок, FD-проверки и транзакция остаются штатными.
 */
async function sourceWriterFaultFixture(testCase: TestContext, failure: 'registry' | LockMode) {
  const directory = await temporaryCase(testCase);
  const checkout = await fs.realpath(path.resolve(import.meta.dirname, '../..'));
  const runtime = path.join(directory, 'runtime');
  const scripts = path.join(runtime, 'server/scripts');
  const holdFile = path.join(directory, 'hold-writer');
  const traceFile = path.join(directory, 'writer-trace.json');

  await fs.mkdir(scripts, { recursive: true, mode: 0o700 });
  await fs.cp(path.join(checkout, 'engine'), path.join(runtime, 'engine'), { recursive: true });
  await fs.writeFile(holdFile, failure, { mode: 0o600 });
  await fs.writeFile(path.join(scripts, 'factoryRuntimePin.mts'), `
    import { readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    import { main } from ${JSON.stringify(new URL('server/scripts/factoryRuntimePin.mts', source).href)};
    import { commitLegacyFactoryRuntime, factoryRuntimeScope } from ${JSON.stringify(new URL(
      'server/src/lib/factoryRuntimePins.ts', source).href)};
    import { legacyReclaim } from ${JSON.stringify(legacyReclaimPath)};
    import { readDarwinProcessIdentity } from ${JSON.stringify(new URL(
      'shared/node/processIdentity.ts', source).href)};
    const hold = ${JSON.stringify(holdFile)};
    const trace = ${JSON.stringify(traceFile)};
    const failure = await readFile(hold, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    process.exitCode = await main(process.argv.slice(2), async (input) => {
      if (failure === 'gc' || failure === 'package') {
        const key = failure === 'gc' ? 'gc' : factoryRuntimeScope(input);
        const lock = path.join(input.cacheDir, '.locks', key);
        if (!await legacyReclaim(lock)) {
          await writeFile(trace, JSON.stringify({ error: 'directory_lock_busy', lock }), {
            flag: 'wx', mode: 0o600,
          });
          throw Object.assign(new Error('directory_lock_busy'), { code: 'directory_lock_busy' });
        }
      }
      return commitLegacyFactoryRuntime({
      ...input,
      checkpoint: async (phase) => {
        if (phase !== 'registry' || failure !== 'registry') return;
        const chain = [];
        let pid = process.pid;
        while (pid > 1 && pid !== ${process.pid} && chain.length < 8) {
          const row = await readDarwinProcessIdentity(pid);
          if (row.state !== 'alive') throw new Error('fixture_process_unknown');
          chain.push(row.identity);
          pid = row.identity.ppid;
        }
        if (pid !== ${process.pid}) throw new Error('fixture_process_outside_scope');
        await writeFile(trace, JSON.stringify({ phase, chain }), {
          flag: 'wx', mode: 0o600,
        });
        const signal = input.signal;
        signal.throwIfAborted();
        await new Promise((resolve, reject) => {
          const timer = setInterval(() => {}, 1000);
          signal.addEventListener('abort', () => {
            clearInterval(timer);
            reject(signal.reason);
          }, { once: true });
        });
      },
      });
    });
  `, { mode: 0o600 });

  return {
    directory,
    runtime,
    holdFile,
    traceFile,
  };
}

/**
 * Открывает настоящий HTTP Gate с приватными корнями и коротким дедлайном.
 * После сбоя тот же gateway принимает повтор без test port в пути записи.
 */
async function sourceGateApi(testCase: TestContext, fixture: PinFixture) {
  const stage = await seedRuntimePinGate(fixture);
  const { identity, runtime } = fixture;
  const dataHome = path.dirname(identity.cacheDir);
  const adapter = new FactoryStateAdapter({
    stateDir: identity.stateRoot,
    controlDir: identity.controlRoot,
    routesDir: fixture.routes,
    profilesDir: identity.profileRoot,
  });
  const config = {
    rootDir: runtime.runtimeRoot,
    dataHome,
    factoryHome: runtime.engineHome,
    factoryBin: runtime.engineBin,
    factoryConfigRoot: path.join(dataHome, 'config'),
    factoryControlDir: identity.controlRoot,
    stateDir: identity.stateRoot,
    profilesDir: identity.profileRoot,
    routesDir: fixture.routes,
    ticketsDir: path.join(dataHome, 'tickets'),
    factoryProfile: identity.profile,
    sandboxDownCmd: '',
    decisionTimeoutMs: 22_000,
    runtime: { ...runtime, cacheDir: identity.cacheDir },
  };
  const app = requireFromServer('fastify')({ logger: false });

  await fs.mkdir(path.join(identity.controlRoot, 'transaction-finalization'), { mode: 0o700 });
  testCase.after(async () => app.close());
  await app.register(factoryModule, {
    factoryState: adapter,
    config,
    prefs: { read: () => ({}) },
    tracker: null,
    analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null },
  });

  const request = () => app.inject({
    method: 'POST',
    url: `/api/tasks/${identity.task}/gate/GATE_PLAN/approve`,
    payload: {
      attempt: identity.attempt,
      profile: identity.profile,
      expectedMobile: stage.expectedMobile,
    },
  });

  return {
    config,
    request,
    stage,
  };
}

test('MAC-SOURCE-RUNTIME-PIN', { timeout: 480_000 }, async (t) => {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  await configureDarwinBuildProcessHelper();

  for (const barrier of ['FD-VALID', 'FD-MISSING', 'FD-EOF', 'FD-INVALID'] as const) {
    const id = 'MAC-SOURCE-PIN-' + barrier;

    await t.test(id, async (testCase) => {
      const directory = await temporaryCase(testCase);
      const checkout = await fs.realpath(path.resolve(import.meta.dirname, '../..'));
      const fixture = await macosRuntimePinFixture(directory, checkout, null);

      await verifyRuntimePinFd(fixture, barrier);
      await writeMacRuntimePinWitness(id, barrier);
    });
  }

  await t.test('MAC-SOURCE-PIN-WRITER-TIMEOUT', async (testCase) => {
    const seeded = await sourceWriterFaultFixture(testCase, 'registry');
    const fixture = await macosRuntimePinFixture(seeded.directory, seeded.runtime, null, 'gate');
    const { request, config, stage } = await sourceGateApi(testCase, fixture);
    const { identity } = fixture;
    const scope = factoryRuntimeScope(identity);
    const intent = path.join(identity.controlRoot, 'runtime-migration-intents', `t${identity.task}`,
      `${identity.attempt}.json`);
    const authority = path.join(identity.controlRoot, 'server-runtimes', scope, `${identity.attempt}.json`);
    const lock = path.join(identity.controlRoot, 'protocol-v2/orchestrators', `t${identity.task}.lock`);
    const eventFiles = async () => (await fs.readdir(stage.stage))
      .filter((name) => /^event\./u.test(name)).sort();
    const before = await eventFiles();
    const pipeline = await fs.readFile(stage.pipeline);
    const start = performance.now();
    const timedOut = await request();

    assert.equal(timedOut.statusCode, 504, timedOut.body);
    assert.equal(timedOut.json().error, 'engine_timeout');
    assert.ok(performance.now() - start < 45_000);

    const witness = JSON.parse(await fs.readFile(seeded.traceFile, 'utf8'));

    assert.equal(witness.phase, 'registry');
    assert.ok(witness.chain.length >= 3);

    for (const owner of witness.chain) {
      const actual = await readDarwinProcessIdentity(owner.pid);

      assert.ok(actual.state === 'dead'
        || actual.state === 'alive' && actual.identity.starttime !== owner.starttime);
    }

    const pending = JSON.parse(await fs.readFile(intent, 'utf8'));

    assert.equal(pending.pin.attempt, identity.attempt);
    assert.equal(pending.pin.node, fixture.runtime.node);
    assert.equal(pending.pin.engineBin, fixture.runtime.engineBin);
    await assert.rejects(fs.lstat(authority), { code: 'ENOENT' });

    const registry = await readRuntimeRootRegistry(identity.cacheDir);

    assert.equal(registry.roots.flatMap((root) => root.references)
      .filter((ref) => ref.scope === scope && ref.attempt === identity.attempt).length, 1);
    assert.deepEqual(await fs.readFile(stage.pipeline), pipeline);
    assert.deepEqual(await eventFiles(), before);

    const releaseLock = await holdRuntimePinTaskLock(testCase, fixture, lock);

    await releaseLock();
    await withRuntimeGcLock(identity.cacheDir, () => withPackageLock(identity.cacheDir, scope,
      async () => {}, { waitMs: 2000 }), { waitMs: 2000 });
    await fs.unlink(seeded.holdFile);
    config.decisionTimeoutMs = 60_000;

    const retry = await request();

    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(JSON.parse(await fs.readFile(authority, 'utf8')), pending.pin);
    await assert.rejects(fs.lstat(intent), { code: 'ENOENT' });
    assert.equal((await eventFiles()).length, before.length + 1);
    await writeMacRuntimePinWitness('MAC-SOURCE-PIN-WRITER-TIMEOUT', 'WRITER-TIMEOUT');
  });

  for (const [barrier, phase] of [
    ['COLD-REGISTRY-BEFORE-PUBLISH', 'before-registry'],
    ['COLD-REGISTRY-BEFORE-MARKER', 'before-marker'],
  ] as const) {
    const id = 'MAC-SOURCE-PIN-' + barrier;

    await t.test(id, async (testCase) => {
      const cache = await temporaryCase(testCase);

      await interruptAt(testCase, registryChild, [cache, phase], 'barrier');

      const marker = path.join(cache, 'state/control-roots.initialized.json');

      await assert.rejects(fs.lstat(marker), { code: 'ENOENT' });

      if (phase === 'before-registry') {
        await assert.rejects(readRuntimeRootRegistry(cache), { code: 'ENOENT' });
      } else {
        assert.deepEqual(await readRuntimeRootRegistry(cache), { format: 1, roots: [] });
      }

      await initializeFactoryRuntimeRegistry(cache);
      assert.deepEqual(await readRuntimeRootRegistry(cache), { format: 1, roots: [] });
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(cache,
        'state/control-roots.initialized.json'), 'utf8')), { format: 1 });

      await writeMacRuntimePinWitness(id, barrier);
    });
  }

  for (const mode of ['gc', 'package'] as LockMode[]) {
    for (const point of ['before', 'after'] as const) {
      const barrier = `${mode.toUpperCase()}-RECLAIM-${point.toUpperCase()}-RENAME`;
      const id = 'MAC-SOURCE-PIN-' + barrier;

      await t.test(id, async (testCase) => {
        const cache = await temporaryCase(testCase);
        const scope = factoryRuntimeScope({
          controlRoot: path.join(cache, 'control'),
          stateRoot: path.join(cache, 'state'),
          profileRoot: path.join(cache, 'profiles'),
        });
        const name = mode === 'gc' ? 'gc' : scope;
        const locks = path.join(cache, '.locks');
        const lock = path.join(locks, name);
        const sibling = path.join(locks, 'independent');

        await fs.mkdir(locks, { mode: 0o700 });
        await fs.writeFile(sibling, 'preserved', { mode: 0o600 });
        await interruptAt(testCase, lockChild, [lock, 'held'], 'barrier');
        assert.equal(await directoryLockState(lock), 'dead');
        await interruptAt(testCase, lockChild, [lock, `retire-${point}-rename`], 'barrier');
        assert.equal(await directoryLockState(lock), point === 'before' ? 'dead' : 'absent');

        let owners = 0;
        const confirm = async () => {
          assert.equal(await directoryLockState(lock), 'alive');
          owners += 1;
        };

        if (mode === 'gc') {
          await withRuntimeGcLock(cache, confirm, { waitMs: 2000 });
        } else {
          await withPackageLock(cache, scope, confirm, { waitMs: 2000 });
        }

        assert.equal(owners, 1);
        assert.equal(await directoryLockState(lock), 'absent');
        assert.equal(await fs.readFile(sibling, 'utf8'), 'preserved');
        await writeMacRuntimePinWitness(id, barrier);
      });
    }
  }

  for (const mode of ['gc', 'package'] as LockMode[]) {
    const barrier = `${mode.toUpperCase()}-LEGACY-RECLAIM-RED`;
    const id = 'MAC-SOURCE-PIN-' + barrier;

    await t.test(id, async (testCase) => {
      const seeded = await sourceWriterFaultFixture(testCase, mode);
      const fixture = await macosRuntimePinFixture(seeded.directory, seeded.runtime, null, 'gate');
      const { identity } = fixture;
      const { request, config, stage } = await sourceGateApi(testCase, fixture);
      const scope = factoryRuntimeScope(identity);
      const locks = path.join(identity.cacheDir, '.locks');
      const lock = path.join(locks, mode === 'gc' ? 'gc' : scope);
      const claim = path.join(lock, '.reclaim');
      const authority = path.join(identity.controlRoot, 'server-runtimes', scope, `${identity.attempt}.json`);
      const before = (await fs.readdir(stage.stage)).sort();
      const original = await fs.readFile(stage.pipeline);

      await fs.mkdir(locks, { mode: 0o700, recursive: true });
      await interruptAt(testCase, lockChild, [lock, 'held'], 'barrier');
      assert.equal(await directoryLockState(lock), 'dead');

      const dead = await fs.lstat(lock, { bigint: true });

      await interruptAt(testCase, legacyLockChild, [lock], 'barrier');
      assert.equal(await directoryLockState(lock), 'dead');

      const oldClaim = await fs.lstat(claim, { bigint: true });
      const refused = await request();

      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(refused.json().error, 'gate_rejected');
      assert.deepEqual(JSON.parse(await fs.readFile(seeded.traceFile, 'utf8')), {
        error: 'directory_lock_busy',
        lock,
      });
      assert.equal((await fs.lstat(lock, { bigint: true })).ino, dead.ino);
      assert.equal((await fs.lstat(claim, { bigint: true })).ino, oldClaim.ino);
      assert.equal(await directoryLockState(lock), 'dead');
      assert.deepEqual(await fs.readFile(stage.pipeline), original);
      assert.deepEqual((await fs.readdir(stage.stage)).sort(), before);
      await assert.rejects(fs.lstat(authority), { code: 'ENOENT' });
      await fs.unlink(seeded.holdFile);
      config.decisionTimeoutMs = 60_000;

      const retry = await request();

      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(await directoryLockState(lock), 'absent');
      assert.equal(JSON.parse(await fs.readFile(authority, 'utf8')).attempt, identity.attempt);
      assert.equal((await fs.readdir(stage.stage)).length, before.length + 1);
      await writeMacRuntimePinWitness(id, barrier);
    });
  }
});
