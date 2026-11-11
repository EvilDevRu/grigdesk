import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { cleanupArtifacts } from '../../shared/node/artifactsCleanup.ts';
import { oldTree, present, retentionFixture, treeSnapshot } from '../helpers/deepseekRetentionFixture.mts';

for (const stage of ['rename', 'remove'] as const) {
  test(`AC-ANCHOR: подмена gates на symlink на этапе ${stage} сохраняет внешние данные`, async (t) => {
    const box = await retentionFixture(t);
    const gates = path.join(box.root, 'gates');
    const candidate = await oldTree(gates, 'candidate-old');
    const external = path.join(box.home, 'external');
    const victim = await oldTree(external, 'candidate-old');
    const before = await treeSnapshot(victim);
    const rename = fs.rename.bind(fs);
    const remove = fs.rm.bind(fs);
    let changed = false;

    const replaceParent = async () => {
      if (!changed) {
        changed = true;
        await rename(gates, `${gates}-retired`);
        await fs.symlink(external, gates);
      }
    };
    const renameHook = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (stage === 'rename' && path.basename(String(args[0])) === path.basename(candidate)) {
        await replaceParent();
      }

      return rename(...args);
    });
    const removeHook = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
      if (stage === 'remove' && path.basename(String(args[0])).startsWith('candidate-old.cleanup-')) {
        await replaceParent();
      }

      return remove(...args);
    });

    t.after(() => {
      renameHook.mock.restore();
      removeHook.mock.restore();
    });

    const report = await cleanupArtifacts({ root: box.artifacts, scope: 'artifacts' });

    assert.equal(changed, true, 'Подмена попала между проверкой и файловым эффектом');
    assert.equal(report.errorCount, 0);
    assert.equal(await present(victim), true);
    assert.deepEqual(await treeSnapshot(victim), before);
    assert.equal(await present(path.join(`${gates}-retired`, 'candidate-old')), false);
    assert.equal(report.entries.find((entry) => entry.path.endsWith('gates/candidate-old'))?.status,
      'deleted');
  });
}

test('AC-ANCHOR: подмена предка во время acquire не перенаправляет owner и release lock', async (t) => {
  const box = await retentionFixture(t);
  const gates = path.join(box.root, 'gates');
  const candidate = await oldTree(gates, 'candidate-old');
  const external = path.join(box.home, 'external');
  const foreign = await oldTree(external, 'candidate-old.lock');
  const before = await treeSnapshot(foreign);
  const mkdir = fs.mkdir.bind(fs);
  let changed = false;
  const intercept = t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await mkdir(...args);

    if (!changed && path.basename(String(args[0])) === `${path.basename(candidate)}.lock`) {
      changed = true;
      await fs.rename(gates, `${gates}-retired`);
      await fs.symlink(external, gates);
    }

    return result;
  });

  t.after(() => intercept.mock.restore());

  const report = await cleanupArtifacts({ root: box.artifacts, scope: 'artifacts' });

  assert.equal(changed, true);
  assert.equal(report.errorCount, 0);
  assert.deepEqual(await treeSnapshot(foreign), before, 'Чужие файлы в lock-подобной папке остаются');
  assert.equal(await present(path.join(`${gates}-retired`, 'candidate-old.lock')), false,
    'Собственный lock освобождён через тот же закреплённый fd');
  assert.equal(await present(path.join(`${gates}-retired`, 'candidate-old/sentinel')), true);
});

test('AC-ANCHOR: symlink вместо leaf между lstat и rename не удаляет target', async (t) => {
  const box = await retentionFixture(t);
  const candidate = await oldTree(box.artifacts, 'old');
  const victim = await oldTree(box.home, 'outside');
  const before = await treeSnapshot(victim);
  const rename = fs.rename.bind(fs);
  let changed = false;
  const intercept = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    const source = String(args[0]);

    if (!changed && path.basename(source) === path.basename(candidate)) {
      changed = true;
      await rename(source, `${source}.saved`);
      await fs.symlink(victim, source);
    }

    return rename(...args);
  });

  t.after(() => intercept.mock.restore());

  const report = await cleanupArtifacts({ root: box.artifacts, scope: 'artifacts' });

  assert.equal(changed, true);
  assert.equal(report.freedBytes, 0);
  assert.equal(report.entries.find((entry) => entry.path === 'old')?.reason, 'disappeared');
  assert.deepEqual(await treeSnapshot(victim), before);
  assert.equal(await present(`${candidate}.saved/sentinel`), true);
});

test('AC-ANCHOR: остаток после аварии не вытесняет полезные поколения и убирается повторно', async (t) => {
  const box = await retentionFixture(t);
  const generations = path.join(box.root, 'node-cache/generations');

  for (const name of ['g1', 'g2', 'g3']) {
    await oldTree(generations, name);
  }

  const abandoned = await oldTree(generations, `g4.cleanup-${'a'.repeat(32)}`);
  const report = await cleanupArtifacts({ root: box.artifacts, scope: 'artifacts' });

  assert.equal(report.errorCount, 0);
  assert.equal(await present(abandoned), false);
  assert.deepEqual(await fs.readdir(generations), ['g1', 'g2', 'g3']);
});
