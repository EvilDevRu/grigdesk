import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Новый файл читается относительно удерживаемых каталогов, без перехода по ссылкам:
 * ссылка на окружение или чужой каталог не должна приносить их содержимое в промпт.
 * Читаем только начало обычного файла и один лишний символ для пометки обрезки;
 * размер выделенной памяти не зависит от размера файла в рабочем дереве.
 */
export async function readContainedText(
  cwd: string,
  relative: string,
  limit: number,
): Promise<string | null> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1048576) {
    throw new Error('source_limit_invalid');
  }

  if (typeof relative !== 'string' || /[\0\\]/u.test(relative)) {
    return null;
  }

  const parts = relative.split('/');

  if (path.isAbsolute(relative) || parts.some((part) => !part || part === '.' || part === '..')) {
    return null;
  }

  // Сам корень разрешён реестром стенда; каждый вложенный компонент открываем без ссылок.
  let directory = await fs.open(cwd, constants.O_RDONLY | constants.O_DIRECTORY);
  let file: FileHandle | null = null;

  try {
    for (const part of parts.slice(0, -1)) {
      const child = await fs.open(`/proc/self/fd/${directory.fd}/${part}`, DIRECTORY_FLAGS);

      await directory.close();
      directory = child;
    }

    file = await fs.open(`/proc/self/fd/${directory.fd}/${parts.at(-1)}`, FILE_FLAGS);

    const stat = await file.stat();

    if (!stat.isFile()) {
      return null;
    }

    const buffer = Buffer.alloc(Math.min(stat.size, (limit + 1) * 4));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead);

    return content.includes(0) ? null : content.toString('utf8').slice(0, limit + 1);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
      return null;
    }

    throw error;
  } finally {
    await Promise.all([file?.close(), directory.close()]);
  }
}
