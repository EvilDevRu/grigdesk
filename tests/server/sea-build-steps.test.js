import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SEA_REQUIRE_BANNER,
  buildSeaBinary,
  postjectCli,
} from '../../server/scripts/sea/buildSteps.mts';
import { nodeArchive } from '../../shared/node/seaBuild.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Отдельная временная папка для одного сценария сборки.
 * Уборка удаляет только собственный каталог теста.
 */
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-steps-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return root;
}

/**
 * Готовит фальшивый packageDir с manifest runtime и установленным postject.
 * Настоящий архив и postject не нужны: внешние команды подменяются тестом.
 */
async function packageFixture(t, runtime) {
  const packageDir = await scratch(t);

  await mkdir(path.join(packageDir, 'build'), {
    recursive: true
  });
  await mkdir(path.join(packageDir, 'node_modules/postject'), {
    recursive: true
  });
  await writeFile(path.join(packageDir, 'build/node-runtime.json'), JSON.stringify(runtime));
  await writeFile(path.join(packageDir, 'node_modules/postject/package.json'), JSON.stringify({
    name: 'postject',
    bin: {
      postject: 'cli.js'
    }
  }));
  await writeFile(path.join(packageDir, 'node_modules/postject/cli.js'), '');

  return packageDir;
}

/**
 * Подменяет tar, подготовку blob и postject предсказуемыми шагами.
 * Сценарий решает, какая именно внешняя команда должна упасть.
 */
function fakeRun(events, scenario) {
  return async (file, args, options = {}) => {
    events.push([file, args]);

    if (path.basename(file) === 'tar') {
      const work = args[args.indexOf('-C') + 1];

      await mkdir(path.join(work, 'bin'), {
        recursive: true
      });
      await writeFile(path.join(work, 'bin/node'), 'фейковый node');
      await writeFile(path.join(work, 'LICENSE'), 'лицензия');

      return { stdout: '', stderr: '' };
    }

    if (args[0] === '--experimental-sea-config') {
      await writeFile(path.join(options.cwd, 'sea-prep.blob'), 'blob');

      return { stdout: '', stderr: '' };
    }

    if (args[2] === 'NODE_SEA_BLOB' && scenario === 'postject-fail') {
      throw new Error('postject упал');
    }

    return { stdout: '', stderr: '' };
  };
}

/**
 * Пишет загрузку архива ровно с тем содержимым, чей хэш записан в manifest.
 * Проверка SHA256 в ensureNodeArchive при этом остаётся настоящей.
 */
function fakeDownload(bytes) {
  return async (url, file) => {
    await writeFile(file, bytes);
  };
}

function baseInput(packageDir, target, cacheDir) {
  return {
    packageDir,
    entryPoint: path.join(packageDir, 'entry.mjs'),
    target,
    cacheDir,
    banner: SEA_REQUIRE_BANNER,
    download: fakeDownload('фейковый архив'),
    esbuild: async () => ({ warnings: [] }),
  };
}

test('SEA-BS-01: runtime закреплён и совпадает у b24, relay и server', async () => {
  const server = JSON.parse(await readFile(path.join(ROOT, 'server/build/node-runtime.json'), 'utf8'));
  const b24 = JSON.parse(await readFile(path.join(ROOT, 'b24/build/node-runtime.json'), 'utf8'));
  const relay = JSON.parse(await readFile(path.join(ROOT, 'relay/build/node-runtime.json'), 'utf8'));

  assert.deepEqual(server, {
    version: '24.21.0',
    platform: 'linux-x64',
    sha256: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
  });
  assert.deepEqual(server, b24);
  assert.deepEqual(server, relay);
  assert.equal(nodeArchive(server).name, 'node-v24.21.0-linux-x64.tar.xz');
});

test('SEA-BS-02: ошибка платформы и manifest не трогают прежний файл', async (t) => {
  const runtime = {
    version: '24.21.0',
    platform: 'linux-x64',
    sha256: createHash('sha256').update('фейковый архив').digest('hex'),
  };
  const packageDir = await packageFixture(t, runtime);
  const cacheDir = await scratch(t);
  const target = path.join(await scratch(t), 'R/server/grigdesk-server');

  await mkdir(path.dirname(target), {
    recursive: true
  });
  await writeFile(target, 'старый файл');

  const input = baseInput(packageDir, target, cacheDir);

  await assert.rejects(
    buildSeaBinary({
      ...input,
      platform: 'darwin'
    }),
    /Linux x64/,
  );
  await assert.rejects(
    buildSeaBinary({
      ...input,
      platform: 'linux',
      arch: 'arm64'
    }),
    /Linux x64/,
  );

  await writeFile(path.join(packageDir, 'build/node-runtime.json'), JSON.stringify({
    ...runtime,
    platform: 'darwin-x64'
  }));
  await assert.rejects(buildSeaBinary(input), /Некорректный server/);

  assert.equal(await readFile(target, 'utf8'), 'старый файл');
});

test('SEA-BS-03: посторонняя загрузка кэша не подменяет правильный хэш', async (t) => {
  const runtime = {
    version: '24.21.0',
    platform: 'linux-x64',
    sha256: createHash('sha256').update('фейковый архив').digest('hex'),
  };
  const packageDir = await packageFixture(t, runtime);
  const cacheDir = await scratch(t);
  const target = path.join(await scratch(t), 'R/server/grigdesk-server');
  const archive = path.join(cacheDir, nodeArchive(runtime).name);

  await writeFile(archive, 'испорченный кэш');
  await mkdir(path.dirname(target), {
    recursive: true
  });
  await writeFile(target, 'старый файл');

  let downloads = 0;
  const input = {
    ...baseInput(packageDir, target, cacheDir),
    download: async (url, file) => {
      downloads += 1;
      await writeFile(file, 'фейковый архив');
    },
    run: fakeRun([], 'success'),
    probe: async () => {},
  };
  const result = await buildSeaBinary(input);

  assert.equal(downloads, 1);
  assert.equal(await readFile(archive, 'utf8'), 'фейковый архив');
  assert.deepEqual((await readdir(cacheDir)).filter((entry) => entry.includes('.part')), []);
  assert.equal(result.binary, target);
  assert.equal(await readFile(target, 'utf8'), 'фейковый node');
  assert.equal((await stat(target)).mode & 0o777, 0o755);
});

test('SEA-BS-04: ошибка postject не публикует и не портит прежний файл', async (t) => {
  const runtime = {
    version: '24.21.0',
    platform: 'linux-x64',
    sha256: createHash('sha256').update('фейковый архив').digest('hex'),
  };
  const packageDir = await packageFixture(t, runtime);
  const cacheDir = await scratch(t);
  const outDir = await scratch(t);
  const target = path.join(outDir, 'R/server/grigdesk-server');
  const events = [];

  await mkdir(path.dirname(target), {
    recursive: true
  });
  await writeFile(target, 'старый файл');

  await assert.rejects(buildSeaBinary({
    ...baseInput(packageDir, target, cacheDir),
    run: fakeRun(events, 'postject-fail'),
    probe: async () => {
      throw new Error('проба не должна вызываться');
    },
  }), /postject упал/);

  assert.equal(await readFile(target, 'utf8'), 'старый файл');
  assert.deepEqual(await readdir(path.dirname(target)), ['grigdesk-server']);
  assert.ok(events.some(([, args]) => args[2] === 'NODE_SEA_BLOB'));
});

test('SEA-BS-05: провал пробы не публикует и не портит прежний файл', async (t) => {
  const runtime = {
    version: '24.21.0',
    platform: 'linux-x64',
    sha256: createHash('sha256').update('фейковый архив').digest('hex'),
  };
  const packageDir = await packageFixture(t, runtime);
  const cacheDir = await scratch(t);
  const outDir = await scratch(t);
  const target = path.join(outDir, 'R/server/grigdesk-server');
  const calls = [];

  await mkdir(path.dirname(target), {
    recursive: true
  });
  await writeFile(target, 'старый файл');

  await assert.rejects(buildSeaBinary({
    ...baseInput(packageDir, target, cacheDir),
    run: fakeRun([], 'success'),
    probe: async (binary) => {
      calls.push(binary);
      assert.equal(await readFile(target, 'utf8'), 'старый файл');
      assert.match(path.basename(binary), /^\.grigdesk-server-.*\.tmp$/);
      assert.equal(await readFile(binary, 'utf8'), 'фейковый node');

      throw new Error('проба не прошла');
    },
  }), /проба не прошла/);

  assert.equal(calls.length, 1);
  assert.equal(await readFile(target, 'utf8'), 'старый файл');
  assert.deepEqual(await readdir(path.dirname(target)), ['grigdesk-server']);
});

test('SEA-BS-06: успешная проба публикует готовый файл атомарно', async (t) => {
  const runtime = {
    version: '24.21.0',
    platform: 'linux-x64',
    sha256: createHash('sha256').update('фейковый архив').digest('hex'),
  };
  const packageDir = await packageFixture(t, runtime);
  const cacheDir = await scratch(t);
  const outDir = await scratch(t);
  const target = path.join(outDir, 'R/server/grigdesk-server');
  let probed = '';

  await mkdir(path.dirname(target), {
    recursive: true
  });
  await writeFile(target, 'старый файл');

  const result = await buildSeaBinary({
    ...baseInput(packageDir, target, cacheDir),
    run: fakeRun([], 'success'),
    probe: async (binary) => {
      probed = binary;
      assert.equal(await readFile(target, 'utf8'), 'старый файл');
    },
  });

  assert.ok(probed.endsWith('.tmp'));
  assert.equal(result.binary, target);
  assert.equal(await readFile(target, 'utf8'), 'фейковый node');
  assert.equal(result.size, (await stat(target)).size);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readdir(path.dirname(target)), ['grigdesk-server']);
});

test('SEA-BS-07: postject и banner заданы контрактом', async (t) => {
  const packageDir = await scratch(t);

  await mkdir(path.join(packageDir, 'node_modules/postject'), {
    recursive: true
  });
  await writeFile(path.join(packageDir, 'node_modules/postject/package.json'), JSON.stringify({
    bin: 'bin/postject.js'
  }));
  await chmod(packageDir, 0o755);

  assert.equal(await postjectCli(packageDir),
    path.join(packageDir, 'node_modules/postject/bin/postject.js'));
  assert.match(SEA_REQUIRE_BANNER, /createRequire/);
  assert.match(SEA_REQUIRE_BANNER, /realpathSync\(process\.execPath\)/);
  assert.match(SEA_REQUIRE_BANNER, /'package\.json'/);
});
