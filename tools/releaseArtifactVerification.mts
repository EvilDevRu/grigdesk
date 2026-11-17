import fs from 'node:fs/promises';
import path from 'node:path';

import { decodeReleaseChannelIndex, type ReleaseEnvelope }
  from '../shared/runtime/installedUpdateContracts.ts';
import { verifyReleaseEnvelope } from '../shared/node/releaseTrust.ts';
import { sha256File } from '../shared/node/hash.ts';
import { verifyBootstrapFiles, type BootstrapMetadata }
  from './installBootstrap.mts';

export interface DistributionTrust {
  purpose: 'official' | 'local';
  publicKeyPem: string;
  expectedCommit: string;
  expectedManifestDigest?: string;
}

export interface VerifiedDistribution {
  envelope: ReleaseEnvelope;
  bootstrap: BootstrapMetadata;
}

export { verifyReleaseInstaller } from './installerProof.mts';

/**
 * Общая проверка дистрибутива без publisher: схема и подпись индекса, отказ
 * local-build.json официальному доверию, подпись installer, bootstrap metadata,
 * gzip helper и SHA/размеры обоих архивов. Никакие файлы не исполняются.
 */
export async function verifyDistributionArtifacts(directory: string,
  trust: DistributionTrust): Promise<VerifiedDistribution> {
  const names = (await fs.readdir(directory))
    .filter((name) => name === 'release.json' || name === 'dev.json');

  if (names.length !== 1) {
    throw new Error('release_distribution_ambiguous');
  }

  const index = decodeReleaseChannelIndex(JSON.parse(
    await fs.readFile(path.join(directory, names[0]!), 'utf8'),
  ));

  if (!index.latest) {
    throw new Error('release_distribution_empty');
  }

  if (index.latest.payload.commit !== trust.expectedCommit) {
    throw new Error('release_distribution_commit_mismatch');
  }

  const manifestDigest = verifyReleaseEnvelope(index.latest, trust.publicKeyPem);

  if (trust.expectedManifestDigest !== undefined
    && trust.expectedManifestDigest !== manifestDigest) {
    throw new Error('release_distribution_digest_mismatch');
  }

  if (trust.purpose === 'official') {
    const localMarker = await fs.lstat(path.join(directory, 'local-build.json'))
      .then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }

        return false;
      });

    if (localMarker) {
      throw new Error('release_distribution_local_marker_present');
    }
  }

  const bootstrap = await verifyBootstrapFiles(directory,
    { envelope: index.latest, publicKey: trust.publicKeyPem });

  for (const component of ['desktop', 'server'] as const) {
    const artifact = index.latest.payload.artifacts[component];
    const file = path.join(directory, `${component}.tar.gz`);

    if (await sha256File(file) !== artifact.sha256
      || (await fs.stat(file)).size !== artifact.size) {
      throw new Error('release_archive_integrity_invalid');
    }
  }

  return { envelope: index.latest, bootstrap };
}
