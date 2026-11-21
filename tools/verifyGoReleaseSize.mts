import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';

import { extractReleaseArtifact } from '../shared/node/releaseArchive.ts';
import { verifyReleaseEnvelope } from '../shared/node/releaseTrust.ts';
import type { ReleaseEnvelope } from '../shared/runtime/installedUpdateContracts.ts';
import { verifyDistributionArtifacts } from './releaseArtifactVerification.mts';
import type { DistributionTrust, VerifiedDistribution } from './releaseArtifactVerification.mts';

const modes = ['local', 'remote', 'server'] as const;
const legacyCommit = '61d944420a16e0e5bedb0a91dd796deef13abd41';

export interface SizeMeasures {
  raw: number;
  gzip: number;
  download: Record<(typeof modes)[number], number>;
}

/**
 * Каждый порог независим. Равенство размера и неполное измерение запрещают
 * посчитать изменение уменьшением, даже если все остальные числа меньше.
 */
export function requireGoSizeReduction(previous: SizeMeasures, current: SizeMeasures): void {
  const sizes = [
    ['tracker_raw', previous.raw, current.raw],
    ['tracker_gzip', previous.gzip, current.gzip],
    ...modes.map((mode) => [mode, previous.download[mode], current.download[mode]] as const),
  ] as const;

  for (const [name, before, after] of sizes) {
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after)
      || before <= 0 || after <= 0 || after >= before) {
      throw new Error('release_go_size_gate:' + name);
    }
  }
}

/**
 * Gzip обеих версий читает через stdin одни и те же байты и не кодирует имя
 * или время файла. Замер ведётся счётчиком потока, не хранит архив в памяти.
 */
async function gzipDownload(file: string): Promise<number> {
  const child = spawn('gzip', ['-n', '-6', '-c'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = once(child, 'close');
  let size = 0;

  child.stdout.on('data', (bytes: Buffer) => {
    size += bytes.length;
  });

  const [, [code]] = await Promise.all([pipeline(createReadStream(file), child.stdin), closed]);

  if (code !== 0 || size <= 0) {
    throw new Error('release_tracker_gzip_failed');
  }

  return size;
}

/**
 * Сравнивает только tracker, извлечённый из уже проверенного подписанного
 * server archive. Остальные шесть утилит остаются диагностикой отчёта.
 */
async function distributionMeasures(directory: string, release: VerifiedDistribution, work: string) {
  const artifact = release.envelope.payload.artifacts.server;
  const tracker = artifact.files.find((entry) => entry.path === 'bin/tracker');

  if (!tracker) {
    throw new Error('release_size_tracker_missing');
  }

  await extractReleaseArtifact(path.join(directory, 'server.tar.gz'), work, artifact);

  const file = path.join(work, tracker.path);
  const metadata = release.bootstrap;
  const tools = Object.fromEntries(artifact.files.filter(({ path: relative }) =>
    /^bin\/(tracker|pipeline|routes|voice|grigdesk-relay)$/u.test(relative))
    .map(({ path: relative, size }) => [relative.slice(4), size]));

  if (release.envelope.format === 3) {
    tools['grigdesk-ctl'] = release.envelope.payload.artifacts.control!.files[0]!.size;
    tools['grigdesk-maintenance'] = metadata.helperSize;

    if (Object.keys(tools).length !== 7) {
      throw new Error('release_size_utility_inventory_invalid');
    }
  }

  return {
    raw: (await fs.stat(file)).size,
    gzip: await gzipDownload(file),
    download: metadata.downloadBytes,
    indexSha256: metadata.indexSha256,
    bootstrapManifestDigest: metadata.manifestDigest,
    archives: Object.fromEntries(Object.entries(release.envelope.payload.artifacts)
      .map(([part, entry]) => [part, { bytes: entry.size, sha256: entry.sha256 }])),
    tools,
  };
}

interface SizeGateInputs {
  legacy: string;
  current: string;
  trust: DistributionTrust;
  legacyDigest: string;
  currentDigest: string;
}

/**
 * Шлюз принимает только явно закреплённые A v2 и точный подписанный C v3.
 * Формат и platform выбираются подписанным индексом и подтверждаются артефактами.
 */
export async function verifyGoReleaseSize(input: SizeGateInputs) {
  const [legacy, current] = await Promise.all([
    verifyDistributionArtifacts(input.legacy, {
      ...input.trust,
      expectedCommit: legacyCommit,
      expectedManifestDigest: input.legacyDigest,
      requireHostPlatform: true,
    }),
    verifyDistributionArtifacts(input.current, {
      ...input.trust,
      expectedManifestDigest: input.currentDigest,
      requireHostPlatform: true,
    }),
  ]);

  if (legacy.envelope.format !== undefined || current.envelope.format !== 3
    || legacy.envelope.payload.version !== '0.2.0'
    || legacy.envelope.payload.platform.os !== current.envelope.payload.platform.os
    || legacy.envelope.payload.platform.arch !== current.envelope.payload.platform.arch) {
    throw new Error('release_go_size_input_invalid');
  }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-go-size-'));

  try {
    const [a, c] = await Promise.all([
      distributionMeasures(input.legacy, legacy, path.join(work, 'A')),
      distributionMeasures(input.current, current, path.join(work, 'C')),
    ]);

    requireGoSizeReduction(a, c);

    return {
      legacy: a,
      current: c,
      identities: [legacy.envelope, current.envelope].map((envelope: ReleaseEnvelope) => ({
        releaseId: envelope.payload.releaseId,
        digest: verifyReleaseEnvelope(envelope, input.trust.publicKeyPem),
      })),
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
