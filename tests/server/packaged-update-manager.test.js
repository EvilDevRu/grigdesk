import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { PackagedUpdateManager } from '../../server/src/lib/packagedRelease.ts';

const execute = promisify(execFile);

/**
 * Установка-фикстура: portable-раскладка с описью bin/bundle.json; серверная «проба» —
 * скрипт, печатающий версию из PKG_VERSION (по умолчанию — своя, установленная).
 */
async function install(t, version = '0.2.0') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-install-'));

  t.after(() => {
    return fs.rm(dir, {
      recursive: true,
      force: true
    });
  });
  await fs.writeFile(path.join(dir, 'release.json'), JSON.stringify({
    schema: 1,
    packagingVersion: 1,
    version,
    contentId: 'e'.repeat(64),
  }));
  await fs.mkdir(path.join(dir, 'bin'), { recursive: true });
  await fs.writeFile(path.join(dir, 'bin/bundle.json'), JSON.stringify({
    format: 1,
    kind: 'portable',
    version,
    commit: 'a'.repeat(40),
    dirty: false,
    files: [],
  }));
  await fs.writeFile(path.join(dir, 'bin/grigdesk-server'), [
    '#!/usr/bin/env bash',
    'echo "{\"version\": \"${PKG_VERSION:-' + version + '\"}"',
  ].join('\n'), { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'bin/grigdesk-ctl'), '#!/bin/sh\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'GrigDesk'), 'window', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'README.md'), 'old readme');

  return dir;
}

/**
 * Выпуск-фикстура: staging release/ новой версии, настоящий tar, суммы и подпись.
 */
async function release(t, version, privateKey, tamperSignature = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-release-'));
  const { createHash } = await import('node:crypto');

  t.after(() => {
    return fs.rm(dir, {
      recursive: true,
      force: true
    });
  });
  const stage = path.join(dir, 'release');

  await fs.mkdir(path.join(stage, 'bin'), { recursive: true });
  await fs.writeFile(path.join(stage, 'bin/bundle.json'), JSON.stringify({
    format: 1,
    kind: 'portable',
    version,
    commit: 'a'.repeat(40),
    dirty: false,
    files: [],
  }));
  await fs.writeFile(path.join(stage, 'bin/grigdesk-server'), [
    '#!/usr/bin/env bash',
    `echo "{\\"version\\": \\"${version}\\"}"`,
  ].join('\n'), { mode: 0o755 });
  await fs.writeFile(path.join(stage, 'bin/grigdesk-ctl'), '#!/bin/sh\n', { mode: 0o755 });
  await fs.writeFile(path.join(stage, 'GrigDesk'), 'window-new', { mode: 0o755 });
  await fs.writeFile(path.join(stage, 'README.md'), 'new readme');

  const archive = path.join(dir, 'release.tar.gz');

  await execute('tar', ['-czf', archive, '-C', dir, 'release']);

  const archiveSha = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  const bundleSha = createHash('sha256')
    .update(await fs.readFile(path.join(stage, 'bin/bundle.json'))).digest('hex');
  const checksum = `${archiveSha}  release.tar.gz\n${bundleSha}  release/bin/bundle.json\n`;
  let signature = signBytes(null, Buffer.from(checksum, 'utf8'), privateKey)
    .toString('base64');

  if (tamperSignature) {
    signature = Buffer.alloc(64, 9).toString('base64');
  }

  const entry = {
    version,
    commit: 'a'.repeat(40),
    archiveSha256: archiveSha,
    archiveSize: (await fs.stat(archive)).size,
    bundleSha256: bundleSha,
    signature,
    archiveUrl: `https://grigdesk.test/releases/${version}/release.tar.gz`,
    compat: {
      os: 'linux',
      arch: 'x64',
      glibc: '2.28'
    },
  };

  return {
    dir,
    archiveSha,
    entry
  };
}

/**
 * Опции менеджера: изолированные statePath/workRoot, подставной fetch со счётчиком,
 * опциональные prober/publicKeyPem/onRestart.
 */
function options(root, rel, publicKey, overrides = {}) {
  const statePath = path.join(root,
    `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  return {
    installRoot: root,
    statePath,
    workRoot: path.dirname(statePath),
    channel: { latest: async () => {
      return rel.entry;
    } },
    publicKeyPem: String(publicKey.export({
      type: 'spki',
      format: 'pem'
    })),
    fetcher: async () => {
      options.fetches += 1;

      return new Response(await fs.readFile(path.join(rel.dir, 'release.tar.gz')));
    },
    onRestart: async () => {},
    ...overrides,
  };
}

options.fetches = 0;

/**
 * Ожидание ограничено числом попыток и читает только сохранённый снимок задания.
 * Возвращается первый терминальный исход либо ожидание ручного перезапуска.
 */
async function waitTerminal(manager, attempts = 600) {
  for (let i = 0; i < attempts; i += 1) {
    const job = await manager.getJob();

    if (job && ['restarting', 'completed', 'failed'].includes(job.status)) {
      return job;
    }
    await new Promise((resolve) => {
      return setTimeout(resolve, 10);
    });
  }

  throw new Error('задание не достигло терминального состояния');
}

test('PUM-1: успешное обновление заменяет bin, GrigDesk и README с резервами', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const root = await install(t, '0.2.0');
  const rel = await release(t, '0.3.0', privateKey);
  const manager = new PackagedUpdateManager(options(root, rel, publicKey));

  const job = await manager.startPackageUpdate({
    expectedVersion: '0.3.0',
    expectedArchiveSha256: rel.archiveSha,
  });
  const done = await waitTerminal(manager);

  assert.equal(done.status, 'restarting');
  assert.equal(done.targetVersion, '0.3.0');
  assert.equal(await fs.readFile(path.join(root, 'GrigDesk'), 'utf8'), 'window-new');
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'new readme');
  assert.ok(done.backups?.bin, 'резерв bin записан');
  assert.ok(job.id);
});

test('PUM-2: порча архива — отказ до замены, установка цела', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const root = await install(t, '0.2.0');
  const rel = await release(t, '0.3.0', privateKey);
  const manager = new PackagedUpdateManager(options(root, rel, publicKey, {
    fetcher: async () => {
      options.fetches += 1;

      return new Response('BROKEN');
    },
  }));

  await manager.startPackageUpdate({
    expectedVersion: '0.3.0',
    expectedArchiveSha256: rel.archiveSha,
  });
  const failed = await waitTerminal(manager);

  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'package_archive_mismatch');
  assert.equal(await fs.readFile(path.join(root, 'GrigDesk'), 'utf8'), 'window');
});

test('PUM-3: отказ пробы нового бинарника — замены нет', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const root = await install(t, '0.2.0');
  const rel = await release(t, '0.3.0', privateKey);
  const manager = new PackagedUpdateManager(options(root, rel, publicKey, {
    prober: async () => {
      throw new Error('probe failed');
    },
  }));

  await manager.startPackageUpdate({
    expectedVersion: '0.3.0',
    expectedArchiveSha256: rel.archiveSha,
  });
  const failed = await waitTerminal(manager);

  assert.equal(failed.error?.code, 'package_probe_failed');
  assert.equal(await fs.readFile(path.join(root, 'GrigDesk'), 'utf8'), 'window');
});

test('PUM-4: повторный запуск во время задания — 409', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const root = await install(t, '0.2.0');
  const rel = await release(t, '0.3.0', privateKey);
  let releaseFetch;
  const gate = new Promise((resolve) => {
    releaseFetch = resolve;
  });

  const manager = new PackagedUpdateManager(options(root, rel, publicKey, {
    fetcher: async () => {
      await gate;

      return new Response(await fs.readFile(path.join(rel.dir, 'release.tar.gz')));
    },
  }));

  const job = await manager.startPackageUpdate({
    expectedVersion: '0.3.0',
    expectedArchiveSha256: rel.archiveSha,
  });

  await assert.rejects(
    manager.startPackageUpdate({
      expectedVersion: '0.3.0',
      expectedArchiveSha256: rel.archiveSha,
    }),
    (error) => {
      return error.statusCode === 409;
    },
  );

  releaseFetch();
  await waitTerminal(manager);
  void job;
});

test('PUM-5: recover после обрыва до замены помечает interrupted', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const root = await install(t, '0.2.0');
  const rel = await release(t, '0.3.0', privateKey);
  const opts = options(root, rel, publicKey, {
    // Никогда не резолвится и не держит event loop: эмуляция смерти процесса.
    fetcher: () => {
      return new Promise(() => {});
    },
  });

  const first = new PackagedUpdateManager(opts);

  await first.startPackageUpdate({
    expectedVersion: '0.3.0',
    expectedArchiveSha256: rel.archiveSha,
  });

  // Ждём стадию downloading: после её записи зависший fetcher не пишет состояние,
  // recover второго менеджера детерминированно видит активное задание.
  for (let i = 0; i < 600; i += 1) {
    const job = await first.getJob();

    if (job?.status === 'downloading') {
      break;
    }
    await new Promise((resolve) => {
      return setTimeout(resolve, 5);
    });
  }

  const second = new PackagedUpdateManager(opts);

  await second.recover();
  const job = await second.getJob();

  assert.equal(job?.status, 'failed');
  assert.equal(job?.error?.code, 'package_update_interrupted');
});

test('PUM-6: подделанная подпись — release_signature_invalid до скачивания', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const root = await install(t, '0.2.0');
  const rel = await release(t, '0.3.0', privateKey, true);
  const before = options.fetches;
  const manager = new PackagedUpdateManager(options(root, rel, publicKey));

  await manager.startPackageUpdate({
    expectedVersion: '0.3.0',
    expectedArchiveSha256: rel.archiveSha,
  });
  const failed = await waitTerminal(manager);

  assert.equal(failed.error?.code, 'release_signature_invalid');
  assert.equal(options.fetches, before, 'скачивание не начиналось');
  assert.equal(await fs.readFile(path.join(root, 'GrigDesk'), 'utf8'), 'window');
});

test('PUM-7: пустой публичный ключ — release_signing_key_missing до скачивания', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const root = await install(t, '0.2.0');
  const rel = await release(t, '0.3.0', privateKey);
  const before = options.fetches;
  const manager = new PackagedUpdateManager(options(root, rel, publicKey,
    { publicKeyPem: '' }));

  await manager.startPackageUpdate({
    expectedVersion: '0.3.0',
    expectedArchiveSha256: rel.archiveSha,
  });
  const failed = await waitTerminal(manager);

  assert.equal(failed.error?.code, 'release_signing_key_missing');
  assert.equal(options.fetches, before, 'скачивание не начиналось');
});

test('PUM-8: recover в середине замены возвращает резервы на место', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  void privateKey;
  void publicKey;

  const root = await install(t, '0.2.0');
  const backup = path.join(root, 'bin.grigdesk-backup-j1');

  await fs.rename(path.join(root, 'bin'), backup);

  const statePath = path.join(root, 'state-applying.json');

  await fs.writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    job: {
      id: 'j1',
      kind: 'package-update',
      status: 'applying',
      stage: 'applying',
      targetVersion: '0.3.0',
      expectedArchiveSha256: 'a'.repeat(64),
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      completedAt: null,
      progress: null,
      backups: {
        bin: backup,
        window: null,
        readme: null
      },
      error: null,
    },
  }));
  const manager = new PackagedUpdateManager({
    installRoot: root,
    statePath,
    workRoot: root,
    channel: { latest: async () => {
      return null;
    } },
    onRestart: async () => {},
  });

  await manager.recover();
  const job = await manager.getJob();

  assert.equal(job?.status, 'failed');
  assert.equal(job?.error?.code, 'package_apply_interrupted');
  assert.match(await fs.readFile(path.join(root, 'bin/grigdesk-server'), 'utf8'),
    /0\.2\.0/, 'резерв bin возвращён');
});

test('PUM-9/LIVE-NO-PROOF: новая версия на диске не подтверждает живую пару', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const root = await install(t, '0.2.0');
  const rel = await release(t, '0.3.0', privateKey);
  const opts = options(root, rel, publicKey);
  const first = new PackagedUpdateManager(opts);

  await first.startPackageUpdate({
    expectedVersion: '0.3.0',
    expectedArchiveSha256: rel.archiveSha,
  });
  const done = await waitTerminal(first);

  assert.equal(done.status, 'restarting');

  const second = new PackagedUpdateManager(opts);

  await second.recover();
  const job = await second.getJob();

  assert.notEqual(job?.status, 'completed', 'нет boot proof ни от desktop, ни от нового сервера');
  assert.ok(await fs.stat(String(done.backups?.bin)), 'до подтверждения резерв должен сохраняться');
});

test('PUM-10: прогресс скачивания отражается в задании', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const root = await install(t, '0.2.0');
  const rel = await release(t, '0.3.0', privateKey);
  const archive = await fs.readFile(path.join(rel.dir, 'release.tar.gz'));
  const total = archive.byteLength;
  const manager = new PackagedUpdateManager(options(root, rel, publicKey, {
    // Чанками с паузой: первая троттл-запись гарантированно попадает в файл состояния.
    fetcher: async () => {
      const chunks = [archive.slice(0, Math.floor(total / 2)),
        archive.slice(Math.floor(total / 2))];

      return new Response(new ReadableStream({
        /**
         * Половина реального архива удерживает downloader на измеримой границе.
         * До разрешения проверяется сохранённый journal, после него поток закрывается.
         */
        async start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
            await new Promise((resolve) => {
              return setTimeout(resolve, 40);
            });
          }
          controller.close();
        },
      }));
    },
  }));

  await manager.startPackageUpdate({
    expectedVersion: '0.3.0',
    expectedArchiveSha256: rel.archiveSha,
  });

  let seen = null;

  for (let i = 0; i < 600 && !seen; i += 1) {
    const job = await manager.getJob();

    if (job?.progress?.downloadedBytes) {
      seen = job.progress;
    } else {
      await new Promise((resolve) => {
        return setTimeout(resolve, 5);
      });
    }
  }

  const terminal = await waitTerminal(manager);

  assert.ok(seen, 'прогресс появился в задании');
  assert.equal(seen.totalBytes, total);
  assert.equal(terminal.progress?.downloadedBytes, total,
    'итоговое задание сохраняет полный прогресс');
});

test('PUM-11: applying без резервов — manual_recovery_required', async (t) => {
  const root = await install(t, '0.2.0');
  const statePath = path.join(root, 'state-applying-null.json');

  await fs.writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    job: {
      id: 'j2',
      kind: 'package-update',
      status: 'applying',
      stage: 'applying',
      targetVersion: '0.3.0',
      expectedArchiveSha256: 'a'.repeat(64),
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      completedAt: null,
      progress: null,
      backups: null,
      error: null,
    },
  }));
  const manager = new PackagedUpdateManager({
    installRoot: root,
    statePath,
    workRoot: root,
    channel: { latest: async () => {
      return null;
    } },
    onRestart: async () => {},
  });

  await manager.recover();
  const job = await manager.getJob();

  assert.equal(job?.status, 'failed');
  assert.equal(job?.error?.code, 'manual_recovery_required');
  assert.match(job?.error?.message ?? '', /0\.2\.0|bin|GrigDesk/,
    'сообщение называет пути ручного восстановления');
});

test('PUM-12: раскладка без bin/bundle.json — 409 до задания', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const root = await install(t, '0.2.0');

  await fs.rm(path.join(root, 'bin/bundle.json'));
  const rel = await release(t, '0.3.0', privateKey);
  const manager = new PackagedUpdateManager(options(root, rel, publicKey));

  await assert.rejects(
    manager.startPackageUpdate({
      expectedVersion: '0.3.0',
      expectedArchiveSha256: rel.archiveSha,
    }),
    (error) => {
      return error.code === 'package_update_unsupported_layout'
      && error.statusCode === 409;
    },
  );
  assert.equal(await manager.getJob(), null, 'задание не создано');
});

test('PUM-13: recover до первого rename сохраняет текущее имя без физического резерва', async (t) => {
  const root = await install(t);
  const statePath = path.join(root, 'write-ahead-state.json');

  await fs.writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    job: {
      id: 'j3',
      kind: 'package-update',
      status: 'applying',
      stage: 'applying',
      targetVersion: '0.3.0',
      backups: {
        bin: path.join(root, 'bin.grigdesk-backup-j3'),
        window: null,
        readme: null,
      },
      error: null,
    },
  }));

  const manager = new PackagedUpdateManager({
    installRoot: root,
    statePath,
  });

  await manager.recover();
  assert.match(await fs.readFile(path.join(root, 'bin/grigdesk-server'), 'utf8'), /0\.2\.0/);
  assert.equal((await manager.getJob())?.error?.code, 'package_apply_interrupted');
});

test('PUM-14: неверный JSON и чужая версия пробы получают package_probe_failed', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  for (const output of ['not JSON', '{"version":"0.9.0"}']) {
    const root = await install(t);
    const rel = await release(t, '0.3.0', privateKey);
    const manager = new PackagedUpdateManager(options(root, rel, publicKey, {
      prober: async () => {
        return output;
      },
    }));

    await manager.startPackageUpdate({
      expectedVersion: '0.3.0',
      expectedArchiveSha256: rel.archiveSha,
    });
    const job = await waitTerminal(manager);

    assert.equal(job.error?.code, 'package_probe_failed');
    assert.equal(await fs.readFile(path.join(root, 'GrigDesk'), 'utf8'), 'window');
  }
});

// Зарегистрированная установка проверяется настоящим менеджером и архивами,
// отдельно от исторического portable adapter и его неизменяемых барьеров.
const { installedFixture, installedRelease } = await import('../helpers/installedUpdateFixture.mjs');

 test('PREP-PAIR/PREP-LATER: обе части готовы, current и данные прежние', async (t) => {
  const box = await installedFixture(t);
  const job = await box.create();
  const ready = await box.manager.prepare(job.id);

  assert.equal(ready.stage, 'ready');
  assert.equal(ready.intent, null);
  assert.equal(ready.progress, null);
  assert.deepEqual(await box.pointer(), box.previous);

  for (const component of ['desktop', 'server']) {
    const file = box.release.files.get(component);
    const absolute = path.join(box.root, 'update', job.id, component, file.name);

    assert.deepEqual(await fs.readFile(absolute), file.bytes);
    assert.equal((await fs.stat(absolute)).mode & 0o777, 0o555);
  }

  assert.equal((await box.manager.prepare(job.id)).id, job.id);
  await box.preserved();
});

test('JOB-IDEMPOTENT/JOB-PINNED: потеря ответа и новый latest не меняют job', async (t) => {
  const release = installedRelease();
  let latest = release.envelope;
  const box = await installedFixture(t, { release, channel: { latest: async () => latest } });
  const job = await box.create('потерянный-ответ');

  latest = installedRelease({ version: '0.4.0' }).envelope;
  assert.deepEqual(await box.create('потерянный-ответ'), job);
  await assert.rejects(box.create('второй-запрос'), /release_update_in_progress/);
  await box.manager.prepare(job.id);
  assert.equal((await box.job()).manifestDigest, release.manifestDigest);
  assert.equal((await box.job()).envelope.payload.version, release.identity.version);
  assert.deepEqual(await box.pointer(), box.previous);
});

for (const entryName of ['../outside', '/absolute']) {
  test(`PREP-FAIL: архив ${entryName} не выходит из staging`, async (t) => {
    const box = await installedFixture(t, { release: installedRelease({ entryName }) });
    const job = await box.create();

    await assert.rejects(box.manager.prepare(job.id), /release_archive_entry_invalid/);
    assert.deepEqual(await box.pointer(), box.previous);
    assert.equal((await box.job()).stage, 'failed');
    assert.equal((await box.job()).error.nextAction, 'resume-update');
    await box.preserved();
  });
}

for (const failure of ['size', 'hash', 'second-download', 'probe']) {
  test(`PREP-FAIL: ${failure} сохраняет прежнюю пару`, async (t) => {
    const release = installedRelease();
    const box = await installedFixture(t, {
      release,
      fetcher: async (url) => {
        const bytes = release.archives.get(String(url));

        if (String(url).includes('server') && failure === 'second-download') {
          return new Response('unavailable', { status: 503 });
        }

        const body = failure === 'size' ? bytes.subarray(1)
          : failure === 'hash' ? Buffer.alloc(bytes.length) : bytes;

        return new Response(body);
      },
      ...(failure === 'probe' ? { probe: async () => {
        throw new Error('probe_failed');
      } } : {}),
    });
    const job = await box.create();

    await assert.rejects(box.manager.prepare(job.id),
      /release_download_integrity_invalid|release_download_failed|probe_failed/);
    assert.deepEqual(await box.pointer(), box.previous);
    assert.equal((await box.job()).stage, 'failed');
    assert.equal((await box.job()).error.nextAction, 'resume-update');
    await box.preserved();
  });
}

test('PREP-PROGRESS: journal хранит реальные байты только во время downloading', async (t) => {
  const release = installedRelease();
  const held = Promise.withResolvers();
  let box;
  let observed;

  box = await installedFixture(t, {
    release,
    fetcher: async (url) => {
      const bytes = release.archives.get(String(url));
      const middle = Math.floor(bytes.length / 2);

      return new Response(new ReadableStream({
        /**
         * Половина реального архива удерживает downloader на измеримой границе.
         * До разрешения проверяется сохранённый journal, после него поток закрывается.
         */
        async start(controller) {
          controller.enqueue(bytes.subarray(0, middle));
          await held.promise;
          controller.enqueue(bytes.subarray(middle));
          controller.close();
        },
      }));
    },
  });

  const job = await box.create();
  const flight = box.manager.prepare(job.id);

  try {
    const deadline = Date.now() + 2000;

    while (Date.now() < deadline) {
      observed = await box.job();

      if (observed.stage === 'downloading' && observed.progress.downloadedBytes > 0) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(observed.stage, 'downloading');
    assert.equal(observed.progress.downloadedBytes,
      Math.floor(release.envelope.payload.artifacts.desktop.size / 2));
    assert.equal(observed.progress.totalBytes,
      release.envelope.payload.artifacts.desktop.size + release.envelope.payload.artifacts.server.size);
    assert.deepEqual(await box.pointer(), box.previous);
  } finally {
    held.resolve();
    await flight;
  }

  assert.equal((await box.job()).progress, null);
});

test('PREP-FAIL: реальный EACCES staging не меняет current и оставляет nextAction', async (t) => {
  const box = await installedFixture(t);
  const job = await box.create();
  const directory = path.join(box.root, 'update', job.id);

  await fs.mkdir(directory, { mode: 0o700 });
  await fs.chmod(directory, 0);

  try {
    await assert.rejects(box.manager.prepare(job.id), { code: 'EACCES' });
    assert.equal((await box.job()).stage, 'failed');
    assert.equal((await box.job()).error.nextAction, 'resume-update');
    assert.deepEqual(await box.pointer(), box.previous);
    await box.preserved();
  } finally {
    await fs.chmod(directory, 0o700);
  }
});

test('JOB-IDEMPOTENT: concurrent app+CLI создают один installation-bound journal', async (t) => {
  const box = await installedFixture(t);
  const results = await Promise.allSettled([box.create('app'), box.create('cli')]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');

  assert.equal(fulfilled.length, 1);
  assert.equal((await box.job()).id, fulfilled[0].value.id);
  assert.deepEqual(await box.pointer(), box.previous);
});

test('PREP-FAIL: настоящий ENOSPC в отдельном tmpfs staging сохраняет journal и данные', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'update-enospc-'));
  const script = path.join(directory, 'enospc.mjs');
  const helper = new URL('../helpers/installedUpdateFixture.mjs', import.meta.url).href;

  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(script, [
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "import { randomBytes } from 'node:crypto';",
    "import { execFile } from 'node:child_process';",
    "import { promisify } from 'node:util';",
    `import { installedFixture, installedRelease } from ${JSON.stringify(helper)};`,
    'const execute = promisify(execFile);',
    'const hooks = [];',
    'const release = installedRelease({',
    '  script: (_part, _identity, source) => source + "#" + randomBytes(2 * 1024 * 1024).toString("base64"),',
    '});',
    'const box = await installedFixture({ after: (hook) => hooks.push(hook) }, { mode: "server", release });',
    'const job = await box.create();',
    'const staging = path.join(box.root, "update", job.id);',
    'await fs.mkdir(staging, { mode: 0o700 });',
    'await execute("mount", ["-t", "tmpfs", "-o", "size=512k,mode=0700", "tmpfs", staging]);',
    'try {',
    '  await assert.rejects(box.manager.prepare(job.id), { code: "ENOSPC" });',
    '  assert.equal((await box.job()).stage, "failed");',
    '  assert.equal((await box.job()).error.nextAction, "resume-update");',
    '  assert.deepEqual(await box.pointer(), box.previous);',
    '  await box.preserved();',
    '  process.stdout.write("ENOSPC_OBSERVED\\n");',
    '} finally {',
    '  await execute("umount", [staging]);',
    '  for (const hook of hooks) await hook();',
    '}',
  ].join('\n'));

  const result = await execute('unshare', ['-Urnm', process.execPath, script], {
    env: { HOME: directory, PATH: '/usr/bin:/bin' },
    timeout: 10000,
  });

  assert.match(result.stdout, /ENOSPC_OBSERVED/);
});
