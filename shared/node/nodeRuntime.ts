import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';

import { sha256File } from './hash.ts';
import { nodeArchive } from './seaBuild.ts';

/**
 * Общие шаги выпуска SEA для tracker, DeepSeek, посредника и сервера.
 * Контракты кэша архива и атомарной публикации одинаковы; различия сборщиков
 * остаются в их собственных модулях.
 */

export interface NodeRuntime {
  version: string;
  platform: 'linux-x64';
  sha256: string;
}

export interface ArchiveOptions {
  download: (url: string, file: string) => Promise<void>;
  attempts?: number;
  pauseMs?: number;
  discardInvalidArchive?: boolean;
}

export const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/**
 * Принимает только закреплённую ветку Node, linux-x64 и полный SHA256 архива.
 * Метка manifest попадает в сообщение, чтобы ошибку нельзя было спутать с чужим выпуском.
 */
export function readNodeRuntime(value: unknown, manifest: string): NodeRuntime {
  const record = value as Partial<NodeRuntime> | null;

  if (!record || typeof record !== 'object'
    || typeof record.version !== 'string' || !/^24\.[0-9]+\.[0-9]+$/.test(record.version)
    || record.platform !== 'linux-x64'
    || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error(`Некорректный ${manifest}`);
  }

  return {
    version: record.version,
    platform: record.platform,
    sha256: record.sha256,
  };
}

/**
 * Проверяет кэш при каждой сборке и публикует только архив с правильным хэшем.
 * Временный файл уникален и удаляется после попытки; при исчерпании попыток
 * прежний архив не перетирается, а признак discardInvalidArchive удаляет
 * заведомо испорченный кэш до загрузки (контракт посредника).
 */
export async function ensureNodeArchive(
  runtime: NodeRuntime,
  cacheDir: string,
  options: ArchiveOptions,
): Promise<string> {
  await mkdir(cacheDir, {
    recursive: true
  });

  const { name, url } = nodeArchive(runtime);
  const archive = path.join(cacheDir, name);
  let invalidArchive = false;

  try {
    if (await sha256File(archive) === runtime.sha256) {
      return archive;
    }

    invalidArchive = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (invalidArchive && options.discardInvalidArchive) {
    await rm(archive, {
      force: true
    });
  }

  const attempts = options.attempts ?? 5;
  let failure: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const part = `${archive}.part-${randomUUID()}`;

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
      await rm(part, {
        force: true
      });
    }

    if (attempt + 1 < attempts) {
      await pause(options.pauseMs ?? 10000);
    }
  }

  throw failure ?? new Error('Не удалось получить архив Node');
}

const execFileAsync = promisify(execFile);

/**
 * Отказывает, если путь публикации ещё отслеживает git: бинарник в сотни мегабайт стал бы
 * правкой отслеживаемого файла и ушёл бы в коммит. Без git, вне репозитория или для нового
 * пути проверка не мешает.
 */
export async function assertUntracked(target: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', path.dirname(target), 'ls-files', '--error-unmatch', '--',
      path.basename(target)], { timeout: 10_000 });
  } catch {
    return;
  }

  throw new Error(`${target} ещё отслеживается git — сначала зафиксируйте удаление прежней версии`);
}

/**
 * Публикует файл заменой записи каталога на том же разделе.
 * Прежний файл остаётся целым при любой ошибке подготовки новой копии.
 */
export async function publishFile(source: string, target: string): Promise<void> {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}-${randomUUID()}.tmp`);

  await mkdir(directory, {
    recursive: true
  });

  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o755);
    await rename(temporary, target);
  } finally {
    await rm(temporary, {
      force: true
    });
  }
}
