import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { nodeArchive, seaConfig } from '../../shared/node/seaBuild.ts';
import { sha256File } from '../../shared/node/hash.ts';
import { withWorkDirectory } from '../../shared/node/files.ts';

import {
  ensureNodeArchive,
  parseBuildArgs,
  publishFile,
  readNodeRuntime,
} from '../../relay/scripts/buildSteps.mts';
import { temporary } from './helpers.js';

const root = new URL('../../', import.meta.url).pathname;
const manifest = JSON.parse(await readFile(new URL('../../relay/build/node-runtime.json', import.meta.url)));

test('GR-01: сборщик публикует SEA под новым именем', async () => {
  const source = await readFile(path.join(root, 'relay/scripts/build.mts'), 'utf8');

  assert.ok(source.includes("publishFile(path.join(work, 'grigdesk-relay'), " +
    "path.join(outDir, 'grigdesk-relay'))"));
});

test('RL-41: аргументы сборки', () => {
  const relay = path.join(root, 'relay');
  const cwd = '/tmp/папка с пробелами';

  assert.deepEqual(parseBuildArgs([], cwd, relay), { outDir: path.join(root, 'bin') });
  assert.deepEqual(parseBuildArgs(['--out-dir', 'x'], cwd, relay), { outDir: path.resolve(cwd, 'x') });
  assert.deepEqual(parseBuildArgs(['--out-dir', '/tmp/x'], cwd, relay), { outDir: '/tmp/x' });

  for (const args of [['--out-dir'], ['--out-dir', ''], ['--out-dir', 'x', '--out-dir', 'y'], ['--foo']]) {
    assert.equal(typeof parseBuildArgs(args, cwd, relay).error, 'string');
  }
});

test('RL-42: запись Node и имя официального архива', () => {
  assert.deepEqual(readNodeRuntime(manifest), manifest);
  assert.equal(manifest.version, '24.21.0');
  assert.equal(manifest.sha256, 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6');

  for (const patch of [
    { version: '22.1.0' },
    { version: '24.21' },
    { platform: 'linux-arm64' },
    { sha256: 'a'.repeat(63) },
    { sha256: 'A'.repeat(64) },
  ]) {
    assert.throws(() => readNodeRuntime({
      ...manifest,
      ...patch,
    }), /Некорректный relay/);
  }

  assert.deepEqual(nodeArchive(manifest), {
    name: 'node-v24.21.0-linux-x64.tar.xz',
    directory: 'node-v24.21.0-linux-x64',
    url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz',
  });
});

test('RL-43: кэш архива, повторы сети и очистка неверной загрузки', async (t) => {
  const bytes = Buffer.from('проверенный архив');
  const runtime = {
    ...manifest,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };

  for (const scenario of ['верный', 'неверный', 'три неверных', 'две ошибки сети']) {
    await t.test(scenario, async (t) => {
      const cache = await temporary(t);
      const archive = path.join(cache, 'node-v24.21.0-linux-x64.tar.xz');
      let calls = 0;

      if (scenario === 'верный' || scenario === 'неверный') {
        await writeFile(archive, scenario === 'верный' ? bytes : 'испорчен');
      }

      const options = {
        attempts: 3,
        pauseMs: 0,
        download: async (url, file) => {
          calls += 1;
          assert.equal(url, nodeArchive(runtime).url);

          if (scenario === 'две ошибки сети' && calls < 3) {
            await writeFile(file, 'неполная загрузка');

            throw new Error('обрыв сети');
          }

          await writeFile(file, scenario === 'три неверных' ? 'неверный' : bytes);
        },
      };

      if (scenario === 'три неверных') {
        await assert.rejects(() => ensureNodeArchive(runtime, cache, options));
        assert.equal(calls, 3);
        assert.deepEqual(await readdir(cache), []);
      } else {
        const file = await ensureNodeArchive(runtime, cache, options);

        assert.equal(calls, scenario === 'верный' ? 0 : scenario === 'неверный' ? 1 : 3);
        assert.equal(file, archive);
        assert.equal(await sha256File(file), runtime.sha256);
        assert.deepEqual(await readFile(file), bytes);
        assert.deepEqual(await readdir(cache), [path.basename(archive)]);
      }
    });
  }
});

test('RL-44: рабочий каталог удаляется при успехе и ошибке', async (t) => {
  const cache = await temporary(t);
  let work;

  assert.equal(await withWorkDirectory(cache, async (directory) => {
    work = directory;
    await writeFile(path.join(directory, 'часть'), 'байты');

    return 42;
  }), 42);
  await assert.rejects(() => stat(work), { code: 'ENOENT' });

  const failure = new Error('ошибка шага');

  await assert.rejects(() => withWorkDirectory(cache, async (directory) => {
    work = directory;

    throw failure;
  }), (error) => error === failure);
  await assert.rejects(() => stat(work), { code: 'ENOENT' });
});

test('RL-44: атомарная публикация сохраняет прежний файл при ошибке', async (t) => {
  const directory = await temporary(t);
  const source = path.join(directory, 'source');
  const output = path.join(directory, 'новая папка');
  const target = path.join(output, 'grigdesk-relay');

  await mkdir(output);
  await writeFile(source, 'новый файл');
  await writeFile(target, 'старый файл');
  await publishFile(source, target);
  assert.equal(await readFile(target, 'utf8'), 'новый файл');
  assert.equal((await stat(target)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(output), ['grigdesk-relay']);
  await assert.rejects(() => publishFile(path.join(directory, 'нет'), target));
  assert.equal(await readFile(target, 'utf8'), 'новый файл');
  assert.deepEqual(await readdir(output), ['grigdesk-relay']);
  await publishFile(source, path.join(directory, 'ещё нет', 'grigdesk-relay'));
  assert.equal(await readFile(path.join(directory, 'ещё нет', 'grigdesk-relay'), 'utf8'), 'новый файл');
});

test('RL-44: SEA config точно задаёт лицензию и изоляцию аргументов Node', () => {
  assert.deepEqual(seaConfig(), {
    main: 'bundle.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: 'none',
    assets: { 'NODE-LICENSE': 'LICENSE' },
  });
});
