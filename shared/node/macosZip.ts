import { constants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';

import { MAC_APP_MAX_BYTES } from '../runtime/installedUpdateContracts.ts';

const MAX_ENTRIES = 10_000;
const MAX_DIRECTORY = 16 * 1024 * 1024;
const FLAGS = 0x080e;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface MacZipEntry {
  name: string;
  mode: number;
  size: number;
  compressed: number;
  offset: number;
  crc: number;
  method: number;
  flags: number;
}

interface ExpectedZipEntry {
  size: number;
  sha256?: string;
  target?: string;
}

/**
 * Чтение идёт исключительно внутри уже ограниченного файла.
 * Частичный заголовок нельзя интерпретировать как отсутствующие нули.
 */
async function readAt(file: FileHandle, offset: number, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let consumed = 0;

  while (consumed < size) {
    const result = await file.read(buffer, consumed, size - consumed, offset + consumed);

    if (!result.bytesRead) {
      throw new Error('release_mac_zip_truncated');
    }

    consumed += result.bytesRead;
  }

  return buffer;
}

/**
 * Поля времени и uid/gid не меняют имя, тип и расположение записи.
 * Расширения с альтернативным именем, ссылкой или размерами запрещены.
 */
function checkExtras(bytes: Buffer): void {
  const seen = new Set<number>();

  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) {
      throw new Error('release_mac_zip_extra_invalid');
    }

    const id = bytes.readUInt16LE(offset);
    const size = bytes.readUInt16LE(offset + 2);

    offset += 4 + size;

    if (offset > bytes.length || seen.has(id) || ![0x5455, 0x5855, 0x7875].includes(id)) {
      throw new Error('release_mac_zip_extra_invalid');
    }

    seen.add(id);
  }
}

/**
 * Формат ограничен однодисковым ZIP с явными не-Zip64 размерами.
 * Физический порядок local records после разбора проверяется отдельно.
 */
async function directory(file: FileHandle, size: number) {
  const end = await readAt(file, size - 22, 22);
  const count = end.readUInt16LE(10);
  const length = end.readUInt32LE(12);
  const start = end.readUInt32LE(16);

  if (end.readUInt32LE(0) !== 0x06054b50 || end.readUInt32LE(4) !== 0
    || end.readUInt16LE(8) !== count || !count || count > MAX_ENTRIES
    || length > MAX_DIRECTORY || start + length !== size - 22 || end.readUInt16LE(20)) {
    throw new Error('release_mac_zip_directory_invalid');
  }

  const bytes = await readAt(file, start, length);
  const entries: MacZipEntry[] = [];

  for (let cursor = 0; cursor < bytes.length;) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('release_mac_zip_directory_invalid');
    }

    const header = bytes.subarray(cursor, cursor + 46);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + header.readUInt16LE(28);
    const extrasEnd = nameEnd + header.readUInt16LE(30);
    const flags = header.readUInt16LE(8);
    const method = header.readUInt16LE(10);
    const mode = header.readUInt32LE(38) >>> 16;
    const compressed = header.readUInt32LE(20);
    const expanded = header.readUInt32LE(24);
    const madeBy = header[5];

    if (extrasEnd > bytes.length || nameEnd === nameStart || nameEnd - nameStart > 4096
      || header.readUInt16LE(32) || header.readUInt16LE(34) || ![3, 19].includes(madeBy!)
      || flags & ~FLAGS || ![0, 8].includes(method) || expanded > MAC_APP_MAX_BYTES
      || compressed > size || method === 0 && compressed !== expanded) {
      throw new Error('release_mac_zip_entry_invalid');
    }

    checkExtras(bytes.subarray(nameEnd, extrasEnd));
    entries.push({
      name: utf8.decode(bytes.subarray(nameStart, nameEnd)),
      mode,
      size: expanded,
      compressed,
      offset: header.readUInt32LE(42),
      crc: header.readUInt32LE(16),
      method,
      flags,
    });
    cursor = extrasEnd;
  }

  if (entries.length !== count) {
    throw new Error('release_mac_zip_directory_invalid');
  }

  return { entries, start };
}

/**
 * Обе таблицы должны описывать одни и те же байты.
 * Между local records разрешён лишь явный data descriptor этой записи.
 */
async function dataOffset(file: FileHandle, entry: MacZipEntry, limit: number): Promise<number> {
  if (entry.offset + 30 > limit) {
    throw new Error('release_mac_zip_offsets_invalid');
  }

  const local = await readAt(file, entry.offset, 30);
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  const nameStart = entry.offset + 30;
  const offset = nameStart + nameLength + extraLength;
  const end = offset + entry.compressed;
  const descriptor = Boolean(entry.flags & 8);

  if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags
    || local.readUInt16LE(8) !== entry.method || end > limit
    || nameLength !== Buffer.byteLength(entry.name)) {
    throw new Error('release_mac_zip_local_invalid');
  }

  const metadata = await readAt(file, nameStart, nameLength + extraLength);
  const fields = [entry.crc, entry.compressed, entry.size];

  if (!metadata.subarray(0, nameLength).equals(Buffer.from(entry.name))
    || fields.some((value, index) => {
      const actual = local.readUInt32LE(14 + index * 4);

      return actual !== value && (!descriptor || actual !== 0);
    })) {
    throw new Error('release_mac_zip_local_invalid');
  }

  checkExtras(metadata.subarray(nameLength));

  if (descriptor) {
    const length = limit - end;

    if (length !== 12 && length !== 16) {
      throw new Error('release_mac_zip_descriptor_invalid');
    }

    const bytes = await readAt(file, end, length);
    const start = length - 12;

    if (start && bytes.readUInt32LE(0) !== 0x08074b50
      || fields.some((value, index) => bytes.readUInt32LE(start + index * 4) !== value)) {
      throw new Error('release_mac_zip_descriptor_invalid');
    }
  } else if (end !== limit) {
    throw new Error('release_mac_zip_offsets_invalid');
  }

  return offset;
}

/**
 * До внешней распаковки поток сверяется с подписанными размером и SHA.
 * Выход сжатого потока, превышающий опись, прерывается сразу при чтении.
 */
async function verifyEntry(
  file: FileHandle, entry: MacZipEntry, offset: number, expected: ExpectedZipEntry,
): Promise<void> {
  let bytes = 0;
  let checksum = 0;
  const hash = createHash('sha256');
  const expectedHash = expected.target === undefined ? expected.sha256
    : createHash('sha256').update(expected.target).digest('hex');

  if (entry.size !== expected.size) {
    throw new Error('release_mac_zip_size_invalid');
  }

  if (entry.compressed) {
    const input = createReadStream('', {
      fd: file.fd,
      autoClose: false,
      start: offset,
      end: offset + entry.compressed - 1,
    });
    const sink = new Writable({
      /**
       * Считает выход потока до передачи данных встроенному распаковщику.
       * Избыток относительно описи прекращает чтение этого файла.
       */
      write(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;

        if (bytes > expected.size) {
          done(new Error('release_mac_zip_size_invalid'));

          return;
        }

        checksum = crc32(chunk, checksum);
        hash.update(chunk);
        done();
      },
    });

    if (entry.method === 8) {
      const inflate = createInflateRaw();

      await pipeline(input, inflate, sink);

      if (inflate.bytesWritten !== entry.compressed) {
        throw new Error('release_mac_zip_data_invalid');
      }
    } else {
      await pipeline(input, sink);
    }
  }

  if (bytes !== expected.size || checksum !== entry.crc
    || expectedHash && hash.digest('hex') !== expectedHash) {
    throw new Error('release_mac_zip_data_invalid');
  }
}

/**
 * Читает один приватный ZIP и сравнивает центральную таблицу с описью приложения.
 * Физические диапазоны записей должны полностью покрывать данные до таблицы.
 */
export async function verifyMacZip(
  archive: string, expected: (entry: MacZipEntry) => ExpectedZipEntry,
): Promise<void> {
  const file = await fs.open(archive, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const stat = await file.stat();

    if (!stat.isFile() || stat.size < 22 || stat.size > MAC_APP_MAX_BYTES) {
      throw new Error('release_mac_zip_size_invalid');
    }

    const { entries, start } = await directory(file, stat.size);
    const physical = entries.sort((left, right) => left.offset - right.offset);

    if (physical[0]!.offset !== 0) {
      throw new Error('release_mac_zip_offsets_invalid');
    }

    for (const [index, entry] of physical.entries()) {
      const content = expected(entry);
      const offset = await dataOffset(file, entry, physical[index + 1]?.offset ?? start);

      await verifyEntry(file, entry, offset, content);
    }
  } finally {
    await file.close();
  }
}
