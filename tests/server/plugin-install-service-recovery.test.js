import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { writeDurableFile } from '../../server/src/lib/durableFile.ts';
import { PluginInstallService } from '../../server/src/lib/pluginInstall/service.ts';
import { liveGroupMembers } from '../../server/src/lib/pluginInstall/workerIdentity.ts';
import { createPluginRepo } from './helpers/pluginRepo.js';
import { serviceFixture } from './helpers/pluginServiceFixture.js';
import { createApplyFixture } from './helpers/pluginApplyFixture.js';
import { runApplyChild } from './helpers/pluginApplyProcess.js';
import { installJob } from './helpers/pluginInstallState.js';

/**
 * Новый service instance получает те же config roots после release первого owner.
 * Старые runtime bindings и mutable cache при этом не наследуются.
 */
async function successor(fixture, use) {
  const next = new PluginInstallService(fixture.service.options);

  try {
    return await use(next);
  } finally {
    await next.close();
  }
}

test('M23-ready: recovery делает ready interrupted и убирает только подтверждённое staging', async (t) => {
  const repo = await createPluginRepo(t);

  await repo.release('1.0.0');

  const fixture = await serviceFixture(t);

  await fixture.service.startInstall({ url: repo.url });
  await fixture.service.whenIdle();

  const job = await fixture.service.currentJob();
  const unknown = path.join(fixture.service.workDir, 'jobs/unrelated-preserve');

  assert.equal(job.status, 'ready');
  await mkdir(unknown);
  await writeFile(path.join(unknown, 'marker'), 'preserve');
  await fixture.service.close();
  await successor(fixture, async (next) => {
    assert.deepEqual((await next.recover()).blockedIds, []);

    const recovered = await next.currentJob();

    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.error.code, 'interrupted');
    assert.ok(recovered.finishedAt);
    assert.equal(await lstat(path.join(next.workDir, 'jobs', job.id)).catch(() => null), null);
    assert.equal(await readFile(path.join(unknown, 'marker'), 'utf8'), 'preserve');
    assert.equal((await next.store.read()).completedJobs[job.id].status, 'interrupted');
    assert.equal((await next.recover()).error, null);
    assert.equal((await next.currentJob()).revision, recovered.revision);
  });
});

test('M23-running: валидный interrupted outcome публикуется до индивидуальной cleanup', async (t) => {
  const job = installJob('running');
  const fixture = await serviceFixture(t, {
    seed: async ({ service }) => {
      await service.store.mutate((state) => {
        state.job = job;
        state.nextRevision = 2;
      });
      await mkdir(path.join(service.workDir, 'jobs', job.id, 'package'), { recursive: true });
      await writeFile(path.join(service.workDir, 'jobs', job.id, 'package/plugin.json'), '{}');
    },
  });

  assert.equal((await fixture.service.currentJob()).status, 'interrupted');
  assert.equal((await fixture.service.store.read()).completedJobs[job.id].status, 'interrupted');
  assert.equal(await lstat(path.join(fixture.service.workDir, 'jobs', job.id)).catch(() => null), null);
});

test('M23-crash: native worker после SIGKILL owner завершён до staging cleanup новым service', async (t) => {
  const repo = await createPluginRepo(t);

  await repo.release('1.0.0', {
    files: {
      'package.json': '{"name":"fixture","version":"1.0.0"}',
      'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}',
    },
  });

  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-service-crash-'));
  const options = {
    pluginsDir: path.join(root, 'plugins'),
    statePath: path.join(root, 'state/install.json'),
    cockpitVersion: '1.0.0',
    reservedIds: [],
  };

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(options.pluginsDir);

  const script = fileURLToPath(new URL('./fixtures/plugin-service-owner.mjs', import.meta.url));
  const child = fork(script, [JSON.stringify({ options, url: repo.url })], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const exit = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  let held;

  try {
    [held] = await once(child, 'message');
    assert.equal(held.type, 'held');
    assert.equal(Object.keys(held.workers).length, 1);
    child.kill('SIGKILL');
    assert.equal((await exit)[1], 'SIGKILL');
  } finally {
    clearTimeout(timer);

    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }

  const next = new PluginInstallService(options);
  let confirmedDrain = false;
  let confirmedOutcome = false;

  next.store.options.write = async (file, text) => {
    const state = JSON.parse(text);

    if (Object.keys(state.workers).length === 0) {
      for (const worker of Object.values(held.workers)) {
        assert.deepEqual(await liveGroupMembers(worker.pgid), [],
          'durable worker removal после native drain');
      }

      confirmedDrain = true;
    }

    if (state.job.status === 'interrupted' && !confirmedOutcome) {
      assert.equal((await lstat(path.join(next.workDir, 'jobs', held.jobId))).isDirectory(), true);
      confirmedOutcome = true;
    }

    await writeDurableFile(file, text);
  };

  try {
    assert.deepEqual((await next.recover()).blockedIds, []);
    assert.equal((await next.currentJob()).status, 'interrupted');
    assert.equal(confirmedDrain, true);
    assert.equal(confirmedOutcome, true);
    assert.deepEqual((await next.store.read()).workers, {});

    for (const worker of Object.values(held.workers)) {
      assert.deepEqual(await liveGroupMembers(worker.pgid), []);
    }

    assert.equal(await lstat(path.join(next.workDir, 'jobs', held.jobId)).catch(() => null), null);
  } finally {
    await next.close();
  }
});

/**
 * Service config для transaction fixture включает production nested work layout.
 * Close заблокированного fixture допускает только release его собственного fd при teardown.
 */
async function recoverFixture(fixture, use) {
  const service = new PluginInstallService({
    pluginsDir: fixture.roots.pluginsDir,
    statePath: fixture.statePath,
    cockpitVersion: '1.0.0',
    reservedIds: [],
  });

  try {
    return await use(service);
  } finally {
    try {
      await service.close();
    } catch (error) {
      assert.equal(['recovery_required', 'state_invalid'].includes(error.code), true);
      await service.owner?.release();
    }
  }
}

test('M24-complete: crash после candidate rename восстанавливается service; committed done остаётся done',
  async (t) => {
    const probe = await createApplyFixture(t, { kind: 'update', workInside: true });
    const result = await runApplyChild(probe);
    const renames = result.trace.map((label, index) => ({ label, index }))
      .filter((entry) => entry.label === 'after:rename');
    const crashAt = renames[1].index;
    const fixture = await createApplyFixture(t, { kind: 'update', workInside: true });

    await runApplyChild(fixture, { barrierAt: crashAt });
    await recoverFixture(fixture, async (service) => {
      assert.deepEqual((await service.recover()).blockedIds, []);
      assert.equal((await service.currentJob()).status, 'done');
      assert.equal((await service.store.read()).plugins.demo.version, '1.1.0');
      assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'new');
      assert.equal(await readFile(path.join(fixture.previous, 'marker.txt'), 'utf8'), 'old');
    });
    await recoverFixture(fixture, async (service) => {
      assert.deepEqual((await service.recover()).blockedIds, []);
      assert.equal((await service.currentJob()).status, 'done');
      assert.equal((await service.store.read()).apply, null);
    });
  });

test('M24-blocked: unknown current сохраняет intent/copies и блокирует конкретный id', async (t) => {
  const fixture = await createApplyFixture(t, { kind: 'update', workInside: true });

  await fixture.store.mutate((state) => {
    state.job.status = 'applying';
    state.apply = fixture.intent;
  });
  await writeFile(path.join(fixture.current, 'marker.txt'), 'unknown current changes');

  const bytes = await readFile(path.join(fixture.candidate, 'marker.txt'), 'utf8');

  await recoverFixture(fixture, async (service) => {
    assert.deepEqual((await service.recover()).blockedIds, ['demo']);
    assert.equal(service.health().code, 'recovery_required');
    assert.equal((await service.currentJob()).status, 'recovery_required');
    assert.ok((await service.store.read()).apply);
    assert.equal(await readFile(path.join(fixture.candidate, 'marker.txt'), 'utf8'), bytes);
    assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'unknown current changes');
    await assert.rejects(service.startInstall({ url: 'file:///fixture.git' }), { code: 'recovery_required' });
  });
});

test('M24-orphan: applying без intent/outcome не становится interrupted', async (t) => {
  const fixture = await createApplyFixture(t, { kind: 'update', workInside: true });

  await fixture.store.mutate((state) => {
    state.job.status = 'applying';
  });
  await recoverFixture(fixture, async (service) => {
    assert.deepEqual((await service.recover()).blockedIds, ['demo']);
    assert.equal((await service.currentJob()).status, 'recovery_required');
    assert.equal(await readFile(path.join(fixture.current, 'marker.txt'), 'utf8'), 'old');
    assert.equal(await readFile(path.join(fixture.candidate, 'marker.txt'), 'utf8'), 'new');
  });
});

test('M24-bad: damaged state блокирует всех без cleanup или обнуления исходного файла', async (t) => {
  const fixture = await createApplyFixture(t, { workInside: true });

  await writeFile(fixture.statePath, '{bad-json preserved');
  await recoverFixture(fixture, async (service) => {
    assert.equal((await service.recover()).blockedIds, '*');
    assert.equal(service.health().code, 'state_invalid');
    assert.equal(await readFile(fixture.statePath, 'utf8'), '{bad-json preserved');
    assert.equal(await readFile(path.join(fixture.candidate, 'marker.txt'), 'utf8'), 'new');
  });
});

test('M38: A17 committed и A19 precommit crash восстанавливаются новым service с исходным rollback receipt',
  async (t) => {
    for (const rollback of [false, true]) {
      const kind = rollback ? 'rollback' : 'install';
      const probe = await createApplyFixture(t, { kind, workInside: true });
      const trace = (await runApplyChild(probe)).trace;
      const event = rollback ? 'before:write:done' : 'after:write:done';
      const index = trace.indexOf(event);
      const fixture = await createApplyFixture(t, { kind, workInside: true });
      let input = null;

      assert.ok(index >= 0);

      if (rollback) {
        input = {
          requestId: fixture.intent.rollbackReceiptInput.requestId,
          expectedRevision: fixture.intent.baseRecord.revision,
          expectedPreviousDigest: fixture.intent.baseRecord.previous.payloadDigest,
        };
        fixture.intent.rollbackReceiptInput.inputHash = createHash('sha256')
          .update(JSON.stringify({ id: 'demo', ...input })).digest('hex');
      }

      await runApplyChild(fixture, { barrierAt: index });

      const crashed = await fixture.store.read();

      assert.equal(crashed.job.status, rollback ? 'applying' : 'done');
      assert.equal(crashed.lastRollback.demo === undefined, true);
      await recoverFixture(fixture, async (service) => {
        service.bindRuntime({
          isLoaded: () => false,
          prepareReplace: async () => ({ finish: async () => {} }),
          refresh: async () => {},
        });
        assert.deepEqual((await service.recover()).blockedIds, []);

        const disk = await service.store.read();
        const before = await readFile(fixture.statePath, 'utf8');

        assert.equal(disk.job.status, 'done');
        assert.equal(disk.completedJobs[fixture.intent.jobId].status, 'done');
        assert.equal(disk.plugins.demo.sha, fixture.intent.targetRecord.sha);
        assert.equal(disk.plugins.demo.installedAt, fixture.intent.targetRecord.installedAt);
        assert.equal(disk.apply, null);

        if (rollback) {
          assert.equal(disk.lastRollback.demo.requestId, input.requestId);
          assert.equal(disk.lastRollback.demo.inputHash, fixture.intent.rollbackReceiptInput.inputHash);
          assert.equal((await service.rollback('demo', input)).id, disk.job.id);
        } else {
          assert.equal((await service.apply(disk.job.id, disk.job.reviewToken)).id, disk.job.id);
        }

        assert.equal(await readFile(fixture.statePath, 'utf8'), before);
      });
    }
  });
