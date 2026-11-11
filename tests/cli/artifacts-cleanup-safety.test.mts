import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { cleanupArtifacts } from '../../shared/node/artifactsCleanup.ts';
import { acquireDirectoryLock } from '../../shared/node/directoryLock.ts';
import {
  DAY, ageTree, oldTree, present, retentionFixture, treeSnapshot,
} from '../helpers/deepseekRetentionFixture.mts';

for (const lockName of ['deepseek.install-lock', 'runtime.select-lock', 'runtime.cutover-lock',
  'lock', 'custom-owner']) {
  for (const owner of ['alive', 'unknown'] as const) {
    test(`AS-LOCK: ранее выданный ${lockName}/${owner} защищает старое дерево`, async (t) => {
      const box = await retentionFixture(t);
      const old = await oldTree(box.artifacts, 'old');
      const free = await oldTree(box.artifacts, 'free');
      const directory = path.join(old, lockName);

      if (owner === 'alive') {
        const lock = await acquireDirectoryLock(directory, { waitMs: 0 });

        t.after(() => lock.release());
      } else {
        await fs.mkdir(directory);
        await fs.writeFile(path.join(directory, 'owner.json'), '{broken');
      }

      await ageTree(old, Date.now() - 8 * DAY);

      const before = await treeSnapshot(old);
      const preview = await cleanupArtifacts({
        root: box.artifacts,
        scope: 'artifacts',
        dryRun: true,
      });
      const result = await cleanupArtifacts({ root: box.artifacts, scope: 'artifacts' });
      const expected = owner === 'alive' ? 'locked' : 'lock-unknown';

      assert.equal(preview.entries.find((entry) => entry.path === 'old')?.reason, expected);
      assert.equal(result.entries.find((entry) => entry.path === 'old')?.reason, expected);
      assert.equal(result.errorCount, 0);
      assert.deepEqual(await treeSnapshot(old), before, 'Живое дерево и owner не меняются');
      assert.equal(await present(free), false, 'Незанятый старый сосед действительно убирается');
    });
  }
}

for (const kind of ['release', 'stale']) {
  for (const dryRun of [true, false]) {
    test(`AS-GENERATIONS: sidecar ${kind} не занимает одно из K мест, dryRun=${dryRun}`, async (t) => {
      const box = await retentionFixture(t);
      const generations = path.join(box.root, 'node-cache/generations');

      for (let index = 1; index <= 4; index++) {
        await oldTree(generations, `g${index}`, 17, Date.now() - (9 + index) * DAY);
      }

      const sidecar = path.join(generations, `g1.lock.${kind}-${'a'.repeat(32)}`);

      await fs.mkdir(sidecar);
      await fs.writeFile(path.join(sidecar, 'owner.json'), JSON.stringify({
        pid: process.pid,
        starttime: '0',
        token: 'retired-generation-lock',
      }));

      const before = await treeSnapshot(generations);
      const report = await cleanupArtifacts({
        root: box.root,
        scope: 'deepseek-tests',
        dryRun,
      });

      for (let index = 1; index <= 3; index++) {
        const relative = `node-cache/generations/g${index}`;

        assert.equal(await present(path.join(generations, `g${index}`)), true);
        assert.equal(report.entries.find((entry) => entry.path === relative)?.reason, 'keep-latest');
      }

      assert.equal(await present(path.join(generations, 'g4')), dryRun);
      assert.equal(report.errorCount, 0);
      assert.equal(dryRun ? report.wouldDeleteBytes : report.freedBytes, 17);

      if (dryRun) {
        assert.deepEqual(await treeSnapshot(generations), before);
      }
    });
  }
}

for (const protectedKind of ['directory', 'child'] as const) {
  for (const dryRun of [true, false]) {
    test(`AS-CURRENT: ${protectedKind}, current не обходится, dryRun=${dryRun}`, async (t) => {
      const box = await retentionFixture(t);
      const current = await oldTree(box.root, 'test-builds/current');
      const child = await oldTree(current, 'cache/packages/one/generation');
      const unrelated = await oldTree(box.root, 'test-builds/current-other');
      const readdir = fs.readdir.bind(fs);
      let visits = 0;
      const intercept = t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
        const directory = String(args[0]);

        if (directory === current || directory.startsWith(`${current}${path.sep}`)) {
          visits++;
        }

        return readdir(...args);
      });

      t.after(() => intercept.mock.restore());

      const report = await cleanupArtifacts({
        root: box.root,
        scope: 'deepseek-tests',
        protectedPaths: [protectedKind === 'directory' ? current : path.join(child, 'sentinel')],
        dryRun,
      });
      const entry = report.entries.find((item) => item.path === 'test-builds/current');

      assert.equal(visits, 0, 'Известный current сохраняется до обхода многогигабайтного cache');
      assert.equal(entry?.reason, 'current');
      assert.equal(entry?.bytes, null, 'Неизмеренный размер не выдаётся за ноль байт');
      assert.equal(report.errorCount, 0);
      assert.equal(await present(current), true);
      assert.equal(await present(unrelated), dryRun, 'Защита пути не распространяется на схожее имя');
    });
  }
}
