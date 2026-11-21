import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ReleaseEnvelope } from '../../../../../shared/runtime/installedUpdateContracts.ts';
import { ReleaseChannelService } from '../../../../../shared/node/releaseChannel.ts';
import { verifyReleaseEnvelope } from '../../../../../shared/node/releaseTrust.ts';
import {
  downloadReleaseArtifact,
  extractReleaseArtifact,
} from '../../../../../shared/node/releaseArchive.ts';
import { sha256File } from '../../../../../shared/node/hash.ts';

import { fetchWithIsolatedDns } from '../../fetchWithIsolatedDns.ts';
import { privateWrite } from '../files.ts';

export interface ArtifactBinding {
  version: string;
  releaseId: string;
  artifactSha: string;
  manifestSha: string;
  fileSha: string;
  entry: 'bin/grigdesk-relay';
  platform: 'linux-x64';
  envelope?: ReleaseEnvelope;
}

export interface RelayArtifact {
  file: string;
  digest: string;
  version: string;
  staging?: string;
  binding?: ArtifactBinding;
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

  const fetcher = options.release?.fetch ?? fetchWithIsolatedDns;
  const source = new ReleaseChannelService({
    channel: options.receipt?.channel ?? 'release',
    ...options.release,
    fetch: fetcher,
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

  if (envelope.payload.platform.os !== 'linux' || envelope.payload.platform.arch !== 'x64'
    || ![0o555, 0o755].includes(entry.mode)) {
    throw new Error('relay_artifact_incompatible');
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
      fetcher,
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
    binding: {
      version: envelope.payload.version,
      releaseId: envelope.payload.releaseId,
      artifactSha: artifact.sha256,
      manifestSha: verifyReleaseEnvelope(envelope, options.release?.publicKeyPem),
      fileSha: entry.sha256,
      entry: 'bin/grigdesk-relay',
      platform: 'linux-x64',
      envelope,
    },
  };
}

function pinPath(directory: string, jobId: string): string {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(jobId)) {
    throw new Error('relay_artifact_pin_invalid');
  }

  return path.join(directory, 'relay-recovery', jobId, 'grigdesk-relay');
}

/**
 * Закрепляет подписанный файл до первой удалённой записи. Уборка preview его не удаляет.
 * Местоположение файла определяется только id задания.
 */
export async function pinRelayArtifact(directory: string, jobId: string,
  artifact: RelayArtifact): Promise<ArtifactBinding> {
  const binding: ArtifactBinding = artifact.binding ?? {
    version: artifact.version,
    releaseId: `fixture/${artifact.version}/${artifact.digest}`,
    manifestSha: artifact.digest,
    artifactSha: artifact.digest,
    fileSha: artifact.digest,
    entry: 'bin/grigdesk-relay',
    platform: 'linux-x64',
  };
  const file = pinPath(directory, jobId);

  if (await sha256File(artifact.file) !== binding.fileSha) {
    throw new Error('relay_artifact_corrupt');
  }

  await privateWrite(file, await fs.readFile(artifact.file));

  return binding;
}

/**
 * Retry заново сверяет подпись описи и локальный pin, без обращения к каналу выпуска.
 * Права и контрольная сумма проверяются при каждом открытии.
 */
export async function readRelayPin(directory: string, jobId: string,
  binding: ArtifactBinding, options: ArtifactOptions): Promise<RelayArtifact> {
  const file = pinPath(directory, jobId);
  const info = await fs.lstat(file);

  if (!info.isFile() || info.mode % 0o1000 !== 0o600
    || (process.getuid && info.uid !== process.getuid()) || await sha256File(file) !== binding.fileSha
    || binding.entry !== 'bin/grigdesk-relay' || binding.platform !== 'linux-x64') {
    throw new Error('relay_artifact_pin_invalid');
  }

  if (binding.envelope) {
    const { payload } = binding.envelope;
    const server = payload.artifacts.server;
    const entry = server.files.find((item) => item.path === binding.entry);

    if (verifyReleaseEnvelope(binding.envelope, options.release?.publicKeyPem) !== binding.manifestSha
      || payload.platform.os !== 'linux' || payload.platform.arch !== 'x64'
      || payload.version !== binding.version || payload.releaseId !== binding.releaseId
      || server.sha256 !== binding.artifactSha || entry?.sha256 !== binding.fileSha
    || ![0o555, 0o755].includes(entry.mode)) {
      throw new Error('relay_artifact_pin_invalid');
    }
  } else if (!options.resolveArtifact) {
    throw new Error('relay_artifact_pin_invalid');
  }

  return {
    file,
    digest: binding.fileSha,
    version: binding.version,
    binding,
  };
}

/**
 * Освобождает приватную копию после фиксации готового маршрута.
 * Карточка задания и нижняя граница версии остаются в журнале.
 */
export async function removeRelayPin(directory: string, jobId: string): Promise<void> {
  await fs.rm(path.dirname(pinPath(directory, jobId)), { recursive: true, force: true });
}
