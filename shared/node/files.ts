import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Читает UTF-8 текст, отличая отсутствующий файл от ошибки чтения.
 * Только ENOENT даёт null; остальные errno сохраняются для вызывающей области.
 */
export async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

/**
 * Выделяет отдельную build-папку в заданном кеше и удаляет её после callback.
 * Результат и ошибка callback сохраняются; ошибка очистки остаётся явной.
 */
export async function withWorkDirectory<T>(
  cacheDir: string,
  produce: (work: string) => Promise<T>,
): Promise<T> {
  await mkdir(cacheDir, { recursive: true });

  const work = await mkdtemp(path.join(cacheDir, 'build-'));

  try {
    return await produce(work);
  } finally {
    await rm(work, {
      recursive: true,
      force: true,
    });
  }
}

/**
 * Синхронизирует запись каталога, не следуя ссылке вместо самого каталога.
 * Дескриптор закрывается при успехе и ошибке; отказ fsync не подавляется.
 */
export async function syncDirectory(dir: string): Promise<void> {
  let handle;

  try {
    handle = await open(dir, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    await handle.sync();
  } finally {
    await handle?.close();
  }
}
