import { publishInstalledRelease } from './installedPublication.mts';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
