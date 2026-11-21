import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile }
  from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { goCandidate } from '../helpers/goCandidate.mts';

const helper = new URL('../../deploy/lib/tracker-cli.sh', import.meta.url);

/**
 * Создаёт checkout с отдельным каталогом ссылок и проверяемым Go-кандидатом.
 * Подставной сборщик пишет только в каталог фикстуры.
 */
async function installation(t: TestContext, program: string) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'grigdesk install '));
  const root = path.join(base, 'checkout');
  const links = path.join(base, 'local bin');
  const target = path.join(root, 'bin/utilities', program);
  const link = path.join(links, program);
  const downloads = path.join(root, 'build-log');

  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(root, 'bin/utilities'), { recursive: true });
  await mkdir(path.join(root, 'tools'));
  await mkdir(links);
  await writeFile(path.join(root, 'tools/build-go-utilities.sh'), [
    'set -e',
    'echo build >> "$BUILD_LOG"',
    'test -z "$BUILD_FAIL"',
    'cp "$TEST_BINARY" "$1/$TEST_COMMAND"',
  ].join('\n'));

  function run(fail = '') {
    return spawnSync('/bin/bash', [helper.pathname, root, links, program], {
      cwd: base,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        HOME: base,
        PATH: '/usr/bin:/bin',
        TEST_COMMAND: program,
        TEST_BINARY: goCandidate(program),
        BUILD_FAIL: fail,
        BUILD_LOG: downloads,
      },
    });
  }

  return {
    target,
    link,
    run,
    root,
    downloads,
  };
}

for (const program of ['tracker', 'routes', 'pipeline']) {
  test(`Установка ${program} обновляет ссылку только после успешной проверки Go`, async (t) => {
    const box = await installation(t, program);

    await symlink('/прежнее-поколение', box.link);
    assert.equal(box.run('1').status, 1);
    assert.equal(await readlink(box.link), '/прежнее-поколение');

    const result = box.run();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readlink(box.link), box.target);
    assert.equal(box.run().status, 0);
    assert.equal(await readFile(box.downloads, 'utf8'), 'build\nbuild\n');
  });
}

test('Установка проверяет утилиту готового комплекта и сохраняет чужой файл', async (t) => {
  const box = await installation(t, 'tracker');
  const target = path.join(box.root, 'bin/tracker');

  await writeFile(path.join(box.root, 'release.json'), '{}');
  await writeFile(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(box.link, 'чужая команда');
  assert.equal(box.run().status, 1);
  await copyFile(goCandidate('pipeline'), target);
  assert.equal(box.run().status, 1);
  await copyFile(goCandidate('tracker'), target + '.new');
  await rename(target + '.new', target);
  assert.equal(box.run().status, 2);
  assert.equal(await readFile(box.link, 'utf8'), 'чужая команда');
  await assert.rejects(readFile(box.downloads), { code: 'ENOENT' });
});
