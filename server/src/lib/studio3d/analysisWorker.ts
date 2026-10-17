// GLB анализируется только в ограниченном дочернем процессе через проверенный fd.
// Публикация rewrite не заменяет существующий файл и подтверждает ревизию входа.
import {
  closeSync,
  constants as FS,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { GLB_MAX_BYTES, GLB_JSON_MAX_BYTES, GlbError, inspectGlb, wrapGlb } from './glb.ts';
import type { WrapOptions } from './glb.ts';

/**
 * Ревизия включает ctime: простое восстановление mtime не скрывает запись в inode.
 * Source остаётся открытым весь анализ, его путь проверяется до публикации.
 */
function sourceRevision(): string {
  const stat = fstatSync(3, { bigint: true });

  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(GLB_MAX_BYTES)) {
    throw new GlbError('unsafe-file');
  }

  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/**
 * Размер и JSON chunk проверяются небольшим заголовком до выделения полного Buffer.
 * Позиционные чтения ограничены исходным stat, рост файла не увеличивает аллокацию.
 */
function sourceBytes(): Buffer {
  const size = Number(fstatSync(3).size);
  const header = Buffer.alloc(20);

  if (size < 20 || size > GLB_MAX_BYTES || readSync(3, header, 0, 20, 0) !== 20
    || header.readUInt32LE(0) !== 0x46546c67 || header.readUInt32LE(4) !== 2
    || header.readUInt32LE(8) !== size || header.readUInt32LE(16) !== 0x4e4f534a
    || header.readUInt32LE(12) > GLB_JSON_MAX_BYTES) {
    throw new GlbError('bad_glb');
  }

  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;

  while (offset < size) {
    const received = readSync(3, bytes, offset, size - offset, offset);

    if (!received) {
      throw new GlbError('changed');
    }

    offset += received;
  }

  return bytes;
}

/**
 * Закреплённый fd каталога не превращает переименованный предок в новую цель.
 * Проверяется каноническое имя и inode источника непосредственно перед link.
 */
function verifyPaths(sourcePath: string, directory: string | null, before: string): void {
  if (sourceRevision() !== before || realpathSync('/proc/self/fd/3') !== sourcePath
    || realpathSync(sourcePath) !== sourcePath) {
    throw new GlbError('changed');
  }

  const source = fstatSync(3, { bigint: true });
  const reopened = openSync(sourcePath, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);

  try {
    const current = fstatSync(reopened, { bigint: true });

    if (current.dev !== source.dev || current.ino !== source.ino) {
      throw new GlbError('changed');
    }
  } finally {
    closeSync(reopened);
  }

  if (directory && (realpathSync('/proc/self/fd/4') !== directory || realpathSync(directory) !== directory)) {
    throw new GlbError('changed-directory');
  }
}

/**
 * Собственный temporary публикуется link без overwrite и синхронизируется с папкой.
 * Любой отказ убирает только созданные этим worker имена в закреплённой папке.
 */
function publish(bytes: Uint8Array, name: string, directory: string, source: string, before: string): void {
  const temporary = `/proc/self/fd/4/.analysis-${randomUUID()}.tmp`;
  const destination = `/proc/self/fd/4/${name}`;
  const descriptor = openSync(temporary, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
  let published = false;

  try {
    let offset = 0;

    while (offset < bytes.byteLength) {
      offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    }

    fsyncSync(descriptor);
    verifyPaths(source, directory, before);
    linkSync(temporary, destination);
    published = true;
    verifyPaths(source, directory, before);
    unlinkSync(temporary);
    fsyncSync(4);
  } catch (error) {
    if (published) {
      unlinkSync(destination);
    }

    try {
      unlinkSync(temporary);
    } catch {
      // Temporary уже удалён после успешного link; чужие имена не затрагиваются.
    }

    throw error;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Запрос содержит только операцию и проверенные пути, без prefs/credentials.
 * Ответ ограничен сводкой или кодом; сырые ошибки ОС не выходят в HTTP процесс.
 */
function main(): void {
  const raw = process.argv[2] ?? '';

  if (raw.length > 8192) {
    throw new GlbError('request-limit');
  }

  const request = JSON.parse(raw) as {
    operation: string;
    sourcePath: string;
    outputDirectory: string | null;
    outputName: string | null;
    wrap: WrapOptions | null;
  };

  if (!['inspect', 'rewrite'].includes(request.operation) || typeof request.sourcePath !== 'string') {
    throw new GlbError('bad-request');
  }

  const before = sourceRevision();
  const bytes = sourceBytes();
  const result = request.operation === 'rewrite' ? wrapGlb(bytes, request.wrap ?? {}) : bytes;
  const stats = inspectGlb(result);

  verifyPaths(request.sourcePath, request.outputDirectory, before);

  if (request.operation === 'rewrite') {
    if (!request.outputDirectory || !request.outputName
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(request.outputName)
      || request.outputName.includes('..') || path.basename(request.outputName) !== request.outputName) {
      throw new GlbError('unsafe-output');
    }

    publish(result, request.outputName, request.outputDirectory, request.sourcePath, before);
  }

  process.stdout.write(JSON.stringify({ ok: true, stats }));
}

try {
  main();
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    code: error instanceof GlbError ? error.code : 'invalid-file'
  }));
}
