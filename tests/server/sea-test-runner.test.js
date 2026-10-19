import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/**
 * Копия runner работает с отдельным деревом и сторожем-портом exit7.
 * Проверяется реальная команда запуска и код выхода, тяжёлый gate здесь не выполняется.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-runner-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'server/scripts'), { recursive: true });
  await mkdir(path.join(root, 'tests/server/sea'), { recursive: true });
  await mkdir(path.join(root, 'release with spaces'));
  await copyFile(new URL('../../server/scripts/testSea.mts', import.meta.url),
    path.join(root, 'server/scripts/testSea.mts'));

  for (const name of ['package.test.mts', 'boot.test.mts', 'readonly.test.mts', 'service.e2e.mts']) {
    await writeFile(path.join(root, 'tests/server/sea', name), '');
  }

  await writeFile(path.join(root, 'tests/run-node-tests-safe.sh'), '#!/bin/bash\n'
    + 'printf "%s\\n" "$@" > args\nprintf "%s" "$GRIGDESK_SERVER_RELEASE_DIR" > release\nexit 7\n');

  return root;
}

test('SEA-RUNNER-01: все slow .test.mts через сторож, внешний E2E отдельно, exit сохранён', async (t) => {
  const root = await fixture(t);

  await assert.rejects(execute(process.execPath, [path.join(root, 'server/scripts/testSea.mts'),
    '--release-dir', path.join(root, 'release with spaces'),
  ], { cwd: '/' }), (error) => error.code === 7);

  const args = (await readFile(path.join(root, 'args'), 'utf8')).trim().split('\n');

  assert.deepEqual(args, [
    '--test', '--test-concurrency=1',
    'tests/server/sea/boot.test.mts',
    'tests/server/sea/package.test.mts',
    'tests/server/sea/readonly.test.mts',
  ]);
  assert.equal(await readFile(path.join(root, 'release'), 'utf8'), path.join(root, 'release with spaces'));
});

test('SEA-RUNNER-02: неизвестный флаг и отсутствие release не становятся skip', async (t) => {
  const root = await fixture(t);

  for (const args of [[], ['--unknown', root], ['--release-dir', path.join(root, 'missing')]]) {
    await assert.rejects(execute(process.execPath,
      [path.join(root, 'server/scripts/testSea.mts'), ...args]), (error) => error.code === 2);
  }
});
