import fs from 'node:fs/promises';
import { assertInstallParents } from './installPaths.mts';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { decodeReleaseChannelIndex } from '../../../shared/runtime/installedUpdateContracts.ts';
import { verifyReleaseEnvelope } from '../../../shared/node/releaseTrust.ts';
import { assertReleasePlatform } from '../../../shared/node/releaseChannel.ts';
import { downloadReleaseArtifact } from '../../../shared/node/releaseArchive.ts';
import { acquireInstallLock, lstatOrNull } from '../../../shared/node/binaryInstall.ts';
import { assertInstallationPath } from '../../../shared/node/installedLayout.ts';
import { sha256File } from '../../../shared/node/hash.ts';
import { syncDirectory } from '../../../shared/node/files.ts';
import type { ReleaseEnvelope } from '../../../shared/runtime/installedUpdateContracts.ts';
import { installReleaseWithResult } from './installRelease.mts';
import { RELEASE_DISTRIBUTION_SOURCE } from '../../../shared/runtime/releaseChannelContracts.ts';

const FLAGS = ['--release', '--mode', '--root', '--data-home', '--user-data', '--bin-dir',
  '--applications-dir', '--unit-dir', '--source-dir', '--cache-dir'];

interface InstallOnlineOptions {
  release: string;
  mode: 'local' | 'remote' | 'server';
  root: string;
  dataHome: string;
  userData: string;
  binDirectory: string;
  applicationsDirectory: string;
  unitDirectory: string;
  sourceDir?: string;
  cacheDir?: string;
}

/**
 * Парсер принимает только строгие пары известных флагов с абсолютными путями.
 * Дубли и лишние поля отвергаются до чтения индекса и любой загрузки.
 */
function parseInstallOnlineArgs(argv: string[]): InstallOnlineOptions {
  const parsed = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];

    if (!key || !FLAGS.includes(key) || parsed.has(key) || !value
      || (key !== '--mode' && !path.isAbsolute(value))) {
      throw new Error('installation_arguments_invalid');
    }

    parsed.set(key, value);
  }

  const mode = parsed.get('--mode');

  if (!mode || !['local', 'remote', 'server'].includes(mode)
    || !parsed.has('--release') || !parsed.has('--root') || !parsed.has('--data-home')
    || !parsed.has('--user-data') || !parsed.has('--bin-dir')
    || !parsed.has('--applications-dir') || !parsed.has('--unit-dir')) {
    throw new Error('installation_arguments_invalid');
  }

  return {
    release: path.resolve(parsed.get('--release')!),
    mode: mode as 'local' | 'remote' | 'server',
    root: path.resolve(parsed.get('--root')!),
    dataHome: path.resolve(parsed.get('--data-home')!),
    userData: path.resolve(parsed.get('--user-data')!),
    binDirectory: path.resolve(parsed.get('--bin-dir')!),
    applicationsDirectory: path.resolve(parsed.get('--applications-dir')!),
    unitDirectory: path.resolve(parsed.get('--unit-dir')!),
    ...parsed.has('--source-dir') ? { sourceDir: path.resolve(parsed.get('--source-dir')!) } : {},
    ...parsed.has('--cache-dir') ? { cacheDir: path.resolve(parsed.get('--cache-dir')!) } : {},
  };
}

/**
 * Проверенный архив живёт в приватном content-addressed cache и переиспользуется
 * целиком; испорченный переносится в quarantine и никогда не исполняется.
 * Source-dir даёт альтернативные байты, но не альтернативные SHA, ключи или URL.
 */
function obtainArchives(envelope: ReleaseEnvelope, cacheRoot: string,
  sourceDir?: string): (component: 'desktop' | 'server') => Promise<string> {
  return async (component) => {
    const artifact = envelope.payload.artifacts[component];

    if (sourceDir) {
      const file = path.join(sourceDir, `${component}.tar.gz`);
      const stat = await lstatOrNull(file);

      if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size !== artifact.size
        || await sha256File(file) !== artifact.sha256) {
        throw new Error('install_online_source_invalid');
      }

      return file;
    }

    const cached = path.join(cacheRoot, `${component}.tar.gz`);
    const stat = await lstatOrNull(cached);

    if (stat) {
      if (!stat.isSymbolicLink() && stat.isFile() && stat.size === artifact.size
        && await sha256File(cached) === artifact.sha256) {
        return cached;
      }

      const quarantine = path.join(cacheRoot, 'quarantine');

      await fs.mkdir(quarantine, { recursive: true, mode: 0o700 });
      await fs.rename(cached, path.join(quarantine, `${component}.${randomUUID()}.tar.gz`));
    }

    const part = `${cached}.${randomUUID()}.part`;

    try {
      await downloadReleaseArtifact({
        artifact,
        destination: part,
        progress: async () => {}
      });
    } catch (error) {
      await fs.rm(part, { force: true });

      throw error;
    }

    await fs.rename(part, cached);
    await syncDirectory(cacheRoot);

    return cached;
  };
}

/**
 * Сетевой вход существующего installRelease: проверенный v2-индекс, загрузка только
 * выбранных компонентов и та же установка без исходников и npm хоста. Код 10 —
 * существующая установка обработана штатным путём обновления или повтора.
 */
export async function runInstallOnline(argv: string[]): Promise<number> {
  const options = parseInstallOnlineArgs(argv);
  const index = decodeReleaseChannelIndex(JSON.parse(await fs.readFile(options.release, 'utf8')));

  if (!index.latest) {
    throw new Error('install_online_release_invalid');
  }

  const manifestDigest = verifyReleaseEnvelope(index.latest);

  await assertReleasePlatform(index.latest.payload.platform);

  const input = {
    root: options.root,
    mode: options.mode,
    dataHome: options.dataHome,
    userData: options.userData,
    binDirectory: options.binDirectory,
    applicationsDirectory: options.applicationsDirectory,
    unitDirectory: options.unitDirectory,
    envelope: index.latest,
    maintenance: process.execPath,
  };

  if (index.latest.payload.platform.os === 'darwin' || RELEASE_DISTRIBUTION_SOURCE !== 'channel') {
    if (!options.sourceDir) {
      throw new Error('candidate_source_required');
    }

    const outcome = await installReleaseWithResult({
      ...input,
      archive: obtainArchives(index.latest, '', options.sourceDir),
    });

    return outcome.status === 'update-prepared' ? 10 : 0;
  }

  const cacheRoot = options.cacheDir ?? path.join(
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'),
    'grigdesk', 'install', manifestDigest);

  await assertInstallParents(cacheRoot);
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await assertInstallationPath(cacheRoot);

  const cacheLock = await acquireInstallLock(cacheRoot);

  try {
    const outcome = await installReleaseWithResult({
      ...input,
      archive: obtainArchives(index.latest, cacheRoot, options.sourceDir),
    });

    return outcome.status === 'fresh-installed' ? 0 : 10;
  } finally {
    await cacheLock.release();
  }
}
