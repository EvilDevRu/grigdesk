import { createHash, sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { signedIndex } from '../../helpers/releaseV2Fixture.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Подписанный server.tar.gz содержит готовые исполняемые bytes и точную опись.
 * Источник сети подменён, но Ed25519, hash/size и production extractor остаются настоящими.
 */
export function relayRelease(options = {}) {
  const channel = options.channel ?? 'release';
  const signer = signedIndex({ channel });
  const relay = Buffer.from('#!/bin/sh\nprintf "%s\\n" '
    + `'grigdesk-relay ${signer.identity.version} (Node ${process.versions.node}, linux x64)'\n`);
  const files = [
    { path: 'bin/grigdesk-server', bytes: Buffer.from('#!/bin/sh\nexit 0\n') },
    ...options.missingRelay ? [] : [{ path: 'bin/grigdesk-relay', bytes: relay }],
  ];
  const archive = tar(files.concat(options.extraEntry ? [{ path: '../escape', bytes: relay }] : []));
  const inventory = files.map(({ path, bytes }) => ({
    path,
    size: bytes.length,
    sha256: digest(bytes),
    mode: 0o755,
  }));
  const artifact = {
    ...signer.envelope.payload.artifacts.server,
    size: archive.length,
    sha256: digest(archive),
    unpackedSize: files.reduce((sum, file) => sum + file.bytes.length, 0),
    files: inventory,
    filesDigest: digest(canonicalJson(inventory)),
  };

  signer.envelope.payload.artifacts.server = artifact;

  const signed = Buffer.from(`GrigDesk release v2\n${canonicalJson(signer.envelope.payload)}\n`);

  signer.envelope.signature = sign(null, signed, signer.privateKey).toString('base64');

  if (options.badSignature) {
    signer.envelope.signature = Buffer.alloc(64, 1).toString('base64');
  }

  const requests = [];
  /**
   * Ответы привязаны к точному подписанному архиву, все обращения сохраняются для проверки.
   * Порча применяется после подписи и не создаёт альтернативного доверенного источника.
   */
  const fetcher = async (url, request) => {
    requests.push({ url: String(url), redirect: request?.redirect });

    if (options.timeout) {
      throw new Error('fixture_release_timeout');
    }

    if (String(url).endsWith('.json')) {
      return new Response(JSON.stringify(signer.index));
    }

    const bytes = options.badSize ? Buffer.concat([archive, Buffer.from('extra')])
      : options.badHash ? Buffer.alloc(archive.length, 1) : archive;

    return new Response(bytes);
  };

  return {
    ...signer,
    archive,
    relay,
    artifact,
    requests,
    release: { fetch: fetcher, publicKeyPem: signer.publicKeyPem },
  };
}

/**
 * Минимальный USTAR нужен для проверки реального extractor, а не его подмены.
 * Два нулевых блока и checksum формируются независимо от production reader.
 */
function tar(files) {
  const parts = [];

  for (const file of files) {
    const header = Buffer.alloc(512);
    const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';

    header.write(file.path, 0, 100);
    header.write(octal(0o755, 8), 100);
    header.write(octal(0, 8), 108);
    header.write(octal(0, 8), 116);
    header.write(octal(file.bytes.length, 12), 124);
    header.write(octal(0, 12), 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257);
    header.write('00', 263);

    const checksum = header.reduce((sum, byte) => sum + byte, 0);

    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, file.bytes, Buffer.alloc((512 - file.bytes.length % 512) % 512));
  }

  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
