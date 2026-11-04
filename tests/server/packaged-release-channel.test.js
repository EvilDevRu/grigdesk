import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PackagedReleaseService } from '../../server/src/lib/packagedRelease.ts';

/**
 * Identity старой пакетной установки готовится в отдельном временном каталоге.
 * Фикстура не обращается к папке данных работающего приложения.
 */
async function packageRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'packaged-rel-'));

  t.after(() => {
    return fs.rm(dir, {
      recursive: true,
      force: true
    });
  });
  await fs.writeFile(path.join(dir, 'release.json'), JSON.stringify({
    schema: 1,
    packagingVersion: 1,
    version: '0.2.0',
    contentId: 'e'.repeat(64),
  }));

  return dir;
}

const channelWith = (version) => {
  return ({
  latest: async () => {
    return ({
    version,
      commit: 'a'.repeat(40),
      archiveSha256: 'b'.repeat(64),
      archiveSize: 10,
    bundleSha256: 'c'.repeat(64),
      signature: Buffer.alloc(64, 1).toString('base64'),
    archiveUrl: `https://grigdesk.com/releases/${version}/release.tar.gz`,
    compat: {
      os: 'linux',
      arch: 'x64',
      glibc: '2.28'
    },
  });
  },
});
};

test('PRC-1: свежая версия канала появляется в checkRemote с packageUpdate', async (t) => {
  const service = new PackagedReleaseService(await packageRoot(t), undefined,
    { channel: channelWith('0.3.0') });
  const status = await service.checkRemote();

  assert.equal(status.updateAvailable, true);
  assert.equal(status.latest?.version, '0.3.0');
  assert.equal(status.latest?.tag, 'v0.3.0');
  assert.equal(status.packageUpdate?.archiveSha256, 'b'.repeat(64));
});

test('PRC-2: GET-статус после checkRemote несёт снимок канала из кеша', async (t) => {
  let calls = 0;
  const service = new PackagedReleaseService(await packageRoot(t), undefined, {
    channel: { latest: async () => {
      calls += 1;

      return channelWith('0.3.0').latest();
    } },
  });

  await service.checkRemote();

  const local = await service.getStatus();

  assert.equal(local.latest?.version, '0.3.0', 'локальный GET вклеивает кеш канала');
  assert.equal(local.updateAvailable, true);
  assert.equal(calls, 1, 'повторный GET не ходит в сеть');
});

test('PRC-3: отказ канала даёт checkError и не роняет статус', async (t) => {
  const service = new PackagedReleaseService(await packageRoot(t), undefined, {
    channel: { latest: async () => {
      throw new Error('down');
    } },
  });
  const status = await service.checkRemote();

  assert.equal(status.latest, null);
  assert.equal(typeof status.checkError?.code, 'string');
  assert.equal(status.updateAvailable, false);
});

test('PRC-4: версия установки из bin/bundle.json приоритетнее identity', async (t) => {
  const root = await packageRoot(t);

  await fs.mkdir(path.join(root, 'bin'), { recursive: true });
  await fs.writeFile(path.join(root, 'bin/bundle.json'), JSON.stringify({
    format: 1,
    kind: 'portable',
    version: '0.2.5',
    commit: 'a'.repeat(40),
    dirty: false,
    files: [],
  }));

  const service = new PackagedReleaseService(root, undefined,
    { channel: channelWith('0.3.0') });
  const status = await service.checkRemote();

  assert.equal(status.updateAvailable, true);
  assert.equal(status.running.version, '0.2.5', 'версия установки читается из описи');
});

test('PRC-5: start() запускает фоновый опрос, stop() его снимает', async (t) => {
  let calls = 0;
  const service = new PackagedReleaseService(await packageRoot(t), undefined, {
    channel: { latest: async () => {
      calls += 1;

      return null;
    } },
    checkIntervalMs: 5,
  });

  service.start();
  await new Promise((resolve) => {
    return setTimeout(resolve, 30);
  });
  service.stop();

  const after = calls;

  await new Promise((resolve) => {
    return setTimeout(resolve, 30);
  });

  assert.ok(calls >= 1, 'таймер хотя бы раз сходил в канал');
  assert.equal(calls, after, 'после stop() канал не опрашивается');
});

test('PRC-6: ошибка после успеха сохраняется в локальном GET и скрывает старую цель', async (t) => {
  let failed = false;
  const service = new PackagedReleaseService(await packageRoot(t), undefined, {
    channel: {
      latest: async () => {
        if (failed) {
          throw new Error('канал недоступен');
        }

        return channelWith('0.3.0').latest();
      },
    },
  });

  await service.checkRemote();
  failed = true;
  await service.checkRemote();

  const status = await service.getStatus();

  assert.equal(status.latest, null);
  assert.equal(status.updateAvailable, false);
  assert.equal(status.checkError?.code, 'release_channel_unavailable');
});
