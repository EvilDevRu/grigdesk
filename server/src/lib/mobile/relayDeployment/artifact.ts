import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ReleaseChannelService } from '../../../../../shared/node/releaseChannel.ts';
import {
  downloadReleaseArtifact,
  extractReleaseArtifact,
} from '../../../../../shared/node/releaseArchive.ts';
import { sha256File } from '../../../../../shared/node/hash.ts';

export interface RelayArtifact {
  file: string;
  digest: string;
  version: string;
  staging?: string;
}

export interface ArtifactOptions {
  release?: { fetch?: typeof fetch; publicKeyPem?: string };
  receipt?: { channel: 'release' | 'dev' };
  resolveArtifact?: () => Promise<RelayArtifact>;
}

/**
 * Выбирает готовый ретранслятор только после полной проверки подписанного server archive.
 * Источник и доверенный ключ задаёт сервер, renderer не может прислать собственный файл.
 */
export async function resolveRelayArtifact(
  directory: string,
  options: ArtifactOptions,
): Promise<RelayArtifact> {
  if (options.resolveArtifact) {
    return options.resolveArtifact();
  }

  const source = new ReleaseChannelService({
    channel: options.receipt?.channel ?? 'release',
    ...options.release,
  });
  const envelope = await source.latest();

  if (!envelope) {
    throw new Error('relay_artifact_unavailable');
  }

  const artifact = envelope.payload.artifacts.server;
  const entry = artifact.files.find((item) => item.path === 'bin/grigdesk-relay');

  if (!entry) {
    throw new Error('relay_artifact_missing');
  }

  const cache = path.join(directory, 'relay-artifacts');

  await fs.mkdir(cache, { recursive: true, mode: 0o700 });

  const staging = await fs.mkdtemp(path.join(cache, 'verified-'));
  const archive = path.join(staging, 'server.tar.gz');
  const unpacked = path.join(staging, 'unpacked');

  let file: string;

  try {
    await downloadReleaseArtifact({
      artifact,
      destination: archive,
      fetcher: options.release?.fetch,
      progress: async () => {},
    });
    await extractReleaseArtifact(archive, unpacked, artifact);

    file = path.join(unpacked, entry.path);

    if (await sha256File(file) !== entry.sha256) {
      throw new Error('relay_artifact_corrupt');
    }
  } catch (cause) {
    // Незавершённая распаковка не переживает попытку: worker ещё не владеет каталогом.
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});

    throw cause;
  }

  return {
    file,
    digest: entry.sha256,
    version: envelope.payload.version,
    staging,
  };
}
