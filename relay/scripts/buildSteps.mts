import {
  chmod,
  copyFile,
  mkdir,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

import { nodeArchive } from '../../shared/node/seaBuild.ts';
import { sha256File } from '../../shared/node/hash.ts';

export type NodeRuntime = {
  version: string;
  platform: 'linux-x64';
  sha256: string;
};

export const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/**
 * Разбирает единственную настройку сборки до сетевых и файловых эффектов.
 * Относительный путь всегда относится к папке вызывающего процесса.
 */
export function parseBuildArgs(args: readonly string[], cwd: string, relayDir: string):
  { outDir: string } | { error: string } {
  if (args.length === 0) {
    return { outDir: path.resolve(relayDir, '..', 'bin') };
  }

  if (args.length === 2 && args[0] === '--out-dir' && args[1] && !args[1].startsWith('--')) {
    return { outDir: path.resolve(cwd, args[1]) };
  }

  return { error: 'Использование: npm --prefix relay run build -- [--out-dir <каталог>]' };
}

/**
 * Принимает только закреплённую ветку Node и полный SHA256 официального архива.
 * Неверный manifest не должен незаметно изменить runtime выпуска.
 */
export function readNodeRuntime(value: unknown): NodeRuntime {
  const record = value as Partial<NodeRuntime> | null;

  if (!record || typeof record !== 'object' ||
      typeof record.version !== 'string' || !/^24\.[0-9]+\.[0-9]+$/.test(record.version) ||
      record.platform !== 'linux-x64' ||
      typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error('Некорректный relay/build/node-runtime.json');
  }

  return {
    version: record.version,
    platform: record.platform,
    sha256: record.sha256,
  };
}

/**
 * Проверяет кэш при каждой сборке и публикует только архив с правильным хэшем.
 * Незавершённая загрузка удаляется после каждой попытки, включая ошибку сети.
 */
export async function ensureNodeArchive(
  runtime: NodeRuntime,
  cacheDir: string,
  options: {
    download: (url: string, file: string) => Promise<void>;
    attempts?: number;
    pauseMs?: number;
  },
): Promise<string> {
  await mkdir(cacheDir, { recursive: true });

  const { name, url } = nodeArchive(runtime);
  const archive = path.join(cacheDir, name);

  try {
    if (await sha256File(archive) === runtime.sha256) {
      return archive;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await rm(archive, { force: true });

  const part = `${archive}.part-${process.pid}`;
  const attempts = options.attempts ?? 5;
  let failure: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await options.download(url, part);

      if (await sha256File(part) !== runtime.sha256) {
        throw new Error('Контрольная сумма архива Node не совпала');
      }

      await rename(part, archive);

      return archive;
    } catch (error) {
      failure = error;
    } finally {
      await rm(part, { force: true });
    }

    if (attempt + 1 < attempts) {
      await pause(options.pauseMs ?? 10000);
    }
  }

  throw failure ?? new Error('Не удалось получить архив Node');
}

/**
 * Публикует исполняемый файл заменой записи каталога на том же разделе.
 * Прежний файл остаётся целым при любой ошибке подготовки новой копии.
 */
export async function publishFile(source: string, target: string): Promise<void> {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}-${process.pid}.tmp`);

  await mkdir(directory, { recursive: true });

  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o755);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
