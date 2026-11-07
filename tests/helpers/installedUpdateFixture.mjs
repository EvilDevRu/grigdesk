import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:net';

import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { InstalledUpdateManager } from '../../shared/node/installedUpdate.ts';
import { probeInstalledComponent } from '../../shared/node/installedUpdateService.ts';
import { writeInstallationJson, readInstalledPointer } from '../../shared/node/installedLayout.ts';
import { readInstalledUpdate } from '../../shared/node/installedUpdateState.ts';
import { signedIndex, sha256 } from './releaseV2Fixture.mjs';

/**
 * Создаёт настоящий ustar с одной обычной записью и проверяемой контрольной суммой.
 * Имя можно испортить отдельно от подписанной описи для проверки traversal и links.
 */
export function archiveBytes(name, bytes, type = '0') {
  const header = Buffer.alloc(512);

  header.write(name, 0, 100);
  header.write('0000755\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);

  const checksum = header.reduce((sum, byte) => sum + byte, 0);

  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);

  return gzipSync(Buffer.concat([
    header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512), Buffer.alloc(1024),
  ]));
}

/**
 * Подписывает реальные архивы исполняемых проб, использующих identity того же payload.
 * Фикстура не возвращает готовый результат manager/apply вместо production-кода.
 */
export function installedRelease(options = {}) {
  const seed = signedIndex(options);
  const artifacts = {};
  const archives = new Map();
  const files = new Map();

  for (const component of ['desktop', 'server']) {
    const name = component === 'desktop' ? 'GrigDesk' : 'bin/grigdesk-server';
    const identity = component === 'desktop'
      ? { version: seed.identity.version, releaseId: seed.identity.releaseId }
      : { version: seed.identity.version, packageId: 'b'.repeat(64) };
    const defaultText = '#!/bin/sh\nprintf \'%s\\n\' \'' + JSON.stringify(identity) + '\'\n';
    const text = options.script?.(component, identity, defaultText) ?? defaultText;
    const bytes = Buffer.from(text);
    const archive = archiveBytes(options.entryName ?? name, bytes, options.entryType ?? '0');
    const entries = [{
      path: name,
      size: bytes.length,
      sha256: sha256(bytes),
      mode: 0o755,
    }];
    const url = `https://grigdesk.test/${seed.identity.version}/${component}.tar.gz`;

    artifacts[component] = {
      url,
      size: archive.length,
      sha256: sha256(archive),
      unpackedSize: bytes.length,
      files: entries,
      filesDigest: sha256(canonicalJson(entries)),
      buildIdentity: seed.identity,
      ...(component === 'server' ? { packageId: identity.packageId } : {}),
    };
    archives.set(url, archive);
    files.set(component, { name, bytes });
  }

  return {
    ...signedIndex({ ...options, payload: { ...options.payload, artifacts } }),
    archives,
    files,
  };
}

/**
 * Receipt, journal, поколения и данные расположены только в одноразовой папке.
 * Sentinels читаются после каждого эффекта: обновление программы не вправе менять данные.
 */
export async function installedFixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'installed-update-'));
  const root = path.join(temporary, 'installation');
  const dataHome = path.join(temporary, 'data');
  const userData = path.join(temporary, 'user');
  const mode = options.mode ?? 'local';
  const release = options.release ?? installedRelease(options);
  /** @type {import('../../shared/node/installedLayout.ts').InstallationReceipt} */
  const receipt = {
    format: 1,
    installationId: randomUUID(),
    uid: process.getuid(),
    root,
    mode,
    channel: release.identity.channel,
    dataHome,
    userData,
  };
  const previous = {
    format: 1,
    installationId: receipt.installationId,
    desktop: mode === 'server' ? null : 'generations/0.2.0/desktop',
    server: mode === 'remote' ? null : 'generations/0.2.0/server',
  };

  const cleanups = [];

  t.after(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }

    await fs.rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });

  for (const directory of [root, dataHome, userData, path.join(root, 'update'),
    ...[previous.desktop, previous.server].filter(Boolean).map((part) => path.join(root, part))]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }

  await writeInstallationJson(root, 'installation.json', receipt);
  await writeInstallationJson(root, 'current.json', previous);

  const sentinels = [path.join(dataHome, '.env'), path.join(userData, 'settings.json'),
    path.join(userData, 'pin'), path.join(userData, 'cookies')];

  const socket = createServer();

  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));

  const port = socket.address().port;

  await new Promise((resolve) => socket.close(resolve));

  const contents = new Map(sentinels.map((file) => [file, `сохранить:${file}`]));

  contents.set(sentinels[0], `GRIGDESK_PORT=${port}\n`);

  for (const [file, content] of contents) {
    await fs.writeFile(file, content, { mode: 0o600 });
  }

  await fs.mkdir(path.join(dataHome, 'state'), { mode: 0o700 });
  await fs.writeFile(path.join(dataHome, 'state/cli-token'), 'fixture-token', { mode: 0o600 });

  const fetcher = options.fetcher ?? (async (url) => {
    const bytes = release.archives.get(String(url));

    assert.ok(bytes, `Неожиданный URL: ${url}`);

    return new Response(bytes);
  });
  const manager = new InstalledUpdateManager({
    root,
    publicKeyPem: release.publicKeyPem,
    channel: options.channel ?? { latest: async () => release.envelope },
    fetcher,
    probe: options.probe ?? probeInstalledComponent,
  });

  return {
    temporary,
    root,
    receipt,
    previous,
    release,
    manager,
    onCleanup: (cleanup) => cleanups.push(cleanup),
    pointer: () => readInstalledPointer(receipt),
    job: () => readInstalledUpdate(receipt),
    create: (requestId = randomUUID()) => manager.createJob({
      requestId,
      manifestDigest: release.manifestDigest,
      scope: mode === 'local' ? 'pair' : mode === 'remote' ? 'desktop' : 'server',
    }),
    async preserved() {
      for (const file of sentinels) {
        assert.equal(await fs.readFile(file, 'utf8'), contents.get(file));
      }
    },
  };
}

/**
 * Подставляет только тестовый pinned key при загрузке модуля в отдельном процессе.
 * Проверяющий код, подпись, journal и worker остаются настоящими, ключ с сайта не принимается.
 */
export async function pinnedKeyHook(directory, publicKeyPem) {
  const hook = path.join(directory, 'pinned-key.mjs');
  const source = [
    "import { registerHooks } from 'node:module';",
    'registerHooks({ load(url, context, next) {',
    '  const loaded = next(url, context);',
    "  if (!url.endsWith('/shared/runtime/releaseChannelContracts.ts')) return loaded;",
    '  const text = String(loaded.source);',
    "  const pattern = /export const RELEASE_SIGNING_PUBLIC_KEY = [^;]+;/u;",
    "  if (!pattern.test(text)) throw new Error('Не найдена граница pinned key');",
    '  return { ...loaded, source: text.replace(pattern,',
    `    ${JSON.stringify(`export const RELEASE_SIGNING_PUBLIC_KEY = ${JSON.stringify(publicKeyPem)};`)}) };`,
    '} });',
  ].join('\n');

  await fs.writeFile(hook, source, { mode: 0o600 });

  return hook;
}

/**
 * Процесс теста получает только явно выбранные временные пути до вызова установщика.
 * Каждый изменённый параметр восстанавливается после сценария, включая прежнее отсутствие.
 */
export function isolatedEnvironment(t, values) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));

  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}
