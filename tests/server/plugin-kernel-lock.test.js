import assert from 'node:assert/strict';
import { link, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { pluginCore, runtimeFixture } from './helpers/pluginRuntimeFixture.js';

test('PC-LOCK-NOW: синхронно обнаруживает замену inode и скрывает внутренние порты', async (t) => {
  const f = await runtimeFixture(t);
  const lockPath = path.join(f.root, 'public.lock');
  const lock = await pluginCore(f).acquireKernelFileLock({
    lockPath,
    lostCode: 'public_lost',
    binary: '/not-a-flock-executable',
    errorFactory: () => new Error('Подменённая фабрика не должна вызываться'),
  });

  t.after(() => lock.release());
  assert.equal(typeof lock.assertPathIdentityNow, 'function');
  assert.equal(Object.isFrozen(lock), true);
  assert.equal(lock.inheritedFd, undefined);
  assert.equal(lock.binary, undefined);
  assert.equal(lock.errorFactory, undefined);
  assert.equal(lock.assertPathIdentityNow(), undefined);
  await rename(lockPath, `${lockPath}.held`);
  await writeFile(lockPath, 'замена');
  assert.throws(() => lock.assertPathIdentityNow(), { code: 'public_lost' });
  await lock.release();
  await lock.release();
  assert.throws(() => lock.assertPathIdentityNow(), { code: 'public_lost' });
});

for (const kind of ['hardlink', 'symlink']) {
  test(`PC-LOCK-NOW: отвергает ${kind} без await перед возвратом`, async (t) => {
    const f = await runtimeFixture(t);
    const lockPath = path.join(f.root, 'identity.lock');
    const lock = await pluginCore(f).acquireKernelFileLock({ lockPath });

    t.after(() => lock.release());
    assert.equal(typeof lock.assertPathIdentityNow, 'function');

    if (kind === 'hardlink') {
      await link(lockPath, `${lockPath}.alias`);
    } else {
      await rename(lockPath, `${lockPath}.held`);
      await symlink(`${lockPath}.held`, lockPath);
    }

    assert.throws(() => lock.assertPathIdentityNow(), { code: 'FILE_LOCK_LOST' });
  });
}
