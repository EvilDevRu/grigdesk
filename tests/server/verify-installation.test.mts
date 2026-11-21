import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from '../../web/node_modules/esbuild/lib/main.js';
import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { shellQuote } from '../../shared/lib/shellQuote.ts';
import { sha256 } from '../../shared/node/hash.ts';
import { signedIndex } from '../helpers/releaseV2Fixture.mjs';
import { installedRelease } from '../helpers/installedUpdateFixture.mjs';
import { renderBootstrap, readBootstrap } from '../../tools/installBootstrap.mts';
import { verifyInstallation } from '../../tools/verifyInstallation.mts';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Сборка модуля с подменённым pinned ключом; путь к файлу нужен wrapper-helper-у.
 * Повторяет контракт loadInstalledModule без возврата пространства имён.
 */
async function builtModule(t: TestContext, relative: string, publicKeyPem: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-module-'));
  const output = path.join(directory, 'module.mjs');

  await build({
    entryPoints: [path.join(repository, relative)],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [{
      name: 'verify-pinned-key',
      setup(builder) {
        builder.onLoad({ filter: /\.(?:ts|mts)$/ }, async ({ path: file }) => {
          if (file.endsWith('/shared/runtime/releaseChannelContracts.ts')) {
            const source = await fs.readFile(file, 'utf8');

            return {
              contents: source.replace(
                /export const RELEASE_SIGNING_PUBLIC_KEY = [^;]+;/u,
                `export const RELEASE_SIGNING_PUBLIC_KEY = ${JSON.stringify(publicKeyPem)};`,
              ),
              loader: 'ts',
              resolveDir: path.dirname(file),
            };
          }

          return null;
        });
      },
    }],
  });

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  return output;
}

/**
 * Кандидат использует настоящие подпись, шаблон и архивы; helper — wrapper на
 * собранный installOnline, поэтому установка идёт реальным путём installRelease.
 * Экспортируется для tests/server/distribution-trust.test.mts (R.5).
 */
export async function acceptanceBox(t: TestContext) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-installation-'));
  const directory = path.join(temporary, 'candidate');
  const release = installedRelease({
    script: (component: string, identity: { version: string; packageId?: string }) => component === 'server'
      ? `#!/bin/sh\nprintf '%s\\n' '{"verified":true,"packageId":"${identity.packageId}",`
        + `"version":"${identity.version}"}'\n`
      : `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(identity)}'\n`,
  });
  const moduleFile = await builtModule(t, 'tests/fixtures/release-v2/maintenance.mts', release.publicKeyPem);
  const entry = `import { runMaintenance } from ${JSON.stringify('file://' + moduleFile)};
    process.execPath = process.argv[1];
    process.exitCode = await runMaintenance(process.argv.slice(2));`;
  const helper = Buffer.from(`#!/bin/sh\nexec ${shellQuote(process.execPath)} `
    + `--input-type=module -e ${shellQuote(entry)} "$0" "$@"\n`);
  const compressed = gzipSync(helper);
  const indexBytes = Buffer.from(canonicalJson({
    format: 2,
    channel: release.envelope.payload.channel,
    publishedAt: release.envelope.payload.publishedAt,
    latest: release.envelope,
  }) + '\n');
  const base = indexBytes.length + compressed.length;
  const template = await fs.readFile(path.join(repository, 'tools/installBootstrap.sh'),
    'utf8');
  const messages = {
    ru: JSON.parse(await fs.readFile(path.join(repository,
      'shared/i18n/assets/locales/ru/installer.json'), 'utf8')),
    en: JSON.parse(await fs.readFile(path.join(repository,
      'shared/i18n/assets/locales/en/installer.json'), 'utf8')),
  };
  const script = renderBootstrap({
    format: 1,
    version: release.envelope.payload.version,
    channel: 'release',
    origin: 'https://grigdesk.test',
    manifestDigest: release.manifestDigest,
    indexSha256: sha256(indexBytes),
    indexSize: indexBytes.length,
    helperSha256: sha256(helper),
    helperSize: helper.length,
    compressedSha256: sha256(compressed),
    compressedSize: compressed.length,
    downloadBytes: {
      local: base + release.envelope.payload.artifacts.desktop.size
        + release.envelope.payload.artifacts.server.size,
      remote: base + release.envelope.payload.artifacts.desktop.size,
      server: base + release.envelope.payload.artifacts.server.size,
    },
  }, template, messages);
  const proof = `GrigDesk installer v1\n${sha256(Buffer.from(script, 'utf8'))}`
    + `  grigdesk-install\n${release.manifestDigest}\n`;

  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(directory, 'grigdesk-install'), script, { mode: 0o755 });
  await fs.writeFile(path.join(directory, 'grigdesk-maintenance.gz'), compressed);
  await fs.writeFile(path.join(directory, 'release.json'), indexBytes, { mode: 0o644 });
  await fs.writeFile(path.join(directory, 'grigdesk-install.sha256'), proof);
  await fs.writeFile(path.join(directory, 'grigdesk-install.sig'),
    sign(null, Buffer.from(proof), release.privateKey).toString('base64'));

  for (const [index, component] of ['desktop', 'server'].entries()) {
    const url = release.envelope.payload.artifacts[component].url;

    await fs.writeFile(path.join(directory, `${component}.tar.gz`),
      [...release.archives.values()][index]!);
  }

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  return {
    temporary,
    directory,
    release,
    script
  };
}

test('ACCEPT-THREE-MODES: настоящая установка всех режимов в изолированных профилях', async (t) => {
  const box = await acceptanceBox(t);
  const installRoot = path.join(box.temporary, 'acceptance');

  const proofs = await verifyInstallation(box.directory,
    box.release.envelope.payload.commit, {
      trust: {
        purpose: 'official',
        publicKeyPem: box.release.publicKeyPem,
        expectedCommit: box.release.envelope.payload.commit
      },
      installRoot,
      xvfb: false,
    });

  assert.equal(proofs.length, 3);

  for (const proof of proofs) {
    assert.match(proof.installationId, /^[a-f0-9-]{36}$/u);
    assert.ok(proof.root.startsWith(installRoot + path.sep));
    assert.equal(proof.probes.desktop, proof.mode === 'server' ? 'not-installed' : 'direct');
    assert.equal(proof.probes.server, proof.mode !== 'remote');
  }
});

test('ACCEPT-LOCAL-MARKER: официальный verifier отвергает local-build.json', async (t) => {
  const box = await acceptanceBox(t);

  await fs.writeFile(path.join(box.directory, 'local-build.json'), '{}\n');

  await assert.rejects(verifyInstallation(box.directory,
    box.release.envelope.payload.commit, {
      trust: {
        purpose: 'official',
        publicKeyPem: box.release.publicKeyPem,
        expectedCommit: box.release.envelope.payload.commit
      },
      installRoot: path.join(box.temporary, 'a'),
    }), /release_distribution_local_marker_present/u);
});

test('ACCEPT-TAMPER-ARCHIVE: испорченный архив ловится до запуска скрипта', async (t) => {
  const box = await acceptanceBox(t);
  const file = path.join(box.directory, 'desktop.tar.gz');
  const bytes = await fs.readFile(file);

  bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0);
  await fs.writeFile(file, bytes);

  await assert.rejects(verifyInstallation(box.directory,
    box.release.envelope.payload.commit, {
      trust: {
        purpose: 'official',
        publicKeyPem: box.release.publicKeyPem,
        expectedCommit: box.release.envelope.payload.commit
      },
      installRoot: path.join(box.temporary, 'a'),
    }), /release_archive_integrity_invalid/u);
});

test('ACCEPT-HTTPS: настоящий TLS-origin, обрыв и повтор индекса', async (t) => {
  const box = await acceptanceBox(t);
  const certificates = path.join(box.temporary, 'tls');

  await fs.mkdir(certificates, { mode: 0o700 });
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(certificates, 'key.pem'), '-out',
    path.join(certificates, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1']);

  const requests: string[] = [];
  let truncateOnce = true;
  const port = await freePort(t);
  const payload = JSON.parse(JSON.stringify(box.release.envelope.payload));

  for (const component of ['desktop', 'server'] as const) {
    payload.artifacts[component].url = `https://127.0.0.1:${port}`
      + `/releases/${payload.version}/${component}.tar.gz`;
  }

  const signedBytes = Buffer.from(`GrigDesk release v2\n${canonicalJson(payload)}\n`,
    'utf8');
  const envelope = { payload,
    signature: sign(null, signedBytes, box.release.privateKey).toString('base64') };
  const indexBytes = Buffer.from(canonicalJson({
    format: 2,
    channel: payload.channel,
    publishedAt: payload.publishedAt,
    latest: envelope,
  }) + '\n');
  const manifestDigest = sha256(signedBytes);
  const helperBytes = await fs.readFile(path.join(box.directory,
    'grigdesk-maintenance.gz'));
  const server = https.createServer({
    key: await fs.readFile(path.join(certificates, 'key.pem')),
    cert: await fs.readFile(path.join(certificates, 'cert.pem')),
  }, (request, response) => {
    requests.push(request.url ?? '');

    const serve = (bytes: Buffer) => {
      if (truncateOnce) {
        truncateOnce = false;
        assert.ok(response.socket);
        response.socket.destroy();

        return;
      }

      response.end(bytes);
    };

    const prefix = `/releases/${payload.version}`;

    if (request.url === `${prefix}/release.json`) {
      serve(indexBytes);

      return;
    }

    for (const component of ['desktop', 'server'] as const) {
      if (request.url === `${prefix}/${component}.tar.gz`) {
        serve([...box.release.archives.values()][component === 'desktop' ? 0 : 1]!);

        return;
      }
    }

    if (request.url === `${prefix}/grigdesk-maintenance.gz`) {
      serve(helperBytes);

      return;
    }

    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const origin = `https://127.0.0.1:${port}`;
  const candidateMetadata = readBootstrap(await fs.readFile(
    path.join(box.directory, 'grigdesk-install'), 'utf8'));
  const template = await fs.readFile(path.join(repository, 'tools/installBootstrap.sh'),
    'utf8');
  const messages = {
    ru: JSON.parse(await fs.readFile(path.join(repository,
      'shared/i18n/assets/locales/ru/installer.json'), 'utf8')),
    en: JSON.parse(await fs.readFile(path.join(repository,
      'shared/i18n/assets/locales/en/installer.json'), 'utf8')),
  };
  const script = renderBootstrap({
    ...candidateMetadata,
    origin,
    manifestDigest,
    indexSha256: sha256(indexBytes),
    indexSize: indexBytes.length,
    downloadBytes: { ...candidateMetadata.downloadBytes }
  }, template, messages);
  const profile = path.join(box.temporary, 'https-profile');
  const home = path.join(profile, 'home');

  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(profile, 'script'), script, { mode: 0o755 });

  const result = await execute('sh', [path.join(profile, 'script'),
    '--yes', '--lang', 'en', '--mode', 'remote', '--root', path.join(profile, 'program'),
    '--data-home', path.join(profile, 'data'), '--user-data', path.join(profile, 'user'),
    '--bin-dir', path.join(profile, 'bin'), '--applications-dir', path.join(profile, 'apps'),
    '--unit-dir', path.join(profile, 'units')], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      LANG: 'C.UTF-8',
      XDG_CACHE_HOME: path.join(home, '.cache'),
      CURL_CA_BUNDLE: path.join(certificates, 'cert.pem'),
      NODE_EXTRA_CA_CERTS: path.join(certificates, 'cert.pem'),
    },
    timeout: 120_000,
  });

  // promisified execFile при ненулевом коде отвергает промис — это и есть ворота.
  assert.equal(requests.filter((url) => url.endsWith('release.json')).length, 2);
  assert.ok(requests.some((url) => url.endsWith('grigdesk-maintenance.gz')));
  assert.ok(requests.some((url) => url.endsWith('desktop.tar.gz')));
  assert.ok(!requests.some((url) => url.endsWith('server.tar.gz')));

  const pointer = JSON.parse(await fs.readFile(
    path.join(profile, 'program', 'current.json'), 'utf8'));

  assert.ok(pointer.desktop);
  assert.equal(pointer.server, null);
});

import net from 'node:net';

/**
 * Свободный loopback-порт выбирается до запуска TLS-origin фикстуры.
 * Пробный listener закрывается, чтобы HTTPS-сервер сам занял этот порт.
 */
async function freePort(t: TestContext): Promise<number> {
  const probe = net.createServer();

  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));

  const port = (probe.address() as import('node:net').AddressInfo).port;

  await new Promise<void>((resolve) => probe.close(() => resolve()));

  return port;
}
