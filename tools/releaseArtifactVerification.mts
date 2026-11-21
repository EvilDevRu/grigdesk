import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractReleaseArtifact } from '../shared/node/releaseArchive.ts';

import { parseReleaseChannelIndex, type ReleaseEnvelope }
  from '../shared/runtime/installedUpdateContracts.ts';
import { verifyReleaseEnvelope } from '../shared/node/releaseTrust.ts';
import { assertReleasePlatform } from '../shared/node/releaseChannel.ts';
import { sha256File } from '../shared/node/hash.ts';
import { verifyBootstrapFiles, type BootstrapMetadata }
  from './installBootstrap.mts';
import type { ReleaseDistributionSource } from '../shared/runtime/releaseChannelContracts.ts';

export interface DistributionTrust {
  purpose: 'official' | 'local' | 'candidate';
  publicKeyPem: string;
  expectedCommit: string;
  expectedManifestDigest?: string;
  requireHostPlatform?: boolean;
  expectedDelivery?: ReleaseDistributionSource;
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
  trust: DistributionTrust, signal?: AbortSignal): Promise<VerifiedDistribution> {
  signal?.throwIfAborted();

  const names = (await fs.readdir(directory))
    .filter((name) => name === 'release.json' || name === 'dev.json');

  if (names.length !== 1) {
    throw new Error('release_distribution_ambiguous');
  }

  const index = parseReleaseChannelIndex(
    await fs.readFile(path.join(directory, names[0]!), 'utf8'),
  );

  if (!index.latest) {
    throw new Error('release_distribution_empty');
  }

  if (index.latest.payload.commit !== trust.expectedCommit) {
    throw new Error('release_distribution_commit_mismatch');
  }

  const manifestDigest = verifyReleaseEnvelope(index.latest, trust.publicKeyPem);

  if (trust.requireHostPlatform) {
    await assertReleasePlatform(index.latest.payload.platform);
  }

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
  const expectedDelivery = trust.expectedDelivery ?? (trust.purpose === 'official' ? 'channel'
    : trust.purpose === 'candidate' ? 'candidate-file' : undefined);

  if (expectedDelivery && (bootstrap.delivery ?? 'channel') !== expectedDelivery) {
    throw new Error('installation_release_trust_mismatch');
  }

  for (const component of ['desktop', 'server'] as const) {
    const artifact = index.latest.payload.artifacts[component];
    const file = path.join(directory, `${component}.tar.gz`);

    if (await sha256File(file, signal) !== artifact.sha256
      || (await fs.stat(file)).size !== artifact.size) {
      throw new Error('release_archive_integrity_invalid');
    }
  }

  const control = index.latest.payload.artifacts.control;

  if (control) {
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-control-'));

    try {
      await extractReleaseArtifact(
        path.join(directory, 'control.tar.gz'), path.join(stage, 'control'), control,
      );
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }

  signal?.throwIfAborted();

  return { envelope: index.latest, bootstrap };
}
