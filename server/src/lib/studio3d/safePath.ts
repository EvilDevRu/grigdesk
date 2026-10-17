// Файловые операции закрепляют открытый inode и папку назначения. Проверка строки
// realpath сама по себе не защищает от подмены предка между resolve и эффектом.
import { createHash, randomUUID } from 'node:crypto';
import { constants as FS, promises as fs } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { DocumentReader } from '../documents/reader.ts';
import { withPathLock } from '../pathLock.ts';
import { borrowedReadStream, borrowedWriteStream } from './fileStreams.ts';

const reader = new DocumentReader();

export class SafePathError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code === 'exists' ? 'Файл уже существует.' : code === 'changed'
      ? 'Файл изменился: подтвердите актуальное содержимое.' : 'Небезопасный путь или файл.');
    this.name = 'SafePathError';
    this.code = code;
  }
}

export interface PinnedDirectory {
  canonical: string;
  root: string;
  handle: FileHandle;
  verify(): Promise<void>;
  child(name: string): string;
  close(): Promise<void>;
}

export interface SafeCopyOptions {
  sourceRoot: string;
  source: string;
  targetRoot: string;
  target: string;
  overwrite?: boolean;
  expectedSha256?: string;
  maxBytes?: number;
  beforeOpen?: () => Promise<unknown>;
  beforePublish?: () => Promise<unknown>;
}

export interface AtomicWriteOptions {
  root: string;
  target: string;
  data: Uint8Array | string;
  overwrite?: boolean;
  internalReplace?: boolean;
  expectedSha256?: string;
  beforePublish?: () => Promise<unknown>;
}

/**
 * Basename не содержит скрытого пути, percent encoding или повторных точек.
 * Эта проверка применяется и к manifest, и к имени из пользовательского запроса.
 */
export function isSafeName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)
    && !name.includes('..');
}

/**
 * Внешнее имя может содержать кириллицу и пробелы, но остаётся одним сегментом пути.
 * Скрытые имена, переход к родителю, разделители и управляющие символы запрещены.
 */
export function isExternalName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length > 0 && !name.startsWith('.')
    && !name.includes('..') && !/[\/\\\x00-\x1f\x7f-\x9f]/.test(name);
}

/**
 * URL encoded traversal не становится разрешённым файловым именем после decode.
 * Обычные абсолютные пути проверяются далее по каноническим сегментам.
 */
function safePathText(value: string): boolean {
  return !value.includes('\0') && !/%(?:2e|2f|5c|00|25)/i.test(value);
}

/**
 * Несуществующая цель разрешается через ближайшего существующего предка.
 * Ссылка наружу и совпадающий строковый префикс не означают принадлежности корню.
 */
export async function insideRoot(root: string, target: string): Promise<boolean> {
  if (!safePathText(root) || !safePathText(target)) {
    return false;
  }

  try {
    const canonicalRoot = await fs.realpath(root);
    let ancestor = path.resolve(target);
    const suffix: string[] = [];

    for (;;) {
      try {
        ancestor = await fs.realpath(ancestor);

        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return false;
        }

        suffix.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }

    const relative = path.relative(canonicalRoot, path.join(ancestor, ...suffix));

    return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
      && !relative.startsWith(`..${path.sep}`));
  } catch {
    return false;
  }
}

/**
 * O_NONBLOCK предотвращает зависание на подставленной FIFO. Проверка обычного
 * файла и hardlink следует по fd, а O_NOFOLLOW закрывает конечный symlink.
 */
export function openNoFollow(file: string): Promise<FileHandle> {
  return fs.open(file, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
}

/**
 * Ревизия использует наносекундные mtime/ctime вместе с inode и размером.
 * Один сохранённый mtime не доказывает, что источник не изменился при copy.
 */
export function fileRevision(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
}

/**
 * Разрешённый canonical root закрепляется при открытии библиотеки/области.
 * Его подмена ссылкой не выдаёт новых прав на внешнюю папку следующей операции.
 */
async function anchoredRoot(root: string): Promise<string> {
  const canonical = await fs.realpath(root);

  if (canonical !== path.resolve(root)) {
    throw new SafePathError('changed');
  }

  return canonical;
}

/**
 * Открытый файл подтверждается в текущем корне и не читается повторно по строке.
 * Необычный inode и несколько hardlink отвергаются до первого чтения.
 */
export async function openVerified(root: string, file: string): Promise<{
  handle: FileHandle;
  canonical: string;
  root: string;
  revision: string;
  size: number;
  verify(): Promise<void>;
}> {
  if (!await insideRoot(root, file)) {
    throw new SafePathError('unsafe_path');
  }

  const canonicalRoot = await anchoredRoot(root);
  const canonical = await fs.realpath(file);
  const handle = await openNoFollow(file);

  try {
    const stat = await handle.stat({ bigint: true });

    if (!stat.isFile() || stat.nlink !== 1n) {
      throw new SafePathError('invalid_file');
    }

    await reader.verifiedOpenedPath(handle, canonicalRoot, canonical);

    const revision = fileRevision(stat);

    /**
     * Перед эффектом сверяет корень, inode пути и точную ревизию открытого fd.
     * Переименование или правка не выдаёт разрешение на подменённое содержимое.
     */
    const verify = async () => {
      await anchoredRoot(canonicalRoot);
      await reader.verifiedOpenedPath(handle, canonicalRoot, canonical);

      const [current, atPath] = await Promise.all([
        handle.stat({ bigint: true }), fs.lstat(canonical, { bigint: true }),
      ]);

      if (fileRevision(current) !== revision || current.dev !== atPath.dev || current.ino !== atPath.ino
        || !atPath.isFile() || atPath.isSymbolicLink() || !await insideRoot(canonicalRoot, canonical)) {
        throw new SafePathError('changed');
      }
    };

    await verify();

    return {
      handle,
      canonical,
      root: canonicalRoot,
      revision,
      size: Number(stat.size),
      verify
    };
  } catch (error) {
    await handle.close();

    throw error;
  }
}

/**
 * Каталог закрепляется до создания temporary. Его /proc имя перепроверяется
 * при публикации, поэтому переименованный предок не меняет разрешённую цель.
 */
export async function pinDirectory(root: string, directory: string): Promise<PinnedDirectory> {
  if (!await insideRoot(root, directory)) {
    throw new SafePathError('unsafe_path');
  }

  const canonicalRoot = await anchoredRoot(root);
  const canonical = await fs.realpath(directory);
  const handle = await fs.open(directory, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);

  /**
   * Закреплённый directory остаётся тем же inode в прежнем canonical root.
   * Проверка запрещает публикацию после подмены его имени или предка.
   */
  const verify = async () => {
    await anchoredRoot(canonicalRoot);
    await reader.verifiedOpenedPath(handle, canonicalRoot, canonical);

    const [current, atPath] = await Promise.all([handle.stat(), fs.lstat(canonical)]);

    if (!current.isDirectory() || !atPath.isDirectory() || current.dev !== atPath.dev
      || current.ino !== atPath.ino || !await insideRoot(canonicalRoot, canonical)) {
      throw new SafePathError('changed');
    }
  };

  try {
    await verify();

    return {
      canonical,
      root: canonicalRoot,
      handle,
      verify,
      child: (name) => `/proc/self/fd/${handle.fd}/${name}`,
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();

    throw error;
  }
}

/**
 * Недостающие папки создаются по одной через закреплённого родителя.
 * Recursive mkdir по непроверенной строке не применяется внутри библиотеки.
 */
export async function ensureDirectory(root: string, target: string): Promise<void> {
  if (!await insideRoot(root, target)) {
    throw new SafePathError('unsafe_path');
  }

  const canonicalRoot = await anchoredRoot(root);
  const components = path.relative(canonicalRoot, path.resolve(target)).split(path.sep).filter(Boolean);
  let current = canonicalRoot;

  for (const name of components) {
    if (!isExternalName(name) && !['.jobs', '.uploads'].includes(name)) {
      throw new SafePathError('unsafe_path');
    }

    const parent = await pinDirectory(canonicalRoot, current);

    try {
      await parent.verify();
      await fs.mkdir(parent.child(name), { mode: 0o700 }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      });
      await parent.verify();

      current = path.join(current, name);

      const child = await pinDirectory(canonicalRoot, current);

      await child.close();
    } finally {
      await parent.close();
    }
  }
}

/**
 * Хеш берётся с уже подтверждённого fd и завершается проверкой ревизии.
 * У сохранения overwrite это показанная пользователю версия назначения.
 */
export async function verifiedHash(root: string, file: string): Promise<{ size: number; sha256: string }> {
  const opened = await openVerified(root, file);
  const hash = createHash('sha256');

  try {
    await pipeline(borrowedReadStream(opened.handle, opened.canonical), hash);
    await opened.verify();

    return { size: opened.size, sha256: hash.digest('hex') };
  } finally {
    await opened.handle.close();
  }
}

/**
 * Replace требует актуальную сумму, кроме собственных метаданных библиотеки.
 * Без overwrite link публикует атомарно, существующий файл никогда не заменяется.
 */
async function publish(
  directory: PinnedDirectory,
  temporary: string,
  target: string,
  options: {
    overwrite?: boolean;
    internalReplace?: boolean;
    expectedSha256?: string;
  },
): Promise<void> {
  await directory.verify();

  if (options.overwrite) {
    if (!options.internalReplace) {
      if (!options.expectedSha256) {
        throw new SafePathError('changed');
      }

      const previous = await verifiedHash(directory.root, path.join(directory.canonical, target));

      if (previous.sha256 !== options.expectedSha256) {
        throw new SafePathError('changed');
      }
    } else {
      const stat = await fs.lstat(directory.child(target)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }

        return null;
      });

      if (stat && (!stat.isFile() || stat.nlink !== 1)) {
        throw new SafePathError('invalid_file');
      }
    }

    await directory.verify();
    await fs.rename(directory.child(temporary), directory.child(target));
  } else {
    try {
      await fs.link(directory.child(temporary), directory.child(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new SafePathError('exists');
      }

      throw error;
    }

    await fs.unlink(directory.child(temporary));
  }

  await directory.handle.sync();
}

/**
 * JSON и небольшие производные файлы пишутся через отдельный wx temporary.
 * fsync файла и каталога предшествуют успешному ответу вызывающему журналу.
 */
export async function atomicWrite(options: AtomicWriteOptions): Promise<{ size: number; sha256: string }> {
  return withPathLock(path.resolve(options.target), async () => {
    const name = path.basename(options.target);

    if (!isSafeName(name) && !['.library.json', '.gitignore'].includes(name)) {
      throw new SafePathError('unsafe_path');
    }

    const directory = await pinDirectory(options.root, path.dirname(options.target));
    const temporary = `.write-${randomUUID()}.tmp`;
    let handle: FileHandle | null = null;

    try {
      handle = await fs.open(directory.child(temporary), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
      await handle.writeFile(options.data);
      await handle.sync();
      await handle.close();

      handle = null;

      await options.beforePublish?.();
      await publish(directory, temporary, name, options);

      const bytes = typeof options.data === 'string' ? Buffer.from(options.data) : options.data;

      return { size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    } finally {
      await handle?.close();
      await fs.unlink(directory.child(temporary)).catch(() => {});
      await directory.close();
    }
  });
}

/**
 * Copy создаёт независимый inode, вычисляет SHA потоком и отвергает правку source.
 * Последняя проверка выполняется перед публикацией, а запись идёт через pinned parent.
 */
export async function safeCopy(options: SafeCopyOptions): Promise<{ size: number; sha256: string }> {
  return withPathLock(path.resolve(options.target), async () => {
    if (!isExternalName(path.basename(options.target))
      || !await insideRoot(options.sourceRoot, options.source)) {
      throw new SafePathError('unsafe_path');
    }

    const canonical = await fs.realpath(options.source);

    await options.beforeOpen?.();

    const opened = await openVerified(options.sourceRoot, options.source);

    if (opened.canonical !== canonical || opened.size > (options.maxBytes ?? 1024 * 1024 * 1024)) {
      await opened.handle.close();

      throw new SafePathError('unsafe_path');
    }

    let directory: PinnedDirectory | null = null;
    let destination: FileHandle | null = null;
    const temporary = `.copy-${randomUUID()}.tmp`;
    const hash = createHash('sha256');
    let size = 0;

    try {
      directory = await pinDirectory(options.targetRoot, path.dirname(options.target));
      destination = await fs.open(directory.child(temporary), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);

      const guard = new Transform({
        /**
         * Изменение длины не может незаметно расширить исходный snapshot.
         * SHA считается над теми же байтами, которые поступают в новый inode.
         */
        transform(bytes: Buffer, _encoding, done) {
          size += bytes.length;
          hash.update(bytes);

          if (size > opened.size) {
            done(new SafePathError('changed'));
          } else {
            done(null, bytes);
          }
        }
      });

      await pipeline(
        borrowedReadStream(opened.handle, opened.canonical),
        guard,
        borrowedWriteStream(destination, directory.child(temporary)),
      );
      await destination.sync();
      await destination.close();

      destination = null;

      await options.beforePublish?.();
      await opened.verify();

      if (size !== opened.size) {
        throw new SafePathError('changed');
      }

      await publish(directory, temporary, path.basename(options.target), options);

      return { size, sha256: hash.digest('hex') };
    } finally {
      await destination?.close();
      await opened.handle.close();

      if (directory) {
        await fs.unlink(directory.child(temporary)).catch(() => {});
        await directory.close();
      }
    }
  });
}

/**
 * Metadata ограничивается до чтения и проверяется после чтения по той же ревизии.
 * Битый JSON не позволяет библиотеке перейти к произвольному пути из manifest.
 */
export async function readJson(root: string, file: string, maxBytes = 1024 * 1024): Promise<unknown> {
  const opened = await openVerified(root, file);

  try {
    if (opened.size > maxBytes) {
      throw new SafePathError('too_large');
    }

    const bytes = Buffer.alloc(opened.size);
    let offset = 0;

    while (offset < bytes.length) {
      const result = await opened.handle.read(bytes, offset, bytes.length - offset, offset);

      if (!result.bytesRead) {
        throw new SafePathError('changed');
      }

      offset += result.bytesRead;
    }

    await opened.verify();

    return JSON.parse(bytes.toString('utf8'));
  } finally {
    await opened.handle.close();
  }
}
