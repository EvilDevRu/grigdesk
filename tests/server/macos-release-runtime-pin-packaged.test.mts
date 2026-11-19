import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  acceptanceInputs, awaitAcceptance, execute, platformFixture, verifyAcceptanceVersions,
} from '../helpers/platformReleaseAcceptance.mts';
import {
  configureDecisionApi, holdRuntimePinTaskLock, macosRuntimePinFixture, openRuntimePinProfileChannel,
  prepareRuntime, seedRuntimePinGate,
  seedRuntimePinOpenTx, seedRuntimePinStopRecord,
  verifyRuntimePinFd, withRuntimePinFault, writeMacRuntimePinWitness,
} from '../helpers/macosRuntimePinFixture.mts';
import { dataPath } from '../../shared/runtime/dataHome.ts';
import { directoryLockState } from '../../shared/node/directoryLock.ts';
import {
  configureDarwinBuildProcessHelper, readDarwinProcessIdentity,
} from '../../shared/node/processIdentity.ts';
import {
  factoryRuntimeScope, readExistingFactoryRuntimePin, readRuntimeRootRegistry,
} from '../../server/src/lib/factoryRuntimePins.ts';

type Installed = Awaited<ReturnType<typeof platformFixture>>;
type PinFixture = Awaited<ReturnType<typeof macosRuntimePinFixture>>;

/**
 * Изменение описи или времени каталога выдаёт даже кратковременный engine lease.
 * Packed wrapper обязан получить его до spawn движка.
 */
async function engineLeaseSnapshot(box: Installed, packageIds: string[]) {
  return Promise.all(packageIds.map(async (id) => {
    const directory = path.join(dataPath(box.dataHome, 'serverRuntime'), 'leases', id);
    const info = await fs.stat(directory, { bigint: true });

    return {
      ino: info.ino,
      mtime: info.mtimeNs,
      ctime: info.ctimeNs,
      files: (await fs.readdir(directory)).sort(),
    };
  }));
}

/**
 * Запускает проверенный bundled writer с его настоящим FD и checkpoint.
 * Прерывание происходит внутри той же инкарнации до выполнения следующего шага.
 */
async function interruptPackagedWriter(fixture: PinFixture, phase: string, lock?: 'gc' | 'package') {
  const directory = await fs.mkdtemp(path.join(fixture.env.HOME!, 'writer-barrier-'));
  const port = path.join(directory, 'interrupt-writer.mjs');
  const reached = path.join(directory, 'boundary');

  await fs.writeFile(port, `
    import { writeFile } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    const [helper, ...args] = process.argv.slice(2);
    process.argv.length = 2;
    const { main } = await import(pathToFileURL(helper).href);
    process.argv[1] = helper;
    const expected = ${JSON.stringify(phase)};
    const target = ${JSON.stringify(lock ?? null)};
    async function interrupt(observed) {
      await writeFile(${JSON.stringify(reached)}, observed, { flag: 'wx', mode: 0o600 });
      process.kill(process.pid, 'SIGKILL');
    }
    process.exitCode = await main(args, (input, write) => write({
      ...input,
      checkpoint: async (step) => {
        if (target === null && step === expected) await interrupt(step);
      },
      lockCheckpoint: async (kind, step) => {
        if (target === kind && step === expected) await interrupt(step);
      },
    }));
  `, { mode: 0o600 });

  const interrupted = await fixture.commitThrough(port);

  assert.equal(interrupted.signal, 'SIGKILL', interrupted.stderr);
  assert.equal(await fs.readFile(reached, 'utf8'), phase);
}

/**
 * Сигнализирует о достигнутом read barrier с exact identity участника сессии.
 * Процесс держится до TERM/KILL штатным scoped reader.
 */
async function prepareReadBarrier(directory: string, evidence: 'catalog' | 'pending') {
  const file = path.join(directory, 'hold-reader.mjs');
  const trace = path.join(directory, 'reader-trace.json');

  await fs.writeFile(file, `
    import { writeFile } from 'node:fs/promises';
    import { spawnSync } from 'node:child_process';
    const phase = JSON.parse(process.argv[2]);
    if (phase !== 'catalog' && phase.phase !== 'pending') throw new Error('fixture_read_stage_missing');
    const helper = process.env.FACTORY_DARWIN_PROCESS_HELPER;
    const check = spawnSync(helper, ['identity', String(process.pid)], { encoding: 'utf8', timeout: 3000 });
    if (check.status !== 0) throw new Error('fixture_read_owner_unknown');
    await writeFile(${JSON.stringify(trace)}, JSON.stringify({
      evidence: phase === 'catalog' ? phase : phase.phase,
      owner: JSON.parse(check.stdout),
    }), { mode: 0o600, flag: 'wx' });
    setInterval(() => {}, 1000);
  `, { mode: 0o600 });

  const observed = async () => {
    const record = await awaitAcceptance(async () => JSON.parse(await fs.readFile(trace, 'utf8')),
      'mac_runtime_pin_read_barrier_missing', 30_000);

    assert.equal(record.evidence, evidence);

    return record.owner;
  };

  return { file, observed };
}

test('MAC-VERIFY-RUNTIME-PIN', { timeout: 1_800_000 }, async (t) => {
  const input = acceptanceInputs('darwin');
  const versions = await verifyAcceptanceVersions(input);
  const installed = await platformFixture(t, 'server');

  await configureDarwinBuildProcessHelper();
  await installed.install(input.previous);

  const current = await installed.state('current.json');
  const binary = path.join(installed.root, current.server, 'bin/grigdesk-server');
  const { runtimeRoot, packageId } = await prepareRuntime(installed, binary);

  for (const barrier of ['FD-VALID', 'FD-MISSING', 'FD-EOF', 'FD-INVALID'] as const) {
    const id = 'MAC-VERIFY-PIN-' + barrier;

    await t.test(id, async () => {
      const directory = await fs.mkdtemp(path.join(installed.homeRoot, 'decision-'));
      const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId);

      await verifyRuntimePinFd(fixture, barrier);
      await writeMacRuntimePinWitness(id, barrier);
    });
  }

  /**
   * Привязывает API штатного сервера к изолированному уже остановленному визиту.
   * Можно закрепить визит за другим поколением в том же data home.
   */
  async function prepareBootstrapApi(box: Installed, seed: { runtimeRoot: string; packageId: string },
    beforeStart?: (fixture: PinFixture) => Promise<void>) {
    const directory = await fs.mkdtemp(path.join(box.homeRoot, 'bootstrap-'));
    const fixture = await macosRuntimePinFixture(directory, seed.runtimeRoot, seed.packageId);

    await configureDecisionApi(box, fixture);
    await beforeStart?.(fixture);
    await box.ctl(['server', 'start', '--wait']);

    const answer = await fs.readFile(fixture.answer, 'utf8');
    const route = '/api/tasks/' + fixture.identity.task + '/bootstrap-answer';
    const request = () => box.api(route, {
      phase: 'bootstrap',
      node: 'scout',
      attempt: fixture.identity.attempt,
      profile: fixture.identity.profile,
      visitId: fixture.visitId,
      stopHash: fixture.stopHash,
      answer,
    }, 30_000);

    return {
      fixture,
      answer,
      request,
    };
  }

  await t.test('MAC-VERIFY-PIN-BOOTSTRAP-ANSWER', async (testCase) => {
    testCase.after(async () => {
      await installed.ctl(['server', 'stop']);
    });

    const { fixture, answer, request } = await prepareBootstrapApi(installed, { runtimeRoot, packageId });
    const before = (await fs.readdir(fixture.journal)).length;
    const result = await request();

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.decision.kind, 'decision');
    assert.equal(result.body.decision.answer, answer);
    assert.equal((await fs.readdir(fixture.journal)).length, before + 1);

    const retry = await request();

    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.decision.recordHash, result.body.decision.recordHash);
    assert.equal((await fs.readdir(fixture.journal)).length, before + 1);
    await writeMacRuntimePinWitness('MAC-VERIFY-PIN-BOOTSTRAP-ANSWER', 'BOOTSTRAP-ANSWER');
  });

  await t.test('MAC-VERIFY-PIN-BOOTSTRAP-PENDING-CHANNEL', async (testCase) => {
    testCase.after(async () => {
      await installed.ctl(['server', 'stop']);
    });

    const { fixture, request } = await prepareBootstrapApi(installed, { runtimeRoot, packageId });
    const channel = await openRuntimePinProfileChannel(testCase, fixture);
    const { controlRoot, task, attempt } = fixture.identity;
    const scope = factoryRuntimeScope(fixture.identity);
    const tx = path.join(controlRoot, 'transactions', `t${task}`);
    const intent = path.join(controlRoot, 'runtime-migration-intents', `t${task}`, `${attempt}.json`);
    const authority = path.join(controlRoot, 'server-runtimes', scope, `${attempt}.json`);
    const visitFiles = (await fs.readdir(fixture.journal)).sort();
    const visitRecords = () => Promise.all(visitFiles.map((file) => (
      fs.readFile(path.join(fixture.journal, file))
    )));
    const records = await visitRecords();
    const pointer = await fs.readFile(channel.pointer);

    for (const file of [tx, intent, authority]) {
      await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
    }

    const result = await request();

    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, 'release_task_cleanup_required');
    assert.deepEqual(await fs.readFile(channel.pointer), pointer);
    assert.deepEqual((await fs.readdir(fixture.journal)).sort(), visitFiles);
    assert.deepEqual(await visitRecords(), records);

    for (const file of [tx, intent, authority]) {
      await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
    }

    await channel.close();
    await assert.rejects(fs.lstat(channel.pointer), { code: 'ENOENT' });

    const retry = await request();

    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal((await fs.readdir(fixture.journal)).length, visitFiles.length + 1);
    assert.equal((await readExistingFactoryRuntimePin(fixture.identity))?.packageId, packageId);
    await writeMacRuntimePinWitness('MAC-VERIFY-PIN-BOOTSTRAP-PENDING-CHANNEL', 'BOOTSTRAP-PENDING-CHANNEL');
  });

  for (const fault of ['INVALID', 'MISSING'] as const) {
    const barrier = 'PIN-' + fault;
    const id = 'MAC-VERIFY-PIN-' + barrier;

    await t.test(id, async (testCase) => {
      const box = await platformFixture(testCase, 'server');

      await box.install(input.candidate);

      const active = await box.state('current.json');
      const currentBinary = path.join(box.root, active.server, 'bin/grigdesk-server');
      const runtimeB = await prepareRuntime(box, currentBinary);
      const runtimeA = await prepareRuntime(box, binary);

      assert.notEqual(runtimeA.packageId, runtimeB.packageId);

      let authority = '';
      let saved: Buffer | undefined;
      const retired = path.join(box.homeRoot, 'runtime-A-unavailable');
      const { fixture, request } = await prepareBootstrapApi(box, runtimeA, async (fixture) => {
        const committed = await fixture.commit();

        assert.equal(committed.code, 0, committed.stderr);

        const pin = await readExistingFactoryRuntimePin(fixture.identity);
        const { controlRoot, attempt } = fixture.identity;

        assert.equal(pin?.packageId, runtimeA.packageId);
        authority = path.join(controlRoot, 'server-runtimes', pin!.scope, `${attempt}.json`);
        saved = await fs.readFile(authority);

        if (fault === 'MISSING') {
          await fs.rename(runtimeA.runtimeRoot, retired);
        } else {
          await fs.writeFile(authority, JSON.stringify({ ...pin, task: '43' }));
        }
      });

      assert.equal((await box.api('/api/system/runtime-identity')).body.productVersion, versions.current);

      const generations = [runtimeA.packageId, runtimeB.packageId];
      const leases = await engineLeaseSnapshot(box, generations);
      const journal = (await fs.readdir(fixture.journal)).sort();
      const sidecar = await fs.readFile(authority);
      const result = await request();

      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.equal(result.body.error, 'factory_runtime_pin_' + fault.toLowerCase());
      assert.deepEqual(await engineLeaseSnapshot(box, generations), leases);
      assert.deepEqual((await fs.readdir(fixture.journal)).sort(), journal);
      assert.deepEqual(await fs.readFile(authority), sidecar);

      if (fault === 'MISSING') {
        await fs.rename(retired, runtimeA.runtimeRoot);
      } else {
        assert.ok(saved);
        await fs.writeFile(authority, saved);
      }

      const retry = await request();

      assert.equal(retry.status, 200, JSON.stringify(retry.body));

      const [retryA, retryB] = await engineLeaseSnapshot(box, generations);

      assert.notDeepEqual(retryA, leases[0]);
      assert.deepEqual(retryB, leases[1]);
      assert.equal((await fs.readdir(fixture.journal)).length, journal.length + 1);
      await writeMacRuntimePinWitness(id, barrier);
    });
  }

  await t.test('MAC-VERIFY-PIN-GATE-BUSY', async (testCase) => {
    testCase.after(async () => {
      await installed.ctl(['server', 'stop']);
    });

    const directory = await fs.mkdtemp(path.join(installed.homeRoot, 'gate-busy-'));
    const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId, 'gate');
    const { pipeline, stage, expectedMobile } = await seedRuntimePinGate(fixture);
    const { task, attempt, profile, controlRoot } = fixture.identity;
    const orch = path.join(controlRoot, 'protocol-v2/orchestrators', `t${task}.lock`);
    const taskRoot = path.join(controlRoot, 'protocol-v2/tasks', `t${task}`);

    await configureDecisionApi(installed, fixture);
    await installed.ctl(['server', 'start', '--wait']);

    const files = (await fs.readdir(stage)).sort();
    const snapshot = () => Promise.all([pipeline, orch, ...files.map((file) => path.join(stage, file))]
      .map((file) => fs.readFile(file)));
    const before = await snapshot();

    for (const lock of [orch, taskRoot]) {
      const release = await holdRuntimePinTaskLock(testCase, fixture, lock);

      const refused = await installed.api(`/api/tasks/${task}/gate/GATE_PLAN/approve`, {
        attempt,
        profile,
        expectedMobile,
      }, 30_000);

      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(refused.body.error, 'release_drain_busy');
      await release();
      assert.deepEqual((await fs.readdir(stage)).sort(), files);
      assert.deepEqual(await snapshot(), before);
      assert.equal(await readExistingFactoryRuntimePin(fixture.identity), null);
      await assert.rejects(fs.lstat(path.join(controlRoot, 'runtime-migration-intents', `t${task}`,
        `${attempt}.json`)), { code: 'ENOENT' });
    }

    const reacquired = await holdRuntimePinTaskLock(testCase, fixture, orch);

    await reacquired();
    await writeMacRuntimePinWitness('MAC-VERIFY-PIN-GATE-BUSY', 'GATE-BUSY');
  });

  for (const action of ['GATE', 'GOTO', 'ABANDON'] as const) {
    const barrier = action + '-PENDING-STOP';
    const id = 'MAC-VERIFY-PIN-' + barrier;

    await t.test(id, async (testCase) => {
      const directory = await fs.mkdtemp(path.join(installed.homeRoot, 'pending-stop-'));
      const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId, 'gate');
      const { pipeline, stage, expectedMobile } = await seedRuntimePinGate(fixture);
      const abandoning = action === 'ABANDON';
      const receipt = await seedRuntimePinStopRecord(fixture, abandoning);
      const { task, attempt, profile, controlRoot } = fixture.identity;
      const tx = path.join(controlRoot, 'transactions', `t${task}`);
      const intent = path.join(controlRoot, 'runtime-migration-intents', `t${task}`, `${attempt}.json`);

      testCase.after(async () => {
        await fs.rm(receipt.file, { force: true });

        if (receipt.state) {
          await fs.rm(path.dirname(receipt.state), { recursive: true, force: true });
        }

        await installed.ctl(['server', 'stop']);
      });

      if (!abandoning) {
        await assert.rejects(fs.lstat(tx), { code: 'ENOENT' });
      }

      await configureDecisionApi(installed, fixture);
      await installed.ctl(['server', 'start', '--wait']);

      const files = (await fs.readdir(stage)).sort();
      const stable = [pipeline, receipt.file, ...files.map((file) => path.join(stage, file))];

      if (receipt.state) {
        stable.push(receipt.state);
      }

      const snapshot = () => Promise.all(stable.map((file) => fs.readFile(file)));
      const before = await snapshot();
      const leases = await engineLeaseSnapshot(installed, [packageId]);
      const endpoint = {
        GATE: 'gate/GATE_PLAN/approve',
        GOTO: 'stage/INSTRUMENT/running',
        ABANDON: 'close',
      }[action];
      const reason = 'Проверка незавершённой очистки';
      const refused = await installed.api(`/api/tasks/${task}/${endpoint}`, {
        attempt,
        profile,
        expectedMobile,
        comment: reason,
      }, 30_000);

      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(refused.body.error, 'release_task_cleanup_required');

      if (abandoning) {
        assert.deepEqual(await engineLeaseSnapshot(installed, [packageId]), leases);

        const refusedDirectly = await fixture.invokeFactory('abandon', ['--reason', reason], fixture.context);

        assert.equal(refusedDirectly.code, 75, refusedDirectly.stderr);
        assert.match(refusedDirectly.stderr, /^FACTORY_ERROR=release_task_cleanup_required$/mu);
      }

      assert.notDeepEqual(await engineLeaseSnapshot(installed, [packageId]), leases);
      assert.deepEqual((await fs.readdir(stage)).sort(), files);
      assert.deepEqual(await snapshot(), before);
      assert.equal(await readExistingFactoryRuntimePin(fixture.identity), null);
      await assert.rejects(fs.lstat(intent), { code: 'ENOENT' });
      await writeMacRuntimePinWitness(id, barrier);
    });
  }

  for (const action of ['GATE', 'GOTO'] as const) {
    const barrier = action + '-HEALTHY';
    const id = 'MAC-VERIFY-PIN-' + barrier;

    await t.test(id, async (testCase) => {
      testCase.after(async () => {
        await installed.ctl(['server', 'stop']);
      });

      const directory = await fs.mkdtemp(path.join(installed.homeRoot, 'healthy-decision-'));
      const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId, 'gate');
      const { stage, expectedMobile } = await seedRuntimePinGate(fixture);
      const { task, attempt, profile } = fixture.identity;
      const activeTx = action === 'GATE' ? await seedRuntimePinOpenTx(fixture) : null;
      const readEvents = async () => (await fs.readdir(stage))
        .filter((name) => /^event\./u.test(name)).sort();

      await configureDecisionApi(installed, fixture);
      await installed.ctl(['server', 'start', '--wait']);

      const before = await readEvents();
      const lease = await engineLeaseSnapshot(installed, [packageId]);
      const endpoint = action === 'GATE' ? 'gate/GATE_PLAN/approve' : 'stage/GATE_PLAN/running';
      const result = await installed.api(`/api/tasks/${task}/${endpoint}`, {
        attempt,
        profile,
        expectedMobile,
        comment: 'Проверка штатного решения',
      }, 90_000);

      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.notDeepEqual(await engineLeaseSnapshot(installed, [packageId]), lease);

      const after = await readEvents();
      const event = JSON.parse(await fs.readFile(path.join(stage, after.at(-1)!), 'utf8'));
      const pin = await readExistingFactoryRuntimePin(fixture.identity);

      assert.equal(after.length, before.length + 1);
      assert.equal(event.node, 'gate_plan');

      if (activeTx) {
        assert.equal(event.outcome, 'approved');
        assert.match(await fs.readFile(activeTx, 'utf8'), /^STATE=active$/mu);
      } else {
        assert.equal(event.kind, 'human-rewind');
      }

      assert.equal(pin?.node, fixture.runtime.node);
      assert.equal(pin?.engineBin, fixture.runtime.engineBin);
      assert.equal(pin?.packageId, packageId);
      await writeMacRuntimePinWitness(id, barrier);
    });
  }

  for (const boundary of ['REGISTRY-REF', 'AUTHORITY'] as const) {
    const barrier = 'MIGRATION-AFTER-' + boundary;
    const id = 'MAC-VERIFY-PIN-' + barrier;

    await t.test(id, async (testCase) => {
      const box = await platformFixture(testCase, 'server');

      await box.install(input.previous);

      const previous = await box.state('current.json');
      const runtimeA = await prepareRuntime(box, path.join(box.root, previous.server, 'bin/grigdesk-server'));
      const directory = await fs.mkdtemp(path.join(box.homeRoot, 'migration-'));
      const fixture = await macosRuntimePinFixture(directory, runtimeA.runtimeRoot,
        runtimeA.packageId, 'gate');
      const { stage, pipeline, expectedMobile } = await seedRuntimePinGate(fixture);
      const { task, attempt, profile, controlRoot, stateRoot, cacheDir } = fixture.identity;
      const scope = factoryRuntimeScope(fixture.identity);
      const authority = path.join(controlRoot, 'server-runtimes', scope, `${attempt}.json`);
      const index = path.join(cacheDir, 'attempt-pins', scope, `${attempt}.json`);
      const intent = path.join(controlRoot, 'runtime-migration-intents', `t${task}`, `${attempt}.json`);
      const blocked = path.dirname(boundary === 'AUTHORITY' ? index : authority);
      const requestGate = () => box.api(`/api/tasks/${task}/gate/GATE_PLAN/approve`, {
        task,
        profile,
        attempt,
        expectedMobile,
      }, 90_000);

      await configureDecisionApi(box, fixture);
      await box.ctl(['server', 'start', '--wait']);
      assert.equal((await box.api('/api/system/runtime-identity')).body.productVersion, versions.previous);

      const events = (await fs.readdir(stage)).sort();
      const state = await fs.readFile(pipeline);

      await fs.mkdir(blocked, { mode: 0o700, recursive: true });
      await fs.chmod(blocked, 0o500);

      try {
        const refused = await requestGate();

        assert.equal(refused.status, 409, JSON.stringify(refused.body));
        assert.equal(refused.body.error, 'factory_runtime_pin_invalid');

        const saved = await fs.readFile(intent);
        const { pin } = JSON.parse(saved.toString('utf8'));
        const registry = await readRuntimeRootRegistry(cacheDir);
        const refs = registry.roots.flatMap((record) => record.references)
          .filter((ref) => ref.scope === scope && ref.attempt === attempt);

        assert.equal(refs.length, 1);
        assert.equal(refs[0]?.packageId, runtimeA.packageId);
        assert.equal(pin.packageId, runtimeA.packageId);
        assert.equal(pin.engineBin, fixture.runtime.engineBin);
        assert.equal(pin.node, fixture.runtime.node);
        await assert.rejects(fs.lstat(index), { code: 'ENOENT' });

        if (boundary === 'AUTHORITY') {
          assert.deepEqual(JSON.parse(await fs.readFile(authority, 'utf8')), pin);
        } else {
          await assert.rejects(fs.lstat(authority), { code: 'ENOENT' });
        }

        const leases = await engineLeaseSnapshot(box, [runtimeA.packageId]);
        const raw = [fixture.runtime.engineBin, task, 'gate', '--profile', profile, '--attempt', attempt,
          '--node', 'gate_plan', '--decision', 'approved', '--commit-only', '--routes-dir', fixture.routes,
          '--state-dir', stateRoot, '--control-dir', controlRoot];

        await assert.rejects(execute(fixture.env.FACTORY_DARWIN_BASH!, raw, {
          env: fixture.env,
          timeout: 20_000,
        }), (error: { code?: number; stderr?: string }) => error.code === 75
          && /^FACTORY_ERROR=factory_runtime_pin_migration_pending$/mu.test(error.stderr ?? ''));

        for (const method of ['resume', 'runtime-rebind']) {
          const pending = await box.api(`/api/tasks/${task}/${method}`, { profile, attempt }, 30_000);

          assert.equal(pending.status, 409, JSON.stringify(pending.body));
          assert.equal(pending.body.error, 'factory_runtime_pin_migration_pending');
        }

        assert.deepEqual(await engineLeaseSnapshot(box, [runtimeA.packageId]), leases);
        assert.deepEqual(await fs.readFile(intent), saved);
        assert.deepEqual(await fs.readFile(pipeline), state);
        assert.deepEqual((await fs.readdir(stage)).sort(), events);

        await box.ctl(['server', 'stop']);
        await box.install(input.candidate);
        await box.ctl(['server', 'resume-update', '--restart', '--json']);
        await box.ctl(['server', 'start', '--wait']);
        assert.equal((await box.api('/api/system/runtime-identity')).body.productVersion, versions.current);
        assert.deepEqual(await fs.readFile(intent), saved);

        await fs.chmod(blocked, 0o700);

        const retry = await requestGate();

        assert.equal(retry.status, 200, JSON.stringify(retry.body));
        assert.deepEqual(await readExistingFactoryRuntimePin(fixture.identity), pin);
        assert.deepEqual(JSON.parse(await fs.readFile(index, 'utf8')), pin);
        await assert.rejects(fs.lstat(intent), { code: 'ENOENT' });
        assert.equal((await fs.readdir(stage)).length, events.length + 1);
        await writeMacRuntimePinWitness(id, barrier);
      } finally {
        await fs.chmod(blocked, 0o700);
      }
    });
  }

  await t.test('MAC-VERIFY-PIN-GC-BEFORE-FIRST-REF', async (testCase) => {
    for (const protect of [true, false]) {
      const box = await platformFixture(testCase, 'server');

      await box.install(input.candidate);

      const current = await box.state('current.json');
      const binaryB = path.join(box.root, current.server, 'bin/grigdesk-server');
      const runtimeB = await prepareRuntime(box, binaryB);
      const runtimeA = await prepareRuntime(box, binary);
      const directory = await fs.mkdtemp(path.join(box.homeRoot, 'unreferenced-pin-'));
      const fixture = await macosRuntimePinFixture(directory, runtimeA.runtimeRoot,
        runtimeA.packageId, 'gate');
      const { cacheDir, task, attempt, profile, controlRoot } = fixture.identity;
      const scope = factoryRuntimeScope(fixture.identity);
      const env = { ...box.env, GRIGDESK_HOME: box.dataHome };
      const run = (file: string, args: string[]) => execute(file, args, { env, timeout: 120_000 });

      assert.notEqual(runtimeA.packageId, runtimeB.packageId);
      await run(binary, ['--release-preparation', runtimeA.preparationToken,
        '--package-id', runtimeA.packageId, '--json']);
      await fs.writeFile(path.join(cacheDir, 'state/usage.json'), JSON.stringify({
        format: 1,
        current: runtimeB.packageId,
        previous: null,
        lastUsed: { [runtimeA.packageId]: Date.now() - 8 * 86_400_000, [runtimeB.packageId]: Date.now() },
      }), { mode: 0o600 });

      const registry = () => readRuntimeRootRegistry(cacheDir);

      assert.ok((await registry()).roots.every((entry) => factoryRuntimeScope(entry) !== scope));

      if (!protect) {
        const control = JSON.parse((await run(binaryB, ['--cache-prune', '--json'])).stdout);

        assert.ok(control.deleted.includes(runtimeA.packageId), JSON.stringify(control));
        await assert.rejects(fs.lstat(runtimeA.runtimeRoot), { code: 'ENOENT' });

        continue;
      }

      await interruptPackagedWriter(fixture, 'intent');

      const registered = (await registry()).roots.find((entry) => factoryRuntimeScope(entry) === scope);
      const intent = path.join(controlRoot, 'runtime-migration-intents', `t${task}`, `${attempt}.json`);
      const authority = path.join(controlRoot, 'server-runtimes', scope, `${attempt}.json`);
      const { pin } = JSON.parse(await fs.readFile(intent, 'utf8'));

      assert.deepEqual(registered?.references, []);
      assert.equal(pin.packageId, runtimeA.packageId);
      await assert.rejects(fs.lstat(authority), { code: 'ENOENT' });

      const result = JSON.parse((await run(binaryB, ['--cache-prune', '--json'])).stdout);

      assert.ok(result.retained.some((row: { packageId: string; reason: string }) =>
        row.packageId === runtimeA.packageId && row.reason === 'pending-migration'), JSON.stringify(result));
      assert.ok((await fs.stat(runtimeA.runtimeRoot)).isDirectory());

      const { stage, expectedMobile } = await seedRuntimePinGate(fixture);

      await configureDecisionApi(box, fixture);
      await box.ctl(['server', 'start', '--wait']);

      const events = (await fs.readdir(stage)).length;
      const gate = await box.api(`/api/tasks/${task}/gate/GATE_PLAN/approve`, {
        attempt,
        profile,
        expectedMobile,
      }, 90_000);

      assert.equal(gate.status, 200, JSON.stringify(gate.body));
      assert.deepEqual(await readExistingFactoryRuntimePin(fixture.identity), pin);
      assert.equal((await fs.readdir(stage)).length, events + 1);
      await assert.rejects(fs.lstat(intent), { code: 'ENOENT' });
    }

    await writeMacRuntimePinWitness('MAC-VERIFY-PIN-GC-BEFORE-FIRST-REF', 'GC-BEFORE-FIRST-REF');
  });

  for (const lock of ['gc', 'package'] as const) {
    for (const [name, phase, canonical] of [
      ['RECLAIM-BEFORE-RENAME', 'retire-before-rename', 'dead'],
      ['RECLAIM-AFTER-RENAME', 'retire-after-rename', 'absent'],
      ['LOCK-CANCEL-BEFORE-PUBLISH', 'publish-before-rename', 'absent'],
      ['LOCK-CANCEL-AFTER-PUBLISH', 'publish-after-rename', 'dead'],
    ] as const) {
      const barrier = lock.toUpperCase() + '-' + name;
      const id = 'MAC-VERIFY-PIN-' + barrier;

      await t.test(id, async (testCase) => {
        testCase.after(async () => {
          await installed.ctl(['server', 'stop']);
        });

        const directory = await fs.mkdtemp(path.join(installed.homeRoot, 'reclaim-'));
        const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId, 'gate');
        const { stage, pipeline, expectedMobile } = await seedRuntimePinGate(fixture);
        const { task, attempt, profile, cacheDir, controlRoot } = fixture.identity;
        const locks = path.join(cacheDir, '.locks');
        const scope = factoryRuntimeScope(fixture.identity);
        const lockPath = path.join(locks, lock === 'gc' ? 'gc' : packageId);
        const sibling = path.join(locks, 'witness-' + path.basename(directory));
        const authority = path.join(controlRoot, 'server-runtimes', scope, `${attempt}.json`);
        const intent = path.join(controlRoot, 'runtime-migration-intents', `t${task}`, `${attempt}.json`);

        await configureDecisionApi(installed, fixture);
        await installed.ctl(['server', 'start', '--wait']);
        await fs.writeFile(sibling, 'independent', { mode: 0o600, flag: 'wx' });
        await interruptPackagedWriter(fixture, 'intent');
        assert.equal(await directoryLockState(lockPath), 'dead');

        const original = await fs.readFile(intent);
        const events = (await fs.readdir(stage)).sort();
        const state = await fs.readFile(pipeline);
        const dead = await fs.lstat(lockPath, { bigint: true });

        await interruptPackagedWriter(fixture, phase, lock);
        assert.equal(await directoryLockState(lockPath), canonical);

        if (phase === 'retire-before-rename') {
          assert.equal((await fs.lstat(lockPath, { bigint: true })).ino, dead.ino);
        } else if (phase === 'publish-after-rename') {
          assert.notEqual((await fs.lstat(lockPath, { bigint: true })).ino, dead.ino);
        }

        assert.deepEqual(await fs.readFile(intent), original);
        assert.deepEqual(await fs.readFile(pipeline), state);
        assert.deepEqual((await fs.readdir(stage)).sort(), events);
        await assert.rejects(fs.lstat(authority), { code: 'ENOENT' });

        const retry = await installed.api(`/api/tasks/${task}/gate/GATE_PLAN/approve`, {
          attempt,
          profile,
          expectedMobile,
        }, 90_000);

        assert.equal(retry.status, 200, JSON.stringify(retry.body));

        const saved = JSON.parse(original.toString()).pin;

        assert.deepEqual(await readExistingFactoryRuntimePin(fixture.identity), saved);
        assert.equal(await directoryLockState(lockPath), 'absent');
        assert.equal(await fs.readFile(sibling, 'utf8'), 'independent');
        assert.equal((await fs.readdir(stage)).length, events.length + 1);
        await assert.rejects(fs.lstat(intent), { code: 'ENOENT' });
        await writeMacRuntimePinWitness(id, barrier);
      });
    }
  }

  await t.test('MAC-VERIFY-PIN-WRITER-TIMEOUT', async (testCase) => {
    testCase.after(async () => {
      await installed.ctl(['server', 'stop']);
    });

    const directory = await fs.mkdtemp(path.join(installed.homeRoot, 'writer-timeout-'));
    const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId, 'gate');
    const { stage, pipeline, expectedMobile } = await seedRuntimePinGate(fixture);
    const { task, attempt, profile, cacheDir, controlRoot } = fixture.identity;
    const scope = factoryRuntimeScope(fixture.identity);
    const trace = path.join(directory, 'writer-timeout.json');
    const helper = path.join(runtimeRoot, 'server/runtime/helpers/factory-runtime-pin.mjs');
    const authority = path.join(controlRoot, 'server-runtimes', scope, `${attempt}.json`);
    const intent = path.join(controlRoot, 'runtime-migration-intents', `t${task}`, `${attempt}.json`);
    const request = () => installed.api(`/api/tasks/${task}/gate/GATE_PLAN/approve`, {
      attempt,
      profile,
      expectedMobile,
    }, 95_000);

    await configureDecisionApi(installed, fixture);
    await installed.ctl(['server', 'start', '--wait']);

    const events = (await fs.readdir(stage)).sort();
    const state = await fs.readFile(pipeline);
    const started = performance.now();
    const refused = await withRuntimePinFault(helper, (backup) => `
      import { writeFile } from 'node:fs/promises';
      import { spawnSync } from 'node:child_process';
      import { pathToFileURL } from 'node:url';
      const args = process.argv.splice(2);
      const { main } = await import(pathToFileURL(${JSON.stringify(backup)}).href);
      process.exitCode = await main(args, (input, write) => write({
        ...input,
        checkpoint: async (step) => {
          if (step !== 'registry') return;
          const helper = process.env.FACTORY_DARWIN_PROCESS_HELPER;
          const chain = [];
          let pid = process.pid;
          for (let depth = 0; depth < 3; depth += 1) {
            const probe = spawnSync(helper, ['identity', String(pid)], { encoding: 'utf8', timeout: 3000 });
            if (probe.status !== 0) throw new Error('fixture_process_unknown');
            const owner = JSON.parse(probe.stdout);
            chain.push(owner);
            pid = owner.ppid;
          }
          await writeFile(${JSON.stringify(trace)}, JSON.stringify({ step, chain }), {
            flag: 'wx', mode: 0o600,
          });
          input.signal.throwIfAborted();
          await new Promise((resolve, reject) => {
            const timer = setInterval(() => {}, 1000);
            input.signal.addEventListener('abort', () => {
              clearInterval(timer);
              reject(input.signal.reason);
            }, { once: true });
          });
        },
      }));
    `, request);

    assert.equal(refused.status, 504, JSON.stringify(refused.body));
    assert.equal(refused.body.error, 'engine_timeout');
    assert.ok(performance.now() - started < 75_000);

    const { step, chain } = JSON.parse(await fs.readFile(trace, 'utf8'));

    assert.equal(step, 'registry');
    assert.equal(chain.length, 3);

    for (const owner of chain) {
      const live = await readDarwinProcessIdentity(owner.pid);

      assert.ok(live.state === 'dead'
        || live.state === 'alive' && live.identity.starttime !== owner.starttime);
    }

    await assert.rejects(fs.lstat(authority), { code: 'ENOENT' });

    const { pin } = JSON.parse(await fs.readFile(intent, 'utf8'));
    const registry = await readRuntimeRootRegistry(cacheDir);

    assert.equal(pin.packageId, packageId);
    assert.equal(registry.roots.flatMap((entry) => entry.references)
      .filter((ref) => ref.scope === scope && ref.attempt === attempt).length, 1);
    assert.deepEqual(await fs.readFile(pipeline), state);
    assert.deepEqual((await fs.readdir(stage)).sort(), events);

    const lock = path.join(controlRoot, 'protocol-v2/orchestrators', `t${task}.lock`);
    const released = await holdRuntimePinTaskLock(testCase, fixture, lock);

    await released();
    assert.equal(await directoryLockState(path.join(cacheDir, '.locks/gc')), 'absent');
    assert.equal(await directoryLockState(path.join(cacheDir, '.locks', packageId)), 'absent');

    const retry = await request();

    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.deepEqual(await readExistingFactoryRuntimePin(fixture.identity), pin);
    await assert.rejects(fs.lstat(intent), { code: 'ENOENT' });
    assert.equal((await fs.readdir(stage)).length, events.length + 1);
    await writeMacRuntimePinWitness('MAC-VERIFY-PIN-WRITER-TIMEOUT', 'WRITER-TIMEOUT');
  });

  const readBarriers = ['GATE-CATALOG-TIMEOUT', 'GATE-PENDING-READ-TIMEOUT', 'GATE-FOREGROUND-INT'] as const;

  for (const barrier of readBarriers) {
    const id = 'MAC-VERIFY-PIN-' + barrier;

    await t.test(id, async (testCase) => {
      const pendingRead = barrier === 'GATE-PENDING-READ-TIMEOUT';
      const foreground = barrier === 'GATE-FOREGROUND-INT';
      const directory = await fs.mkdtemp(path.join(installed.homeRoot, 'read-boundary-'));
      const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId, 'gate');
      const { stage, pipeline, expectedMobile } = await seedRuntimePinGate(fixture);
      const { identity, runtime } = fixture;
      const { task, attempt, profile, stateRoot, controlRoot, cacheDir } = identity;
      const scope = factoryRuntimeScope(identity);
      const receipt = pendingRead ? await seedRuntimePinStopRecord(fixture, false) : null;

      testCase.after(async () => {
        if (receipt) {
          await fs.rm(receipt.file, { force: true });
        }

        await installed.ctl(['server', 'stop']);
      });

      const fault = await prepareReadBarrier(directory, pendingRead ? 'pending' : 'catalog');
      const relative = pendingRead ? 'lib/darwin-decision-read.sh' : 'bin/factory-route';
      const file = path.join(runtime.engineHome, relative);
      const hook = '  record=$(_instrumentation_tx_finalization_read "$task" "$attempt")\n  rc=$?\n';
      const request = () => installed.api(`/api/tasks/${task}/gate/GATE_PLAN/approve`, {
        attempt,
        profile,
        expectedMobile,
      }, 120_000);

      await configureDecisionApi(installed, fixture);
      await installed.ctl(['server', 'start', '--wait']);

      const events = (await fs.readdir(stage)).sort();
      const stable = await fs.readFile(pipeline);
      const input = await fs.readFile(file, 'utf8');

      if (pendingRead) {
        assert.ok(input.includes(hook));
        assert.match(fault.file, /^\/[\w./-]+$/u);
      }

      const started = performance.now();
      const owner = await withRuntimePinFault(file, (original) => pendingRead
        ? input.replace(hook, hook + `  "$NODE_BIN" '${fault.file}' "$record" || exit $?\n`)
        : `#!${runtime.node}
          const args = process.argv.slice(2);
          if (args.includes('catalog') && args.includes(${JSON.stringify(fixture.routes)})) {
            process.execve(process.execPath, [process.execPath, ${JSON.stringify(fault.file)}, '"catalog"'],
              process.env);
          } else {
            process.execve(${JSON.stringify(original)}, [${JSON.stringify(original)}, ...args], process.env);
          }
        `, async () => {
        if (!foreground) {
          const [result, observed] = await Promise.all([request(), fault.observed()]);

          assert.equal(result.status, 504, JSON.stringify(result.body));
          assert.equal(result.body.error, 'engine_timeout');

          return observed;
        }

        const raw = [runtime.engineBin, task, 'gate', '--profile', profile, '--attempt', attempt,
          '--node', 'gate_plan', '--decision', 'approved', '--commit-only', '--routes-dir', fixture.routes,
          '--state-dir', stateRoot, '--control-dir', controlRoot];
        const engine = spawn(fixture.env.FACTORY_DARWIN_BASH!, raw, {
          env: fixture.env,
          stdio: 'ignore',
          signal: AbortSignal.timeout(45_000),
        });
        const closed = once(engine, 'close');

        try {
          const observed = await fault.observed();

          assert.ok(engine.kill('SIGINT'));
          assert.deepEqual(await closed, [130, null]);

          return observed;
        } finally {
          await closed;
        }
      });

      assert.ok(performance.now() - started < (foreground ? 35_000 : 105_000));

      const identityAfter = await readDarwinProcessIdentity(owner.pid);
      const lock = path.join(controlRoot, 'protocol-v2/orchestrators', `t${task}.lock`);
      const taskRoot = path.join(controlRoot, 'protocol-v2/tasks', `t${task}`);
      const intent = path.join(controlRoot, 'runtime-migration-intents', `t${task}`, `${attempt}.json`);

      assert.ok(identityAfter.state === 'dead'
        || identityAfter.state === 'alive' && identityAfter.identity.starttime !== owner.starttime);
      assert.deepEqual(await fs.readFile(pipeline), stable);
      assert.deepEqual((await fs.readdir(stage)).sort(), events);
      assert.equal(await readExistingFactoryRuntimePin(identity), null);
      await assert.rejects(fs.lstat(intent), { code: 'ENOENT' });

      for (const exact of [lock, taskRoot]) {
        const release = await holdRuntimePinTaskLock(testCase, fixture, exact);

        await release();
      }

      assert.equal(await directoryLockState(path.join(cacheDir, '.locks/gc')), 'absent');
      assert.equal(await directoryLockState(path.join(cacheDir, '.locks', packageId)), 'absent');
      assert.equal(await directoryLockState(path.join(cacheDir, '.locks', scope)), 'absent');

      if (receipt) {
        const stillPending = await request();

        assert.equal(stillPending.status, 409, JSON.stringify(stillPending.body));
        assert.equal(stillPending.body.error, 'release_task_cleanup_required');
        await receipt.finish();
      }

      const retry = await request();

      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.equal((await fs.readdir(stage)).length, events.length + 1);
      assert.equal((await readExistingFactoryRuntimePin(identity))?.packageId, packageId);
      await writeMacRuntimePinWitness(id, barrier);
    });
  }

  await t.test('MAC-VERIFY-PIN-AUTO-UNPIN', async (testCase) => {
    const box = await platformFixture(testCase, 'server');

    await box.install(input.candidate);

    const current = await box.state('current.json');
    const runtimeB = await prepareRuntime(box, path.join(box.root, current.server, 'bin/grigdesk-server'));
    const runtimeA = await prepareRuntime(box, binary);
    const directory = await fs.mkdtemp(path.join(box.homeRoot, 'incompatible-runner-'));
    const fixture = await macosRuntimePinFixture(directory, runtimeA.runtimeRoot, runtimeA.packageId, 'gate');
    const { stage } = await seedRuntimePinGate(fixture);
    const { profileRoot, task, attempt, profile, cacheDir, controlRoot } = fixture.identity;
    const scope = factoryRuntimeScope(fixture.identity);
    const runners = path.join(directory, 'runners');
    const profileFile = path.join(profileRoot, profile, 'profile.sh');
    const probes = path.join(directory, 'probe-processes');
    const inject = path.join(directory, 'inject-intent');
    const creator = path.join(directory, 'publish-intent.mjs');
    const authority = path.join(controlRoot, 'server-runtimes', scope, `${attempt}.json`);
    const index = path.join(cacheDir, 'attempt-pins', scope, `${attempt}.json`);
    const intent = path.join(controlRoot, 'runtime-migration-intents', `t${task}`, `${attempt}.json`);

    assert.notEqual(runtimeA.packageId, runtimeB.packageId);
    await fs.mkdir(runners, { mode: 0o700 });

    for (const file of [runners, probes, inject, creator]) {
      assert.match(file, /^\/[\w./-]+$/u);
    }

    await fs.appendFile(profileFile, `export FACTORY_RUNNERS_DIR='${runners}'\n`);
    await fs.writeFile(path.join(profileRoot, profile, 'runners.env'), [
      'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'RUNNERS_COVERAGE=required', 'PROJECT_RUNNER_PRIMARY=alpha',
      'MODEL_DEFAULT_ALPHA_EXACT=alpha-model', 'MODEL_DEFAULT_ALPHA_EFFORT=high', '',
    ].join('\n'), { mode: 0o600 });

    const alpha = path.join(runners, 'alpha.sh');
    const source = new URL('../engine/fakes/runners/alpha.sh', import.meta.url);

    await fs.copyFile(source, alpha);
    await fs.appendFile(alpha, `
runner_alpha_probe() {
  printf '%s\\n' "$NODE_BIN" >> '${probes}' || return 78
  if [[ -f '${inject}' ]]; then
    "$NODE_BIN" '${creator}' || return 78
  fi
  printf '%s\\n' 'RUNNER_SUPPLY_INCOMPATIBLE=alpha' >&2
  return 4
}
runner_alpha_run() { return 78; }
`);

    const committed = await fixture.commit();

    assert.equal(committed.code, 0, committed.stderr);

    const old = await readExistingFactoryRuntimePin(fixture.identity);
    const { attemptSha256 } = JSON.parse(fixture.context);
    const pendingRecord = JSON.stringify({
      format: 1,
      attemptSha256,
      pin: old,
    });

    assert.equal(old?.packageId, runtimeA.packageId);
    await fs.writeFile(creator, `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      const file = ${JSON.stringify(intent)};
      const directory = path.dirname(file);
      await fs.mkdir(directory, { mode: 0o700, recursive: true });
      const record = await fs.open(file, 'wx', 0o600);
      try {
        await record.writeFile(${JSON.stringify(pendingRecord)});
        await record.sync();
      } finally {
        await record.close();
      }
      const parent = await fs.open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    `, { mode: 0o600 });
    await fs.writeFile(inject, '', { mode: 0o600 });
    await configureDecisionApi(box, fixture);
    await box.ctl(['server', 'start', '--wait']);

    const snapshot = () => Promise.all([authority, index, path.join(cacheDir, 'state/control-roots.json')]
      .map((file) => fs.readFile(file)));
    const before = await snapshot();
    const events = (await fs.readdir(stage)).sort();
    const request = () => box.api(`/api/tasks/${task}/resume`, { attempt, profile }, 100_000);

    await assert.rejects(fs.lstat(intent), { code: 'ENOENT' });

    const refused = await request();

    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, 'factory_runtime_pin_migration_pending');
    assert.equal(await fs.readFile(probes, 'utf8'), fixture.runtime.node + '\n');
    assert.deepEqual(JSON.parse(await fs.readFile(intent, 'utf8')).pin, old);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await fs.readdir(stage)).sort(), events);

    await fs.unlink(inject);
    await fs.unlink(intent);

    const triedAgain = await request();

    assert.equal(triedAgain.status, 500, JSON.stringify(triedAgain.body));
    assert.equal(triedAgain.body.error, 'runner_preflight_incompatible');
    assert.deepEqual((await fs.readFile(probes, 'utf8')).trim().split('\n'), [
      fixture.runtime.node, fixture.runtime.node, path.join(runtimeB.runtimeRoot, 'runtime/node/bin/node'),
    ]);
    assert.equal((await readExistingFactoryRuntimePin(fixture.identity))?.packageId, runtimeB.packageId);
    assert.deepEqual((await fs.readdir(stage)).sort(), events);
    await writeMacRuntimePinWitness('MAC-VERIFY-PIN-AUTO-UNPIN', 'AUTO-UNPIN');
  });
});
