import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { cleanupArtifacts } from '../../shared/node/artifactsCleanup.ts';
import { acquireDirectoryLock, directoryCleanupLockPath } from '../../shared/node/directoryLock.ts';
import { DAY, oldTree, present, retentionFixture } from '../helpers/deepseekRetentionFixture.mts';

for (const dryRun of [true, false]) {
  test(`AC-YOUNG: подготовка сохраняет свежий корень без обхода, dryRun=${dryRun}`, async (t) => {
    const box = await retentionFixture(t);
    const young = await oldTree(box.root, 'test-builds/young', 1, Date.now());

    await fs.mkdir(path.join(young, 'nested.lock'));

    const readdir = fs.readdir.bind(fs);
    let scans = 0;
    const intercept = t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === young || String(args[0]).startsWith(`${young}/`)) {
        scans++;
      }

      return readdir(...args);
    });

    t.after(() => intercept.mock.restore());

    const options = {
      root: box.root,
      scope: 'deepseek-tests' as const,
      measureYoung: false,
      dryRun,
    };
    const report = await cleanupArtifacts(options);

    assert.equal(scans, 0, 'Свежий mtime корня уже запрещает удаление всего дерева');
    assert.equal(report.errorCount, 0);
    assert.deepEqual(report.entries.find((entry) => entry.path === 'test-builds/young'), {
      path: 'test-builds/young',
      bytes: null,
      status: 'skipped',
      reason: 'young',
    });
    assert.equal(await present(path.join(young, 'nested.lock')), true);
    assert.equal(await present(directoryCleanupLockPath(box.root)), false);
  });
}

test('AC-YOUNG: старый корень со свежим потомком измеряется и сохраняется', async (t) => {
  const box = await retentionFixture(t);
  const young = await oldTree(box.root, 'test-builds/old-parent', 1);

  await fs.utimes(path.join(young, 'sentinel'), new Date(), new Date());

  const options = {
    root: box.root,
    scope: 'deepseek-tests' as const,
    measureYoung: false,
  };
  const report = await cleanupArtifacts(options);
  const entry = report.entries.find((item) => item.path === 'test-builds/old-parent');

  assert.equal(report.errorCount, 0);
  assert.equal(entry?.reason, 'young');
  assert.equal(entry?.bytes, 1);
  assert.equal(await present(young), true);
});

test('AC-YOUNG: свежая generation занимает место среди последних K', async (t) => {
  const box = await retentionFixture(t);
  const generations = path.join(box.root, 'node-cache/generations');
  const young = await oldTree(generations, 'young', 1, Date.now());
  const kept = await oldTree(generations, 'kept', 1, Date.now() - 9 * DAY);
  const old = await oldTree(generations, 'old', 1, Date.now() - 10 * DAY);
  const options = {
    root: box.root,
    scope: 'deepseek-tests' as const,
    measureYoung: false,
    keepGenerations: 2,
  };
  const report = await cleanupArtifacts(options);

  assert.equal(report.errorCount, 0);
  assert.equal(await present(young), true);
  assert.equal(await present(kept), true);
  assert.equal(await present(old), false);
});

test('AC-BARRIER: молодое содержимое не закрывает дерево для производителей', async (t) => {
  const box = await retentionFixture(t);
  const young = await oldTree(box.artifacts, 'young');

  // Старый родитель не позволяет принять решение только по его mtime.
  await fs.utimes(path.join(young, 'sentinel'), new Date(), new Date());

  const mkdir = fs.mkdir.bind(fs);
  const barrierPath = directoryCleanupLockPath(box.artifacts);
  let barrierCreated = false;
  const intercept = t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    barrierCreated ||= String(args[0]) === barrierPath;

    return mkdir(...args);
  });

  t.after(() => intercept.mock.restore());

  const report = await cleanupArtifacts({ root: box.artifacts, scope: 'artifacts' });

  assert.equal(report.errorCount, 0);
  assert.equal(report.entries.find((entry) => entry.path === 'young')?.reason, 'young');
  assert.equal(await present(young), true);
  assert.equal(barrierCreated, false, 'Без кандидатов на удаление общий барьер не нужен');
});

test('AC-BARRIER: новый lock темы после young preview сохраняет старое поколение', async (t) => {
  const box = await retentionFixture(t);
  const generations = path.join(box.root, 'node-cache/generations');
  const old = await oldTree(generations, 'old');

  await oldTree(generations, 'young', 1, Date.now());

  const active = path.join(box.root, 'test-builds/active');

  await fs.mkdir(active, { recursive: true });

  const mkdir = fs.mkdir.bind(fs);
  let lock: Awaited<ReturnType<typeof acquireDirectoryLock>> | undefined;
  const intercept = t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    if (String(args[0]) === directoryCleanupLockPath(box.root) && !lock) {
      lock = await acquireDirectoryLock(`${active}.lock`, { waitMs: 0 });
    }

    return mkdir(...args);
  });

  t.after(async () => {
    intercept.mock.restore();
    await lock?.release();
  });

  const report = await cleanupArtifacts({
    root: box.root,
    scope: 'deepseek-tests',
    keepGenerations: 1,
  });

  assert.ok(lock, 'Сборка началась после предварительного обхода');
  assert.equal(report.errorCount, 0);
  assert.equal(await present(old), true, 'Старая generation нужна уже начавшейся сборке');
  assert.equal(report.entries.find((entry) => entry.path === 'node-cache/generations/old')?.reason, 'locked');
});

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
      const directory = String(args[0]);
      const physical = directory.startsWith('/proc/self/fd/') ? await fs.realpath(directory) : directory;

      if (physical === old && await present(`${old}.lock`)) {
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
      const directory = String(args[0]);
      const physical = directory.startsWith('/proc/self/fd/') ? await fs.realpath(directory) : directory;

      if (physical.startsWith(`${generations}/g`)) {
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

    if (dryRun && process.platform === 'linux') {
      assert.equal(scans, 20, 'Предпросмотр читает дерево каждого поколения ровно один раз');
    }

    assert.ok(scans <= 6 * 20, `Обходов ${scans}; нельзя перечитывать все деревья для каждого поколения`);
  });
}
