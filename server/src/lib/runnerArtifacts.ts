// Ограниченное чтение артефактов завершённого запуска для диагностических DTO.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_TAIL_BYTES = 256 * 1024;

/**
 * Каждый дочерний каталог открывается относительно удерживаемого родителя.
 * Подмена пути ссылкой не позволяет карточке читать файлы за пределами run-каталога.
 */
export async function openRunDirectory(root: string, parts: string[]): Promise<FileHandle> {
  let directory = await open(root, DIRECTORY_FLAGS);

  try {
    for (const part of parts) {
      const child = await open(`/proc/self/fd/${directory.fd}/${part}`, DIRECTORY_FLAGS);

      await directory.close();
      directory = child;
    }

    return directory;
  } catch (error) {
    await directory.close();

    throw error;
  }
}

/**
 * Метаданные читаются целиком, журнал — только с конца. Не принимаем ссылку, FIFO,
 * hardlink или файл, изменившийся во время чтения; крупная первая строка хвоста отбрасывается.
 */
export async function readRunFile(directory: FileHandle, name: string, tail = false): Promise<string> {
  const file = await open(`/proc/self/fd/${directory.fd}/${name}`, FILE_FLAGS);

  try {
    const before = await file.stat();
    const limit = tail ? MAX_TAIL_BYTES : 64 * 1024;

    if (!before.isFile() || before.nlink !== 1 || (!tail && before.size > limit)) {
      throw new Error('unsupported run file');
    }

    const start = Math.max(0, before.size - limit);
    const bytes = Buffer.alloc(Math.min(before.size, limit));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    const after = await file.stat();

    if (bytesRead !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('unstable run file');
    }

    const text = bytes.toString('utf8');

    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await file.close();
  }
}

