import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Поставляемый файл сохраняет признак исполнения и не разрешает запись.
 * Приватность обеспечивается каталогами владельца, независимо от read bits файла.
 */
export function readOnlyFileMode(mode: number): number {
  return mode & 0o111 ? 0o555 : 0o444;
}

/**
 * Готовое собственное дерево получает read-only файлы и каталоги владельца 0700.
 * Ссылки не обходятся; хэши generation нужно вычислять после этого изменения modes.
 */
export async function makeReadOnlyTree(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name);
    const stat = await lstat(file);

    if (stat.isDirectory()) {
      await makeReadOnlyTree(file);
    } else if (stat.isFile()) {
      await chmod(file, readOnlyFileMode(stat.mode));
    }
  }

  await chmod(directory, 0o700);
}

/**
 * Удаляется только переданный вызывающим собственный private staging, включая read-only cache.
 * Ссылки не обходятся; права меняются только у каталогов внутри этого дерева.
 */
export async function removePrivateTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const child = path.join(directory, entry.name);

      await chmod(child, 0o700);
      await removePrivateTree(child);
    }
  }

  await rm(directory, { recursive: true, force: true });
}

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
