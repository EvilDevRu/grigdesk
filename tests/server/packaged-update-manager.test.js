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

test('PUM-9: recover после рестарта подтверждает новую версию и чистит резервы', async (t) => {
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

  assert.equal(job?.status, 'completed');
  await assert.rejects(
    fs.stat(String(done.backups?.bin)),
    (error) => {
      return error.code === 'ENOENT';
    },
    'резерв удалён после подтверждения',
  );
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
