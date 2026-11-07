import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { recoverApply } from '../../server/src/lib/packageInstall/applyPackage.ts';
import { finishPackageRemoval } from '../../server/src/lib/packageInstall/removePackage.ts';
import { createApplyFixture } from './helpers/pluginApplyFixture.js';

/**
 * Намерение удаления связывает current и previous с их реальными каталогами.
 * Прежний формат с digest остаётся отдельным случаем восстановления.
 */
async function removalFixture(t, withDigest = false) {
  const fixture = await createApplyFixture(t, { kind: 'update', withPrevious: true });
  const npmDirs = withDigest ? [] : undefined;
  const removal = {
    pluginId: 'demo',
    transactionId: randomUUID(),
    previousTransactionId: randomUUID(),
    current: await fixture.fs.lstatIdentity(fixture.current, npmDirs),
    previous: await fixture.fs.lstatIdentity(fixture.previous, npmDirs),
    npmDirs: [],
    previousNpmDirs: [],
  };

  await fixture.store.mutate((state) => {
    state.removal = removal;
  });

  return { ...fixture, removal };
}

test('Удаление повреждённых current и previous восстанавливается после rename до commit', async (t) => {
  const f = await removalFixture(t);

  for (const directory of [f.current, f.previous]) {
    await mkdir(path.join(directory, 'node_modules/dependency'), { recursive: true });
    await writeFile(path.join(directory, 'plugin.json'), '{broken');
    await writeFile(path.join(directory, '.npmrc'), 'ignore-scripts=false');
  }

  const nativeRename = f.fs.rename;
  let interrupted = false;

  f.fs.rename = async (from, to) => {
    await nativeRename(from, to);

    if (!interrupted) {
      interrupted = true;

      throw new Error('synthetic interruption after rename');
    }
  };

  await assert.rejects(finishPackageRemoval(f.store, f.fs, f.roots), /synthetic interruption/);
  assert.ok((await f.store.read()).removal);
  await finishPackageRemoval(f.store, f.fs, f.roots);
  assert.equal((await recoverApply(f.store, f.fs)).outcome, 'none');

  const state = await f.store.read();

  assert.equal(state.removal, null);
  assert.equal(state.plugins.demo, undefined);
  assert.deepEqual(state.removedIds, ['demo']);
  assert.deepEqual(state.cleanup, []);
  assert.equal(await f.fs.lstatIdentity(f.current), null);
  assert.equal(await f.fs.lstatIdentity(f.previous), null);
});

test('Восстановление удаления сохраняет подменённый current и исходную копию', async (t) => {
  const f = await removalFixture(t);
  const saved = path.join(f.roots.pluginsDir, 'saved');

  await rename(f.current, saved);
  await mkdir(f.current);
  await writeFile(path.join(f.current, 'marker.txt'), 'foreign');
  await assert.rejects(finishPackageRemoval(f.store, f.fs, f.roots), { code: 'recovery_required' });
  assert.equal(await readFile(path.join(saved, 'marker.txt'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(f.current, 'marker.txt'), 'utf8'), 'foreign');
  assert.ok((await f.store.read()).removal);
});

test('Cleanup удаления не стирает подменённый retired', async (t) => {
  const f = await removalFixture(t);

  await finishPackageRemoval(f.store, f.fs, f.roots);

  const entry = (await f.store.read()).cleanup[0];
  const retired = path.join(f.roots.workDir, 'transactions', entry.transactionId, 'retired');
  const saved = path.join(f.root, 'saved');

  await rename(retired, saved);
  await mkdir(retired);
  await writeFile(path.join(retired, 'marker.txt'), 'foreign');
  await assert.rejects(f.fs.removeCleanup(entry), { code: 'recovery_required' });
  assert.equal(await readFile(path.join(saved, 'marker.txt'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(retired, 'marker.txt'), 'utf8'), 'foreign');
});

test('Прежнее намерение с digest восстанавливается, а cleanup проверяет сохранённый digest', async (t) => {
  const f = await removalFixture(t, true);

  await finishPackageRemoval(f.store, f.fs, f.roots);

  const entry = (await f.store.read()).cleanup[0];
  const retired = path.join(f.roots.workDir, 'transactions', entry.transactionId, 'retired');

  await writeFile(path.join(retired, 'marker.txt'), 'changed');
  await assert.rejects(f.fs.removeCleanup(entry), { code: 'recovery_required' });
  assert.equal(await readFile(path.join(retired, 'marker.txt'), 'utf8'), 'changed');
  await writeFile(path.join(retired, 'marker.txt'), 'old');
  assert.equal((await recoverApply(f.store, f.fs)).outcome, 'none');
  assert.deepEqual((await f.store.read()).cleanup, []);
});

test('Необязательный digest удаления остаётся валидируемым полем', async (t) => {
  const f = await removalFixture(t);

  await assert.rejects(f.store.mutate((state) => {
    state.removal.current.payloadDigest = 'invalid';
  }), { code: 'state_invalid' });
  await finishPackageRemoval(f.store, f.fs, f.roots);
  await assert.rejects(f.store.mutate((state) => {
    state.cleanup[0].retired.payloadDigest = 'invalid';
  }), { code: 'state_invalid' });
  assert.equal((await recoverApply(f.store, f.fs)).outcome, 'none');
});
