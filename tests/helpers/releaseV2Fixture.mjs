import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { canonicalJson } from '../../shared/lib/canonicalJson.ts';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Синтетические компоненты содержат настоящие суммы одних и тех же байтов.
 * Это вход декодера и канала; распаковка и исполнение здесь не подменяются.
 */
function artifact(component, identity, origin = 'https://grigdesk.test') {
  const bytes = Buffer.from(`${component}:${identity.releaseId}\n`);
  const files = [{
    path: component === 'desktop' ? 'GrigDesk' : 'bin/grigdesk-server',
    size: bytes.length,
    sha256: sha256(bytes),
    mode: 0o755,
  }];

  return {
    url: `${origin}/releases/${identity.version}/${component}.tar.gz`,
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
      desktop: artifact('desktop', identity, options.origin),
      server: artifact('server', identity, options.origin),
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

/**
 * Опись Apple Silicon использует отдельные URLs каждого компонента.
 * Проба формата получает такую же подпись, как обычный Linux fixture.
 */
export function signedMacIndex(options = {}) {
  const keys = options.keys ?? generateKeyPairSync('ed25519');
  const { envelope: { payload } } = signedIndex({ ...options, keys });

  payload.platform = {
    os: 'darwin',
    arch: 'arm64',
    minMacOS: '15.0',
  };

  const origin = options.origin ?? 'https://grigdesk.test';

  for (const component of ['desktop', 'server']) {
    payload.artifacts[component].url =
      `${origin}/releases/darwin-arm64/${payload.version}/${component}.tar.gz`;
  }

  const desktop = payload.artifacts.desktop;
  const entries = ['GrigDesk.app.tree.json', 'GrigDesk.app.zip'].map((path) => {
    const bytes = Buffer.from(path);

    return {
      path,
      size: bytes.length,
      sha256: sha256(bytes),
      mode: 0o444,
    };
  });

  desktop.files = entries;
  desktop.unpackedSize = entries.reduce((size, file) => size + file.size, 0);
  desktop.filesDigest = sha256(canonicalJson(entries));
  desktop.unpackedBundleBytes = 17;
  Object.assign(desktop, options.desktop);

  return signedIndex({
    ...options,
    keys,
    payload,
  });
}
