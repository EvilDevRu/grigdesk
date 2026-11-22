import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { publishInstalledRelease } from './installedPublication.mts';
import { assertStableLinuxFiles, readStablePromotionProof } from './promoteArtifact.mts';
import { parseReleaseChannelIndex } from '../shared/runtime/installedUpdateContracts.ts';
import { verifyReleaseEnvelope } from '../shared/node/releaseTrust.ts';
import { RELEASE_SIGNING_PUBLIC_KEY } from '../shared/runtime/releaseChannelContracts.ts';

interface SiteTarget {
  host: string;
  user: string;
  port: string;
  key: string;
  dir: string;
  origin: string;
}

/**
 * Цели собираются из RELEASE_SITE_* и необязательных наборов RELEASE_SITE_MIRROR*_*
 * (до трёх): основной хост обязателен, зеркала добавляются по заполненным наборам.
 */
function targets(): SiteTarget[] {
  const list: SiteTarget[] = [{
    host: process.env.RELEASE_SITE_HOST ?? '',
    user: process.env.RELEASE_SITE_USER ?? '',
    port: process.env.RELEASE_SITE_PORT ?? '22',
    key: process.env.RELEASE_SITE_KEY ?? '',
    dir: process.env.RELEASE_SITE_DIR ?? '',
    origin: process.env.RELEASE_SITE_PUBLIC_ORIGIN ?? '',
  }];

  for (const prefix of ['RELEASE_SITE_MIRROR_', 'RELEASE_SITE_MIRROR2_',
    'RELEASE_SITE_MIRROR3_']) {
    const host = process.env[`${prefix}HOST`] ?? '';

    if (host) {
      list.push({
        host,
        user: process.env[`${prefix}USER`] ?? '',
        port: process.env[`${prefix}PORT`] ?? '22',
        key: process.env[`${prefix}KEY`] ?? '',
        dir: process.env[`${prefix}DIR`] ?? '',
        origin: process.env[`${prefix}PUBLIC_ORIGIN`] ?? '',
      });
    }
  }

  return list;
}

/**
 * Публикация стабильного канала повторно связывает проверенный proof и подписанный индекс.
 * Dev и локальная проверка без SSH сохраняют прежний вход.
 */
async function verifyStableSitePublication(directory: string): Promise<void> {
  const names = await fs.readdir(directory);

  if (!names.includes('release.json')) {
    return;
  }

  const bytes = await fs.readFile(path.join(directory, 'release.json'), 'utf8');
  const index = parseReleaseChannelIndex(bytes);

  if (index.channel !== 'release' || !index.latest) {
    throw new Error('stable_promotion_proof_invalid');
  }

  const digest = verifyReleaseEnvelope(index.latest, RELEASE_SIGNING_PUBLIC_KEY);
  const proof = await readStablePromotionProof(process.env.GRIGDESK_STABLE_PROOF_DIR ?? '', {
    runId: process.env.GRIGDESK_GO_SOURCE_RUN_ID ?? '',
    artifactId: process.env.GRIGDESK_GO_LINUX_ARTIFACT_ID ?? '',
    commit: index.latest.payload.commit,
    version: index.latest.payload.version,
    digest,
  });

  await assertStableLinuxFiles(directory, proof);
}

/**
 * Публикация единственного формата: подписанные артефакты обычной установки
 * из release-artifacts/ уходят на сайт с проверкой до SSH (см. installedPublication).
 * Историческая публикация переносного комплекта (channel.json format 1) удалена:
 * стабильных выпусков с ним не было, сайт публикует только v1-индексы каналов.
 */
export async function publishRelease(directory: string | undefined, ports: {
  dryRun?: boolean;
} = {}): Promise<void> {

  if (!directory || !path.isAbsolute(directory)) {
    throw new Error('Использование: node tools/release-publish.mts <каталог выпуска>');
  }

  const missing = ['RELEASE_SITE_HOST', 'RELEASE_SITE_USER', 'RELEASE_SITE_KEY',
    'RELEASE_SITE_DIR', 'RELEASE_SITE_PUBLIC_ORIGIN'].filter((name) => {
    return !process.env[name];
  });

  if (missing.length) {
    process.stderr.write(`Не заданы переменные: ${missing.join(', ')}\n`);
    process.exitCode = 2;

    return;
  }

  const installedArtifacts = path.join(directory, 'release-artifacts');

  const hasInstalledArtifacts = await fs.stat(installedArtifacts).then((stat) => stat.isDirectory())
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return false;
    });

  if (!hasInstalledArtifacts) {
    process.stderr.write('Каталог не содержит release-artifacts/ — публиковать нечего\n');
    process.exitCode = 3;

    return;
  }

  if (!ports.dryRun) {
    await verifyStableSitePublication(installedArtifacts);
  }

  await publishInstalledRelease(installedArtifacts, targets(), ports.dryRun);
  process.exitCode = 0;
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await publishRelease(process.argv[2], {
    dryRun: process.argv.includes('--dry-run'),
  }).catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = process.exitCode === 3 ? 3 : 4;
  });
}
