import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { desktopUsesBinary, prepareBuildRuntime } from '../../server/scripts/ctlBuild.mts';

const bytes = Buffer.from('закреплённый тестовый архив Node');

/**
 * Manifest и содержимое архива принадлежат тесту; настоящий Node не скачивается.
 * Подмена транспорта сохраняет штатные проверки SHA и атомарную публикацию кэша.
 */
async function archiveFixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ctl-build-runtime-'));
  const cache = path.join(temporary, 'cache with spaces');
  const manifestPath = path.join(temporary, 'node-runtime.json');
  const runtime = {
    version: '24.21.0',
    platform: 'linux-x64',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(cache);
  await fs.writeFile(manifestPath, JSON.stringify(runtime));

  return {
    temporary,
    cache,
    manifestPath,
    archive: path.join(cache, 'node-v24.21.0-linux-x64.tar.xz'),
  };
}

test('build Node: правильный локальный архив проверяется без сети', async (t) => {
  const box = await archiveFixture(t);

  await fs.writeFile(box.archive, bytes);

  const archive = await prepareBuildRuntime(box.cache, {
    manifestPath: box.manifestPath,
    download: async () => assert.fail('Локальный проверенный архив не требует сети'),
  });

  assert.equal(archive, box.archive);
  assert.deepEqual(await fs.readFile(archive), bytes);
});

test('build Node: отсутствие или неверный SHA используют штатный проверенный загрузчик', async (t) => {
  for (const corrupted of [false, true]) {
    const box = await archiveFixture(t);
    const requests = [];

    if (corrupted) {
      await fs.writeFile(box.archive, 'испорченный архив');
    }

    const archive = await prepareBuildRuntime(box.cache, {
      manifestPath: box.manifestPath,
      download: async (url, file) => {
        requests.push(url);
        assert.equal(path.dirname(file), box.cache);
        await fs.writeFile(file, bytes);
      },
    });

    assert.equal(archive, box.archive);
    assert.deepEqual(requests, ['https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz']);
    assert.deepEqual(await fs.readFile(archive), bytes);
    assert.deepEqual(await fs.readdir(box.cache), [path.basename(archive)]);
  }
});

test('build Node: сеть или неверный SHA дают ровно три попытки без публикации', async (t) => {
  for (const networkFailure of [false, true]) {
    const box = await archiveFixture(t);
    let attempts = 0;

    await assert.rejects(prepareBuildRuntime(box.cache, {
      manifestPath: box.manifestPath,
      pauseMs: 0,
      download: async (_url, file) => {
        attempts += 1;

        if (networkFailure) {
          throw new Error('нет сети');
        }

        await fs.writeFile(file, 'чужие байты');
      },
    }), networkFailure ? /нет сети/ : /Контрольная сумма/);
    assert.equal(attempts, 3);
    assert.deepEqual(await fs.readdir(box.cache), []);
  }
});

test('build Node: непригодный pin отклоняется до загрузки', async (t) => {
  const box = await archiveFixture(t);

  await fs.writeFile(box.manifestPath, JSON.stringify({ version: 'latest' }));
  await assert.rejects(prepareBuildRuntime(box.cache, {
    manifestPath: box.manifestPath,
    download: async () => assert.fail('Некорректный pin не должен обращаться к сети'),
  }), /Некорректный.*node-runtime/);
});

test('build descriptor: только полный v4 на выбранный ELF убирает подсказку без записи', async (t) => {
  for (const xdg of ['absolute', 'relative', 'missing']) {
    const box = await archiveFixture(t);
    const home = path.join(box.temporary, 'home');
    const binary = path.join(box.temporary, 'source with spaces/bin/grigdesk-server');
    const env = {
      XDG_DATA_HOME: xdg === 'missing' ? undefined : xdg === 'relative' ? 'relative' : box.temporary,
    };
    const descriptorFile = path.join(
      xdg === 'absolute' ? box.temporary : path.join(home, '.local/share'),
      'grigdesk/desktop/runtime.json',
    );
    const valid = {
      version: 4,
      kind: 'binary',
      binary,
      home: path.join(box.temporary, 'data'),
      cliPaths: [],
    };
    const descriptors = [
      ['{', false],
      [JSON.stringify({
        version: 3,
        kind: 'sea',
        root: '/legacy',
        home: '/data',
      }), false],
      [JSON.stringify({ ...valid, binary: '/another/bin/grigdesk-server' }), false],
      [JSON.stringify({ ...valid, cliPaths: ['relative'] }), false],
      [JSON.stringify(valid), true],
    ];

    const input = {
      env,
      home,
      binary,
    };

    assert.equal(await desktopUsesBinary(input), false);
    await fs.mkdir(path.dirname(descriptorFile), { recursive: true });

    for (const [text, expected] of descriptors) {
      await fs.writeFile(descriptorFile, text);
      assert.equal(await desktopUsesBinary(input), expected);
      assert.equal(await fs.readFile(descriptorFile, 'utf8'), text);
      assert.deepEqual(await fs.readdir(path.dirname(descriptorFile)), ['runtime.json']);
    }
  }
});
