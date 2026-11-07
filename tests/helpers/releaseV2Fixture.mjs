import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { canonicalJson } from '../../shared/lib/canonicalJson.ts';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Синтетические компоненты содержат настоящие суммы одних и тех же байтов.
 * Это вход декодера и канала; распаковка и исполнение здесь не подменяются.
 */
function artifact(component, identity) {
  const bytes = Buffer.from(`${component}:${identity.releaseId}\n`);
  const files = [{
    path: component === 'desktop' ? 'GrigDesk' : 'bin/grigdesk-server',
    size: bytes.length,
    sha256: sha256(bytes),
    mode: 0o755,
  }];

  return {
    url: `https://grigdesk.test/releases/${identity.version}/${component}.tar.gz`,
    size: bytes.length,
    sha256: sha256(bytes),
    unpackedSize: bytes.length,
    files,
    filesDigest: sha256(canonicalJson(files)),
    buildIdentity: identity,
    ...(component === 'server' ? { packageId: sha256(bytes) } : {}),
  };
}

/**
 * Подпись охватывает весь payload по согласованному domain separator, а не два хеша.
 * Ключ существует только в памяти теста и никогда не становится ключом приложения.
 */
export function signedIndex(options = {}) {
  const channel = options.channel ?? 'release';
  const version = options.version ?? (channel === 'dev' ? '0.3.0-dev.42' : '0.3.0');
  const commit = 'c'.repeat(40);
  const identity = {
    channel,
    version,
    commit,
    releaseId: `${channel}/${version}/${commit}`,
  };
  const { privateKey, publicKey } = options.keys ?? generateKeyPairSync('ed25519');
  const payload = {
    ...identity,
    publishedAt: '2026-11-02T00:00:00.000Z',
    notes: { ru: 'Изменения и исправления фикстуры', en: 'Fixture changes and fixes' },
    dataCompatibility: 'unchanged-v1',
    serverApi: { major: 0, minor: 1 },
    desktopRequiresServerApi: { major: 0, minMinor: 1 },
    platform: {
      os: 'linux',
      arch: 'x64',
      glibc: '2.28',
    },
    artifacts: {
      desktop: artifact('desktop', identity),
      server: artifact('server', identity),
    },
    ...options.payload,
  };
  const signedBytes = Buffer.from(`GrigDesk release v2\n${canonicalJson(payload)}\n`, 'utf8');
  const envelope = { payload, signature: sign(null, signedBytes, privateKey).toString('base64') };

  return {
    identity,
    privateKey,
    publicKeyPem: String(publicKey.export({ type: 'spki', format: 'pem' })),
    manifestDigest: sha256(signedBytes),
    envelope,
    index: {
      format: 2,
      channel,
      publishedAt: payload.publishedAt,
      latest: envelope,
    },
  };
}
