import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

import { applyInstalledUpdate, confirmInstalledUpdate, recoverInstalledUpdate }
  from '../../shared/node/installedUpdateApply.ts';
import { pruneCompletedUpdate } from '../../shared/node/installedUpdateCleanup.ts';
import { writeInstallationJson } from '../../shared/node/installedLayout.ts';
import { processOwnerState } from '../../shared/node/directoryLock.ts';
import { saveInstalledUpdate } from '../../shared/node/installedUpdateState.ts';
import type { UpdateApplyPorts } from '../../shared/node/installedUpdateApply.ts';
import { installedFixture } from '../helpers/installedUpdateFixture.mjs';

/**
 * Внешний процессный порт фиксирует эффекты, оставляя FS/journal/switch реальными.
 * Проверки живых PID и worker отдельно находятся в update-worker, не подменяются этим портом.
 */
function processPorts(publicKeyPem: string) {
  const calls: string[] = [];
  const ports: UpdateApplyPorts = {
    publicKeyPem,
    recheck: async () => {
      calls.push('recheck');
    },
    stop: async () => {
      calls.push('stop');
    },
    start: async (_job, rollback) => {
      calls.push(rollback ? 'rollback' : 'start');
    },
    prove: async (_job, rollback) => {
      calls.push(rollback ? 'old-proof' : 'new-proof');

      return 'running';
    },
  };

  return { calls, ports };
}

test('APPLY-CONSENT: ready и Позже не разрешают остановку или switch', async (t) => {
  const box = await installedFixture(t);
  const job = await box.create();
  const { calls, ports } = processPorts(box.release.publicKeyPem);

  await box.manager.prepare(job.id);
  await assert.rejects(applyInstalledUpdate(box.root, job.id, ports), /consent_required/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await box.pointer(), box.previous);
  assert.equal((await box.job())?.stage, 'ready');
  await box.preserved();
});

for (const reason of ['release_activity_unknown', 'release_drain_timeout', 'release_server_owner_changed']) {
  test(`APPLY-ACTIVITY/OWNER-RECHECK: ${reason} не разрешает stop`, async (t) => {
    const box = await installedFixture(t);
    const job = await box.create();
    const { calls, ports } = processPorts(box.release.publicKeyPem);

    await box.manager.prepare(job.id);
    await confirmInstalledUpdate(box.root, job.id);
    ports.recheck = async () => {
      throw new Error(reason);
    };

    await assert.rejects(applyInstalledUpdate(box.root, job.id, ports), { message: reason });
    assert.deepEqual(calls, []);
    assert.deepEqual(await box.pointer(), box.previous);
    assert.equal((await box.job())?.intent, null);
    assert.equal((await box.job())?.error?.nextAction, 'resume-update');
    await box.preserved();
  });
}

test('APPLY-ROLLBACK: отказ второго boot возвращает целую пару и сохраняет данные', async (t) => {
  const box = await installedFixture(t);
  const job = await box.create();
  const { calls, ports } = processPorts(box.release.publicKeyPem);

  await box.manager.prepare(job.id);
  await confirmInstalledUpdate(box.root, job.id);
  ports.prove = async (_job, rollback) => {
    assert.deepEqual(await box.pointer(), rollback ? job.previous : job.target);

    if (!rollback) {
      throw new Error('release_server_boot_proof_missing');
    }

    return 'running';
  };

  await assert.rejects(applyInstalledUpdate(box.root, job.id, ports), /server_boot_proof_missing/);
  assert.deepEqual(await box.pointer(), box.previous);
  assert.equal((await box.job())?.stage, 'rolled_back');
  assert.deepEqual(calls, ['recheck', 'stop', 'recheck', 'start', 'stop', 'rollback']);
  await box.preserved();
});

test('APPLY-ROLLBACK: отказ восстановления требует ручного действия, не completed', async (t) => {
  const box = await installedFixture(t);
  const job = await box.create();
  const { ports } = processPorts(box.release.publicKeyPem);

  await box.manager.prepare(job.id);
  await confirmInstalledUpdate(box.root, job.id);
  ports.prove = async () => {
    throw new Error('boot_failed');
  };

  await assert.rejects(applyInstalledUpdate(box.root, job.id, ports), /boot_failed/);
  assert.equal((await box.job())?.stage, 'manual_recovery_required');
  assert.equal((await box.job())?.error?.nextAction, 'resume-update');
  await box.preserved();
});

for (const stage of ['stopping', 'applying', 'starting'] as const) {
  for (const pointer of ['previous', 'target'] as const) {
    test(`RECOVERY-MATRIX: durable ${stage}/${pointer} восстанавливает один previous`, async (t) => {
      const box = await installedFixture(t);
      const created = await box.create();
      const { calls, ports } = processPorts(box.release.publicKeyPem);

      await box.manager.prepare(created.id);

      const job = await confirmInstalledUpdate(box.root, created.id);

      job.stage = stage;
      await saveInstalledUpdate(box.receipt, job);

      for (const component of ['desktop', 'server'] as const) {
        await fs.mkdir(path.join(box.root, path.dirname(job.target[component]!)), {
          recursive: true, mode: 0o700,
        });
        await fs.cp(path.join(box.root, 'update', job.id, component),
          path.join(box.root, job.target[component]!), { recursive: true });
      }

      await writeInstallationJson(box.root, 'current.json', job[pointer]);
      await recoverInstalledUpdate(box.root, ports);
      assert.deepEqual(await box.pointer(), job.previous);
      assert.equal((await box.job())?.stage, 'rolled_back');
      assert.deepEqual(calls, ['recheck', 'stop', 'rollback', 'old-proof']);
      await recoverInstalledUpdate(box.root, ports);
      assert.equal(calls.length, 4, 'Повтор resume не делает второй switch/start');
      await box.preserved();
    });
  }
}

test('RECOVERY-MATRIX: stopped server остаётся applied_not_started до живого proof', async (t) => {
  const box = await installedFixture(t, { mode: 'server' });
  const created = await box.create();
  const { calls, ports } = processPorts(box.release.publicKeyPem);

  await box.manager.prepare(created.id);
  await confirmInstalledUpdate(box.root, created.id);
  ports.prove = async () => 'stopped';
  ports.start = async () => {};

  const applied = await applyInstalledUpdate(box.root, created.id, ports);

  assert.equal(applied.stage, 'applied_not_started');
  assert.deepEqual(await box.pointer(), applied.target);
  await recoverInstalledUpdate(box.root, ports);
  assert.equal((await box.job())?.stage, 'applied_not_started');

  ports.prove = async () => 'running';
  await recoverInstalledUpdate(box.root, ports);
  assert.equal((await box.job())?.stage, 'completed');
  assert.deepEqual(calls, ['recheck', 'stop', 'recheck']);
  await box.preserved();
});

test('ROLLBACK-ESCAPE: applied_not_started возвращается к previous по явному согласию', async (t) => {
  const box = await installedFixture(t, { mode: 'server' });
  const created = await box.create();
  const calls: string[] = [];
  const ports: UpdateApplyPorts = {
    publicKeyPem: box.release.publicKeyPem,
    recheck: async () => {
      calls.push('recheck');
    },
    stop: async () => {
      calls.push('stop');
    },
    start: async (_job, rollback) => {
      calls.push(rollback ? 'rollback' : 'start');
    },
    prove: async (_job, rollback) => {
      calls.push(rollback ? 'old-proof' : 'new-proof');

      return 'stopped';
    },
  };

  await box.manager.prepare(created.id);
  await confirmInstalledUpdate(box.root, created.id);

  const applied = await applyInstalledUpdate(box.root, created.id, ports);

  assert.equal(applied.stage, 'applied_not_started');
  assert.deepEqual(await box.pointer(), applied.target);

  await recoverInstalledUpdate(box.root, ports, { rollback: true });

  assert.deepEqual(await box.pointer(), applied.previous);
  assert.equal((await box.job())?.stage, 'rolled_back');
  assert.deepEqual(calls, ['recheck', 'stop', 'recheck', 'start', 'new-proof',
    'recheck', 'stop', 'rollback', 'old-proof']);
  await box.preserved();
});

test('CLEANUP: completed освобождает staging, логи задания и недостижимые поколения', async (t) => {
  const box = await installedFixture(t);
  const job = await box.create();
  const { ports } = processPorts(box.release.publicKeyPem);
  const exists = async (target: string) => fs.stat(path.join(box.root, target))
    .then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');

  for (const component of ['desktop', 'server'] as const) {
    await fs.mkdir(path.join(box.root, `generations/0.1.0/${component}`), {
      recursive: true, mode: 0o700,
    });
  }

  await fs.mkdir(path.join(box.root, 'generations/notes'), { recursive: true, mode: 0o700 });

  await box.manager.prepare(job.id);
  await confirmInstalledUpdate(box.root, job.id);

  const applied = await applyInstalledUpdate(box.root, job.id, ports);

  assert.equal(applied.stage, 'completed');
  assert.ok(await exists(`update/${job.id}`));
  await fs.writeFile(path.join(box.root, 'update', `${job.id}-apply.log`), 'x\n', { mode: 0o600 });

  await pruneCompletedUpdate(box.receipt, applied);

  assert.equal(await exists(`update/${job.id}`), false, 'staging задания удалён');
  assert.equal(await exists(`update/${job.id}-apply.log`), false, 'лог задания удалён');
  assert.equal(await exists('generations/0.1.0'), false, 'недостижимое поколение удалено');
  assert.ok(await exists(job.previous.desktop!), 'previous сохранён для отката');
  assert.ok(await exists(job.target.desktop!), 'current сохранён');
  assert.ok(await exists('generations/notes'), 'посторонний каталог не тронут');
  assert.ok(await exists('update/job.json'), 'journal сохранён');
  await box.preserved();
});

const { spawn } = await import('node:child_process');

for (const boundary of ['intent', 'stop', 'before-pointer', 'after-pointer', 'proof']) {
  test(`RECOVERY-MATRIX kill: ${boundary}, durable journal переживает SIGKILL`, async (t) => {
    const box = await installedFixture(t);
    const created = await box.create();

    await box.manager.prepare(created.id);
    await confirmInstalledUpdate(box.root, created.id);

    const applyUrl = new URL('../../shared/node/installedUpdateApply.ts', import.meta.url).href;
    const script = path.join(box.temporary, 'crash.mjs');

    await fs.writeFile(script, [
      `import { applyInstalledUpdate } from ${JSON.stringify(applyUrl)};`,
      `const boundary = ${JSON.stringify(boundary)};`,
      'let checks = 0;',
      'const hold = async (name) => {',
      '  if (name !== boundary) return;',
      '  process.send(name);',
      '  await new Promise(() => setInterval(() => {}, 1000));',
      '};',
      'await hold("intent");',
      `await applyInstalledUpdate(${JSON.stringify(box.root)}, ${JSON.stringify(created.id)}, {`,
      `  publicKeyPem: ${JSON.stringify(box.release.publicKeyPem)},`,
      '  recheck: async () => { checks += 1; if (checks === 2) await hold("before-pointer"); },',
      '  stop: async () => { await hold("stop"); },',
      '  start: async () => { await hold("after-pointer"); },',
      '  prove: async () => { await hold("proof"); return "running"; },',
      '});',
    ].join('\n'));

    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const errors: Buffer[] = [];

    child.stderr!.on('data', (bytes: Buffer) => errors.push(bytes));
    t.after(() => child.kill('SIGKILL'));

    const arrived = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error(Buffer.concat(errors).toString());
      }),
    ]);

    assert.equal(arrived[0], boundary);
    child.kill('SIGKILL');
    await once(child, 'exit');

    if (boundary !== 'intent') {
      const owner = JSON.parse(await fs.readFile(
        path.join(box.root, 'update/installation.install-lock/owner.json'), 'utf8',
      ));

      assert.equal(owner.pid, child.pid);
      assert.equal(await processOwnerState(owner), 'dead');
    }

    const interrupted = await box.job();
    const pointer = await box.pointer();

    assert.ok(interrupted);
    assert.ok([JSON.stringify(interrupted.previous), JSON.stringify(interrupted.target)]
      .includes(JSON.stringify(pointer)));

    const { ports, calls } = processPorts(box.release.publicKeyPem);

    try {
      await recoverInstalledUpdate(box.root, ports);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'directory_lock_busy') {
        await recoverInstalledUpdate(box.root, ports);
        assert.deepEqual(await box.pointer(), box.previous);
        t.diagnostic('Мёртвый owner доказан; второй recover успешен без ручного удаления lock.');
      }

      throw error;
    }

    assert.deepEqual(await box.pointer(), box.previous);
    assert.equal((await box.job())?.stage, boundary === 'intent' ? 'ready' : 'rolled_back');

    const effects = calls.length;

    await recoverInstalledUpdate(box.root, ports);
    assert.equal(calls.length, effects);
    await box.preserved();
  });
}
