import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sign } from 'node:crypto';
import type { TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';

import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { sha256 } from '../../shared/node/hash.ts';
import { signedIndex } from '../helpers/releaseV2Fixture.mjs';
import {
  renderBootstrap, readBootstrap, verifyBootstrapFiles, type BootstrapMetadata,
} from '../../tools/installBootstrap.mts';

const TEMPLATE = '#!/bin/sh\nset -eu\nprintf \'%s\\n\' @@VERSION@@\nexit 0\n';

const MESSAGES = {
  ru: { greeting: 'привет', cancelled: 'отмена' },
  en: { greeting: 'hello', cancelled: 'cancelled' },
};

/**
 * Автономная фикстура: подписанный конверт, настоящий gzip и скрипт renderer-ом.
 * Ни bundle, ни publisher, ни установщик на этом этапе не вызываются.
 */
async function bootstrapBox(t: TestContext, override: Partial<BootstrapMetadata> = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'install-bootstrap-'));
  const signer = signedIndex({ channel: 'release' });
  const helper = Buffer.from('#!/bin/sh\nexit 0\n');
  const compressed = gzipSync(helper);
  const index = canonicalJson({
    format: 2,
    channel: signer.identity.channel,
    publishedAt: signer.envelope.payload.publishedAt,
    latest: signer.envelope,
  });
  const indexBytes = Buffer.from(index);
  const base = indexBytes.length + compressed.length;
  const metadata: BootstrapMetadata = {
    format: 1,
    version: signer.identity.version,
    channel: 'release',
    origin: 'https://grigdesk.test',
    manifestDigest: signer.manifestDigest,
    indexSha256: sha256(indexBytes),
    indexSize: indexBytes.length,
    helperSha256: sha256(helper),
    helperSize: helper.length,
    compressedSha256: sha256(compressed),
    compressedSize: compressed.length,
    downloadBytes: {
      local: base + signer.envelope.payload.artifacts.desktop.size
        + signer.envelope.payload.artifacts.server.size,
      remote: base + signer.envelope.payload.artifacts.desktop.size,
      server: base + signer.envelope.payload.artifacts.server.size,
    },
    ...override,
  };
  const script = renderBootstrap(metadata, TEMPLATE, MESSAGES);
  const proof = `GrigDesk installer v1\n${sha256(Buffer.from(script, 'utf8'))}  grigdesk-install\n`
    + `${signer.manifestDigest}\n`;

  await fs.writeFile(path.join(temporary, 'grigdesk-install'), script, { mode: 0o755 });
  await fs.writeFile(path.join(temporary, 'grigdesk-maintenance.gz'), compressed, { mode: 0o600 });
  await fs.writeFile(path.join(temporary, 'release.json'), indexBytes, { mode: 0o644 });
  await fs.writeFile(path.join(temporary, 'grigdesk-install.sha256'), proof, { mode: 0o644 });
  await fs.writeFile(path.join(temporary, 'grigdesk-install.sig'),
    sign(null, Buffer.from(proof), signer.privateKey).toString('base64'), { mode: 0o644 });

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  return {
    directory: temporary,
    signer,
    script,
    metadata,
    helper,
  };
}

test('BOOTSTRAP-ROUNDTRIP: renderer и reader сходятся на одной metadata', async (t) => {
  const box = await bootstrapBox(t);

  assert.deepEqual(readBootstrap(box.script), box.metadata);
  assert.ok(Buffer.byteLength(box.script, 'utf8') <= 64 * 1024);
  assert.equal(box.script.split('# GRIGDESK_BOOTSTRAP:').length - 1, 1);
  assert.deepEqual(await verifyBootstrapFiles(box.directory,
    { envelope: box.signer.envelope, publicKey: box.signer.publicKeyPem }), box.metadata);
});

test('BOOTSTRAP-TAMPER: изменённый байт helper.gz отвергается до исполнения', async (t) => {
  const box = await bootstrapBox(t);
  const file = path.join(box.directory, 'grigdesk-maintenance.gz');
  const bytes = await fs.readFile(file);

  bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0xff, bytes.length - 1);
  await fs.writeFile(file, bytes);

  await assert.rejects(verifyBootstrapFiles(box.directory,
    { envelope: box.signer.envelope, publicKey: box.signer.publicKeyPem }),
    /installer_helper_integrity_invalid/u);
});

test('BOOTSTRAP-INDEX: подменённый индекс ловится до helper', async (t) => {
  const box = await bootstrapBox(t);
  const file = path.join(box.directory, 'release.json');
  const bytes = await fs.readFile(file);

  bytes.writeUInt8(bytes.readUInt8(0) ^ 0x01, 0);
  await fs.writeFile(file, bytes);

  await assert.rejects(verifyBootstrapFiles(box.directory,
    { envelope: box.signer.envelope, publicKey: box.signer.publicKeyPem }),
    /bootstrap_index_integrity_invalid/u);
});

test('BOOTSTRAP-FOREIGN-SIGN: чужая подпись скрипта не становится доверенной', async (t) => {
  const box = await bootstrapBox(t);
  const other = signedIndex({ channel: 'dev' });
  const proof = await fs.readFile(path.join(box.directory, 'grigdesk-install.sha256'), 'utf8');

  await fs.writeFile(path.join(box.directory, 'grigdesk-install.sig'),
    sign(null, Buffer.from(proof), other.privateKey).toString('base64'));

  await assert.rejects(verifyBootstrapFiles(box.directory,
    { envelope: box.signer.envelope, publicKey: box.signer.publicKeyPem }),
    /release_installer_signature_invalid/u);
});

test('BOOTSTRAP-EXTRA-FIELD: лишнее поле metadata отвергается', async (t) => {
  const box = await bootstrapBox(t);
  const lines = box.script.split('\n');

  lines[1] = lines[1]!.replace(/\}$/u, ',"extra":1}');

  assert.throws(() => readBootstrap(lines.join('\n')), /bootstrap_metadata_invalid/u);
});

test('BOOTSTRAP-ORIGIN: origin с path или не-HTTPS схемой отвергается', async (t) => {
  const box = await bootstrapBox(t);

  for (const origin of ['https://grigdesk.test/releases', 'http://grigdesk.test']) {
    const broken = renderBootstrap({ ...box.metadata, origin }, TEMPLATE, MESSAGES);

    assert.throws(() => readBootstrap(broken), /bootstrap_metadata_invalid/u,
      `origin не отвергнут: ${origin}`);
  }
});

test('BOOTSTRAP-OVERFLOW: gzip больше заявленного helperSize останавливается лимитом', async (t) => {
  const box = await bootstrapBox(t);

  await fs.writeFile(path.join(box.directory, 'grigdesk-maintenance.gz'),
    gzipSync(Buffer.concat([box.helper, Buffer.alloc(64 * 1024, 0x61)])));

  await assert.rejects(verifyBootstrapFiles(box.directory,
    { envelope: box.signer.envelope, publicKey: box.signer.publicKeyPem }),
    /installer_helper_integrity_invalid/u);
});

test('BOOTSTRAP-BYTES: несовпадение суммарных downloadBytes ловится проверкой', async (t) => {
  const box = await bootstrapBox(t);
  const metadata = {
    ...box.metadata,
    downloadBytes: { ...box.metadata.downloadBytes,
      remote: box.metadata.downloadBytes.remote + 1 },
  };
  const script = renderBootstrap(metadata, TEMPLATE, MESSAGES);
  const proof = `GrigDesk installer v1\n${sha256(Buffer.from(script, 'utf8'))}  grigdesk-install\n`
    + `${box.signer.manifestDigest}\n`;

  await fs.writeFile(path.join(box.directory, 'grigdesk-install'), script, { mode: 0o755 });
  await fs.writeFile(path.join(box.directory, 'grigdesk-install.sha256'), proof);
  await fs.writeFile(path.join(box.directory, 'grigdesk-install.sig'),
    sign(null, Buffer.from(proof), box.signer.privateKey).toString('base64'));

  await assert.rejects(verifyBootstrapFiles(box.directory,
    { envelope: box.signer.envelope, publicKey: box.signer.publicKeyPem }),
    /bootstrap_download_bytes_invalid/u);
});
