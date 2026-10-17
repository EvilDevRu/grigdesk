import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';

import {
  capturePackageSnapshot,
  computePayloadDigest,
  validatePreparedPayload,
} from '../../server/src/lib/pluginInstall/payloadDigest.ts';
import { readPackageTree } from '../../server/src/lib/pluginInstall/packageTree.ts';

/**
 * Snapshot снимается до создания зависимостей, как в настоящей подготовке.
 * Файлы manifest, lock и server остаются доступными для проверки неизменности.
 */
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-payload-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  for (const file of ['plugin.json', 'server.js', 'package-lock.json', 'web/index.html']) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), `original:${file}`);
  }

  const snapshot = await capturePackageSnapshot(dir, ['.']);

  await mkdir(path.join(dir, 'node_modules/.bin'), { recursive: true });
  await mkdir(path.join(dir, 'node_modules/pkg/bin'), { recursive: true });
  await writeFile(path.join(dir, 'node_modules/pkg/bin/cli.js'), 'dependency');

  return { dir, snapshot };
}

test('V18: после npm разрешена только внутренняя .bin-ссылка и сохранён исходный payload', async (t) => {
  const valid = await fixture(t);

  await symlink('../pkg/bin/cli.js', path.join(valid.dir, 'node_modules/.bin/cli'));
  assert.match(await validatePreparedPayload(valid.dir, valid.snapshot, 'web'), /^[a-f0-9]{64}$/u);

  for (const variant of ['external', 'chain', 'absolute', 'web', 'manifest', 'tracked', 'lock']) {
    const { dir, snapshot } = await fixture(t);

    if (variant === 'external') {
      await symlink('../../../outside', path.join(dir, 'node_modules/.bin/cli'));
    } else if (variant === 'chain') {
      await symlink('../pkg/jump', path.join(dir, 'node_modules/.bin/cli'));
      await symlink('../../../outside', path.join(dir, 'node_modules/pkg/jump'));
    } else if (variant === 'absolute') {
      await symlink(path.join(dir, 'node_modules/pkg/bin/cli.js'), path.join(dir, 'node_modules/.bin/cli'));
    } else if (variant === 'web') {
      await rm(path.join(dir, 'web/index.html'));
      await symlink('../node_modules/pkg/bin/cli.js', path.join(dir, 'web/index.html'));
    } else {
      const file = variant === 'manifest' ? 'plugin.json'
        : variant === 'lock' ? 'package-lock.json' : 'server.js';

      await writeFile(path.join(dir, file), 'changed');
    }

    await assert.rejects(validatePreparedPayload(dir, snapshot, 'web'), (error) => {
      assert.ok(['package_unsupported', 'symlink_forbidden', 'preview_stale'].includes(error.code));

      return true;
    });
  }
});

test('V19: digest независим от readdir, учитывает content/mode/type/link и generated, исключает .git',
  async (t) => {
    const { dir } = await fixture(t);
    const digest = await computePayloadDigest(dir, ['.']);

    assert.match(digest, /^[a-f0-9]{64}$/u);

    const originalReader = filesystem.readdir;
    const beforeOrder = (await readPackageTree(dir, { generatedDirs: ['.'] })).map((entry) => entry.relative);
    const mocked = t.mock.method(filesystem, 'readdir', async (...args) => {
      const entries = await originalReader(...args);

      return entries.reverse();
    });

    syncBuiltinESMExports();

    try {
      const afterTree = await readPackageTree(dir, { generatedDirs: ['.'] });
      const afterOrder = afterTree.map((entry) => entry.relative);

      assert.notDeepEqual(beforeOrder, afterOrder, 'действительно изменён порядок readdir');
      assert.equal(await computePayloadDigest(dir, ['.']), digest);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }

    const file = path.join(dir, 'server.js');
    const bytes = await readFile(file);

    await writeFile(file, 'changed');
    assert.notEqual(await computePayloadDigest(dir, ['.']), digest);
    await writeFile(file, bytes);
    await chmod(file, 0o755);
    assert.notEqual(await computePayloadDigest(dir, ['.']), digest);
    await chmod(file, 0o644);

    await rm(file);
    await mkdir(file);
    assert.notEqual(await computePayloadDigest(dir, ['.']), digest);
    await rm(file, { recursive: true });
    await writeFile(file, bytes);

    const link = path.join(dir, 'node_modules/.bin/cli');

    await symlink('../pkg/bin/cli.js', link);

    const firstLink = await computePayloadDigest(dir, ['.']);

    await rm(link);
    await symlink('../pkg/bin/./cli.js', link);
    assert.notEqual(await computePayloadDigest(dir, ['.']), firstLink);

    const beforeDependency = await computePayloadDigest(dir, ['.']);

    await writeFile(path.join(dir, 'node_modules/pkg/bin/cli.js'), 'changed dependency');
    assert.notEqual(await computePayloadDigest(dir, ['.']), beforeDependency);

    execFileSync('/usr/bin/git', ['init', '--template=', dir], {
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      stdio: 'ignore',
    });

    const withGit = await computePayloadDigest(dir, ['.']);

    await writeFile(path.join(dir, '.git/ignored'), 'arbitrary metadata bytes');
    assert.equal(await computePayloadDigest(dir, ['.']), withGit);
  });
