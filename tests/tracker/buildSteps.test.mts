import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { nodeArchive, seaConfig } from '../../shared/node/seaBuild.ts';
import { sha256File } from '../../shared/node/hash.ts';
import { withWorkDirectory } from '../../shared/node/files.ts';

import {
  assertUntracked,
  ensureNodeArchive,
  parseBuildArgs,
  publishFile,
  readNodeRuntime,
  SEA_FUSE,
} from '../../tracker/scripts/buildSteps.mts';

const PACKAGE = fileURLToPath(new URL('../../tracker/', import.meta.url));
const ROOT = path.resolve(PACKAGE, '..');

/**
 * Отдельная временная папка теста внутри TMPDIR сторожа.
 * Сеть и настоящий bin/ не используются.
 */
async function scratch(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'tracker-build-steps-'));
}

/**
 * SHA256 маленьких синтетических байтов вместо настоящего архива Node.
 * Тот же алгоритм, что у sha256File.
 */
function digest(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('BB-01: аргументы сборки проверяются до эффектов', () => {
  const cwd = '/work/tracker';

  assert.deepEqual(parseBuildArgs([], cwd, PACKAGE), {
    outDir: path.join(ROOT, 'bin'),
    cacheDir: path.join(ROOT, 'tracker/.cache'),
  });
  assert.deepEqual(parseBuildArgs(['--out-dir', '/abs/out', '--cache-dir', 'rel/cache'], cwd, PACKAGE), {
    outDir: '/abs/out',
    cacheDir: '/work/tracker/rel/cache',
  });
  assert.deepEqual(parseBuildArgs(['--cache-dir', '/abs/cache', '--out-dir', '../out'], cwd, PACKAGE), {
    outDir: '/work/out',
    cacheDir: '/abs/cache',
  });
  assert.deepEqual(parseBuildArgs(['--out-dir', 'only'], cwd, PACKAGE), {
    outDir: '/work/tracker/only',
    cacheDir: path.join(ROOT, 'tracker/.cache'),
  });

  for (const args of [['--out-dir'], ['--out-dir', ''], ['--out-dir', '/a', '--out-dir', '/b'],
    ['--cache-dir', '--out-dir', '/a'], ['--unknown', 'x'], ['extra'], ['--out-dir', '/a', 'extra']]) {
    const parsed = parseBuildArgs(args, cwd, PACKAGE);

    assert.ok('error' in parsed, JSON.stringify(args));
    assert.match(parsed.error, /[А-Яа-я]/);
  }
});

test('BB-02: runtime manifest и официальный архив закреплены', async () => {
  const manifest = JSON.parse(await readFile(path.join(PACKAGE, 'build/node-runtime.json'), 'utf8'));
  const runtime = readNodeRuntime(manifest);

  assert.deepEqual(runtime, {
    version: '24.21.0',
    platform: 'linux-x64',
    sha256: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
  });
  assert.deepEqual(nodeArchive(runtime), {
    name: 'node-v24.21.0-linux-x64.tar.xz',
    directory: 'node-v24.21.0-linux-x64',
    url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz',
  });

  for (const broken of [
    { ...runtime, version: '22.19.0' },
    { ...runtime, version: '24.21' },
    { ...runtime, platform: 'darwin-arm64' },
    { ...runtime, sha256: 'abc' },
    { ...runtime, sha256: runtime.sha256.toUpperCase() },
    null,
    'text',
  ]) {
    assert.throws(() => readNodeRuntime(broken), /node-runtime\.json/);
  }
});

test('BB-03: кэш проверяется по SHA256 на каждом использовании', async () => {
  const bytes = 'синтетический архив node';
  const runtime = {
    version: '24.21.0',
    platform: 'linux-x64' as const,
    sha256: digest(bytes),
  };
  const { name } = nodeArchive(runtime);
  const cache = await scratch();
  const archive = path.join(cache, name);

  await writeFile(archive, bytes);
  assert.equal(await ensureNodeArchive(runtime, cache, {
    download: async () => {
      throw new Error('загрузка не нужна');
    },
  }), archive);

  await writeFile(archive, 'испорченный');

  let downloads = 0;

  assert.equal(await ensureNodeArchive(runtime, cache, {
    download: async (_url, file) => {
      downloads += 1;

      if (downloads < 3) {
        throw new Error('сеть');
      }

      await writeFile(file, bytes);
    },
    pauseMs: 1,
  }), archive);
  assert.equal(downloads, 3);
  assert.equal(await readFile(archive, 'utf8'), bytes);
  assert.deepEqual((await readdir(cache)).filter((entry) => entry.includes('.part')), []);

  const exhausted = await scratch();

  await assert.rejects(ensureNodeArchive(runtime, exhausted, {
    download: async () => {
      throw new Error('сеть недоступна');
    },
    attempts: 2,
    pauseMs: 1,
  }), /сеть недоступна/);
  assert.deepEqual(await readdir(exhausted), []);

  const wrong = await scratch();

  await assert.rejects(ensureNodeArchive(runtime, wrong, {
    download: async (_url, file) => {
      await writeFile(file, 'другие байты');
    },
    attempts: 1,
    pauseMs: 1,
  }), /сумма/);
  assert.deepEqual(await readdir(wrong), []);
  assert.equal(await sha256File(archive), runtime.sha256);
});

test('BB-04: рабочая папка убирается при успехе и отказе', async () => {
  const cache = await scratch();
  const sibling = path.join(cache, 'node-v24.21.0-linux-x64.tar.xz');

  await writeFile(sibling, 'кэш');

  let seen = '';

  assert.equal(await withWorkDirectory(cache, async (work) => {
    seen = work;
    await writeFile(path.join(work, 'bundle.cjs'), 'x');

    return 7;
  }), 7);
  await assert.rejects(stat(seen));
  await assert.rejects(withWorkDirectory(cache, async (work) => {
    seen = work;

    throw new Error('сбой сборки');
  }), /сбой сборки/);
  await assert.rejects(stat(seen));
  assert.deepEqual(await readdir(cache), ['node-v24.21.0-linux-x64.tar.xz']);
});

test('BB-05: публикация атомарна и сохраняет старый файл при отказе', async () => {
  const directory = await scratch();
  const source = path.join(directory, 'candidate');
  const target = path.join(directory, 'new parent/bin/tracker');

  await writeFile(source, 'новый');
  await chmod(source, 0o600);
  await publishFile(source, target);
  assert.equal(await readFile(target, 'utf8'), 'новый');
  assert.equal((await stat(target)).mode & 0o777, 0o755);

  await writeFile(target, 'прежний');
  await assert.rejects(publishFile(path.join(directory, 'missing'), target));
  assert.equal(await readFile(target, 'utf8'), 'прежний');
  assert.deepEqual((await readdir(path.dirname(target))).sort(), ['tracker']);

  await mkdir(path.join(directory, 'dir-source'));
  await assert.rejects(publishFile(path.join(directory, 'dir-source'), target));
  assert.equal(await readFile(target, 'utf8'), 'прежний');
  assert.deepEqual((await readdir(path.dirname(target))).sort(), ['tracker']);

  const keep = path.join(directory, 'keep');
  const previousInode = (await stat(target)).ino;

  await link(target, keep);
  await publishFile(source, target);
  assert.equal(await readFile(keep, 'utf8'), 'прежний', 'публикация изменила прежний inode');
  assert.equal(await readFile(target, 'utf8'), 'новый');
  assert.notEqual((await stat(target)).ino, previousInode);
  assert.deepEqual((await readdir(path.dirname(target))).sort(), ['tracker']);
});

test('BB-06: SEA config содержит лицензию и запрещает NODE_OPTIONS', () => {
  assert.deepEqual(seaConfig(), {
    main: 'bundle.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: 'none',
    assets: { 'NODE-LICENSE': 'LICENSE' },
  });
  assert.equal(SEA_FUSE, 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
});

test('BB-08: сборка не пишет бинарник в путь, который ещё отслеживает git', async () => {
  const repository = await scratch();
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: repository,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });

  git('init', '-q');
  await mkdir(path.join(repository, 'bin'));
  await writeFile(path.join(repository, 'bin/tracker'), '#!/bin/sh\n');
  git('add', 'bin/tracker');

  await assert.rejects(assertUntracked(path.join(repository, 'bin/tracker')), /отслеживается git/);
  await assertUntracked(path.join(repository, 'bin/other'));
  await assertUntracked(path.join(repository, 'new parent/bin/tracker'));
  await assertUntracked(path.join(await scratch(), 'tracker'));
});
