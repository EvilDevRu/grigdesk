// Выдача картинки ограничена рабочей областью разговора и растровыми форматами.
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export const CHAT_IMAGE_MAX_BYTES = 10_000_000;

export interface ChatImageRequest {
  cwd: string;
  extraDirs?: string[];
  // Каталоги исполнителя вне рабочей папки; несуществующий каталог просто не участвует.
  imageRoots?: string[];
  requested: unknown;
}

export type ChatImageResult = { bytes: Buffer; type: string } | { status: number; error: string };
export type ChatImageFileSystem = Pick<typeof fs, 'realpath' | 'open'>;

/**
 * Читает подтверждённый растровый файл из текущей рабочей области разговора
 * или из объявленного исполнителем каталога картинок.
 * Возвращает только байты или контролируемую ошибку, без путей и сырых fs сообщений.
 */
export async function readChatImage(
  { cwd, extraDirs = [], imageRoots = [], requested }: ChatImageRequest,
  fileSystem: ChatImageFileSystem = fs,
): Promise<ChatImageResult> {
  if (typeof requested !== 'string' || !requested.trim() || requested.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(requested)) {
    return { status: 400, error: 'bad_path' };
  }

  try {
    const workRoots = [cwd, ...extraDirs].map((root) => path.resolve(root));
    const workCanonical = await Promise.all(workRoots.map((root) => fileSystem.realpath(root)));
    const executorRoots = await existingRoots(imageRoots, fileSystem);
    const requestedRoots = [...workRoots, ...executorRoots.map(([root]) => root)];
    const canonicalRoots = [...workCanonical, ...executorRoots.map(([, canonical]) => canonical)];
    const file = path.resolve(cwd, requested);

    if (!requestedRoots.some((root) => isWithinChatImageRoot(file, root))) {
      return { status: 403, error: 'outside_workdir' };
    }

    if (hiddenPath(file, requestedRoots)) {
      return { status: 404, error: 'hidden' };
    }

    const canonical = await fileSystem.realpath(file);

    if (!canonicalRoots.some((root) => isWithinChatImageRoot(canonical, root))) {
      return { status: 403, error: 'outside_workdir' };
    }

    if (hiddenPath(canonical, canonicalRoots)) {
      return { status: 404, error: 'hidden' };
    }

    const handle = await fileSystem.open(canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    try {
      const stat = await handle.stat();

      if (!stat.isFile()) {
        return { status: 404, error: 'no_file' };
      }

      const opened = await fileSystem.realpath(`/proc/self/fd/${handle.fd}`);

      if (!canonicalRoots.some((root) => isWithinChatImageRoot(opened, root))) {
        return { status: 403, error: 'outside_workdir' };
      }

      if (hiddenPath(opened, canonicalRoots)) {
        return { status: 404, error: 'hidden' };
      }

      if (stat.size > CHAT_IMAGE_MAX_BYTES) {
        return { status: 413, error: 'too_big' };
      }

      const bytes = await boundedRead(handle, stat.size);

      if (!bytes) {
        return { status: 413, error: 'too_big' };
      }

      const type = imageType(bytes);
      const expected = IMAGE_EXTENSIONS[path.extname(file).toLowerCase()];

      if (!type || type !== expected) {
        return { status: 415, error: 'not_image' };
      }

      return { bytes, type };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENXIO', 'ENODEV'].includes(code || '')) {
      return { status: 404, error: 'no_file' };
    }

    return { status: 500, error: 'image_read_failed' };
  }
}

/**
 * Каталог картинок исполнителя появляется только после первой генерации.
 * Отсутствующий каталог отбрасывается, а не превращает любой запрос в отказ.
 */
async function existingRoots(
  roots: string[],
  fileSystem: ChatImageFileSystem,
): Promise<Array<[string, string]>> {
  const found = await Promise.all(roots.map(async (root): Promise<[string, string] | null> => {
    const resolved = path.resolve(root);

    try {
      return [resolved, await fileSystem.realpath(resolved)];
    } catch {
      return null;
    }
  }));

  return found.filter((entry): entry is [string, string] => entry !== null);
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Containment сравнивает сегменты пути, включая отдельный случай корня /.
 * Сосед с общим префиксом и любой выход через .. остаются вне области.
 */
export function isWithinChatImageRoot(file: string, root: string): boolean {
  const relative = path.relative(root, file);

  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * Служебные каталоги не публикуются через маршрут изображения.
 * Исключение принадлежит только artifacts непосредственно в объявленном корне.
 */
function hiddenPath(file: string, roots: string[]): boolean {
  const base = path.parse(file).root;
  const parts = path.relative(base, file).split(path.sep);

  if (parts.includes('.git')) {
    return true;
  }

  const firstState = parts.indexOf('.state');

  if (firstState < 0) {
    return false;
  }

  const owner = path.join(base, ...parts.slice(0, firstState));

  return parts[firstState + 1] !== 'artifacts' || !roots.includes(owner) ||
    parts.slice(firstState + 1).includes('.state');
}

/**
 * Сигнатура растрового формата подтверждает расширение, не декодируя файл на сервере.
 * Повреждение после заголовка обрабатывается браузером как ошибка изображения.
 */
function imageType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }

  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return 'image/jpeg';
  }

  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }

  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }

  return '';
}

/**
 * Чтение идёт с одного fd, и буфер равен проверенному размеру плюс один байт: память
 * пропорциональна файлу, а не лимиту. Лишний байт ловит рост после fstat — такой файл
 * уже не тот, что прошёл проверку размера, и отдаётся как слишком большой.
 */
async function boundedRead(handle: FileHandle, size: number): Promise<Buffer | null> {
  const buffer = Buffer.alloc(Math.min(size, CHAT_IMAGE_MAX_BYTES) + 1);
  let count = 0;

  while (count < buffer.length) {
    const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);

    if (!bytesRead) {
      break;
    }

    count += bytesRead;
  }

  return count > size ? null : buffer.subarray(0, count);
}
