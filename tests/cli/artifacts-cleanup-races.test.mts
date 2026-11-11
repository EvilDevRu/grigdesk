import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { cleanupArtifacts } from '../../shared/node/artifactsCleanup.ts';
import { acquireDirectoryLock, directoryCleanupLockPath } from '../../shared/node/directoryLock.ts';
import { DAY, oldTree, present, retentionFixture } from '../helpers/deepseekRetentionFixture.mts';

for (const target of ['ancestor', 'ancestor-install', 'nested', 'payload'] as const) {
  test(`AC-BARRIER: ${target} lock не выдаётся между проверкой и удалением`, async (t) => {
    const box = await retentionFixture(t);
    const old = await oldTree(box.artifacts, 'old');
    const lockPath = target === 'ancestor' ? `${box.artifacts}.lock`
      : target === 'ancestor-install' ? `${box.artifacts}.install-lock`
        : target === 'nested' ? path.join(old, 'nested.lock') : path.join(old, '.locks/package');

    if (target === 'payload') {
      await fs.mkdir(path.dirname(lockPath));
      await fs.utimes(old, new Date(Date.now() - 8 * DAY), new Date(Date.now() - 8 * DAY));
      await fs.utimes(path.dirname(lockPath), new Date(Date.now() - 8 * DAY),
        new Date(Date.now() - 8 * DAY));
    }

    const readdir = fs.readdir.bind(fs);
    let visitsUnderLock = 0;
    let blocked = false;
    const intercept = t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === old && await present(`${old}.lock`)) {
        visitsUnderLock++;

        if (visitsUnderLock === 2) {
          await assert.rejects(acquireDirectoryLock(lockPath, { waitMs: 0 }), {
            code: 'directory_lock_busy',
          });
          blocked = true;
        }
      }

      return readdir(...args);
    });

    t.after(() => intercept.mock.restore());

    const report = await cleanupArtifacts({ root: box.artifacts, scope: 'artifacts' });

    assert.equal(blocked, true, 'Производитель пытался начать работу во время финального измерения');
    assert.equal(report.errorCount, 0);
    assert.equal(await present(old), false);
    assert.equal(await present(directoryCleanupLockPath(box.artifacts)), false);

    if (target.startsWith('ancestor')) {
      const next = await acquireDirectoryLock(lockPath, { waitMs: 0 });

      await next.release();
    }
  });
}

test('AC-BARRIER: ранее выданный ancestor install-lock защищает старый каталог', async (t) => {
  const box = await retentionFixture(t);
  const old = await oldTree(box.artifacts, 'old');
  const lock = await acquireDirectoryLock(`${box.artifacts}.install-lock`, { waitMs: 0 });

  t.after(() => lock.release());

  const report = await cleanupArtifacts({ root: box.artifacts, scope: 'artifacts' });

  assert.equal(await present(old), true);
  assert.equal(report.entries.find((entry) => entry.path === 'old')?.reason, 'locked');
});

test('AC-BARRIER: ранее выданный ancestor lock сохраняет старый каталог', async (t) => {
  const box = await retentionFixture(t);
  const old = await oldTree(box.artifacts, 'old');
  const mkdir = fs.mkdir.bind(fs);
  let lock: Awaited<ReturnType<typeof acquireDirectoryLock>> | undefined;
  const intercept = t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    if (String(args[0]) === directoryCleanupLockPath(box.artifacts) && !lock) {
      lock = await acquireDirectoryLock(`${box.artifacts}.lock`, { waitMs: 0 });
    }

    return mkdir(...args);
  });

  t.after(async () => {
    intercept.mock.restore();
    await lock?.release();
  });

  const report = await cleanupArtifacts({ root: box.artifacts, scope: 'artifacts' });

  assert.ok(lock);
  assert.equal(await present(old), true);
  assert.equal(report.entries.find((entry) => entry.path === 'old')?.reason, 'locked');
  assert.equal(report.errorCount, 0);
});

test('AC-BARRIER: барьер после публикации provisional lock не отдаёт владельца вызывающему', async (t) => {
  const box = await retentionFixture(t);
  const old = await oldTree(box.artifacts, 'old');
  const writeFile = fs.writeFile.bind(fs);
  let barrier: Awaited<ReturnType<typeof acquireDirectoryLock>> | undefined;
  const intercept = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    const result = await writeFile(...args);

    if (String(args[0]) === `${old}.lock/owner.json` && !barrier) {
      barrier = await acquireDirectoryLock(directoryCleanupLockPath(box.artifacts), { waitMs: 0 });
    }

    return result;
  });

  t.after(async () => {
    intercept.mock.restore();
    await barrier?.release();
  });

  await assert.rejects(acquireDirectoryLock(`${old}.lock`, { waitMs: 0 }), {
    code: 'directory_lock_busy',
  });
  assert.ok(barrier);
  assert.equal(await present(`${old}.lock`), false);
  assert.equal(await present(old), true);
});

test('AC-BARRIER: физический путь защищён и при входе через symlink', async (t) => {
  const box = await retentionFixture(t);
  const old = await oldTree(box.artifacts, 'old');
  const alias = path.join(box.home, 'alias');
  const barrier = await acquireDirectoryLock(directoryCleanupLockPath(box.artifacts));

  t.after(() => barrier.release());
  await fs.symlink(old, alias);
  await assert.rejects(acquireDirectoryLock(path.join(alias, 'nested.lock'), { waitMs: 0 }), {
    code: 'directory_lock_busy',
  });
  assert.equal(await present(path.join(old, 'nested.lock')), false);
});

for (const owner of ['dead', 'unknown'] as const) {
  test(`AC-BARRIER: ${owner} владелец барьера обрабатывается без возрастных предположений`, async (t) => {
    const box = await retentionFixture(t);
    const old = await oldTree(box.artifacts, 'old');
    const barrier = directoryCleanupLockPath(box.artifacts);

    await fs.mkdir(barrier);

    if (owner === 'dead') {
      await fs.writeFile(path.join(barrier, 'owner.json'), JSON.stringify({
        pid: process.pid,
        starttime: '0',
        token: 'stale-barrier',
      }));
    }

    const report = await cleanupArtifacts({ root: box.artifacts, scope: 'artifacts' });

    assert.equal(report.errorCount, 0);
    assert.equal(await present(old), owner === 'unknown');
    assert.equal(report.entries.find((entry) => entry.path === 'old')?.status,
      owner === 'unknown' ? 'skipped' : 'deleted');
    await fs.rm(barrier, { recursive: true, force: true });
  });
}

for (const dryRun of [true, false]) {
  test(`AC-SCANS: двадцать поколений требуют линейного числа полных обходов, dryRun=${dryRun}`, async (t) => {
    const box = await retentionFixture(t);
    const generations = path.join(box.root, 'node-cache/generations');

    for (let index = 0; index < 20; index++) {
      await oldTree(generations, `g${String(index).padStart(2, '0')}`, 1,
        Date.now() - (10 + index) * DAY);
    }

    const readdir = fs.readdir.bind(fs);
    let scans = 0;
    const intercept = t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]).startsWith(`${generations}/g`)) {
        scans++;
      }

      return readdir(...args);
    });

    t.after(() => intercept.mock.restore());

    const report = await cleanupArtifacts({
      root: box.artifacts,
      scope: 'artifacts',
      dryRun,
    });
    const status = dryRun ? 'would-delete' : 'deleted';

    assert.equal(report.errorCount, 0);
    assert.equal(report.entries.filter((entry) => entry.status === status).length, 17);
    assert.ok(scans <= 6 * 20, `Обходов ${scans}; нельзя перечитывать все деревья для каждого поколения`);
  });
}
