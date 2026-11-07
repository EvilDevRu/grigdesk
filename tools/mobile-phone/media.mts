import { readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Raster signature и размеры проверяются до передачи файла браузерному декодеру.
 * Предел площади одинаков с Android, поэтому маленький сжатый файл не обходится по байтам.
 */
export function rasterSize(bytes: Buffer, mime: string) {
  let width = 0;
  let height = 0;

  if (
    mime === 'image/png' &&
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (
    mime === 'image/gif' &&
    bytes.length >= 10 &&
    /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
  ) {
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
  } else if (
    mime === 'image/webp' &&
    bytes.length >= 30 &&
    bytes.subarray(0, 4).toString() === 'RIFF' &&
    bytes.subarray(8, 12).toString() === 'WEBP'
  ) {
    const format = bytes.subarray(12, 16).toString();

    if (format === 'VP8X') {
      width = 1 + bytes.readUIntLE(24, 3);
      height = 1 + bytes.readUIntLE(27, 3);
    } else if (format === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from('9d012a', 'hex'))) {
      width = bytes.readUInt16LE(26) & 16383;
      height = bytes.readUInt16LE(28) & 16383;
    } else if (format === 'VP8L' && bytes[20] === 0x2f) {
      const packed = bytes.readUInt32LE(21);

      width = 1 + (packed & 16383);
      height = 1 + ((packed >> 14) & 16383);
    }
  } else if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let position = 2;

    while (position + 8 < bytes.length && position < 1048576) {
      if (bytes[position] !== 255) {
        break;
      }

      const marker = bytes[position + 1];
      const length = bytes.readUInt16BE(position + 2);

      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker!,
        )
      ) {
        height = bytes.readUInt16BE(position + 5);
        width = bytes.readUInt16BE(position + 7);
        break;
      }
      if (length < 2) {
        break;
      }

      position += length + 2;
    }
  }
  if (width < 1 || height < 1 || width * height > 24000000) {
    throw new Error('media_type');
  }

  return {
    width,
    height,
  };
}

/**
 * Кэш ограничен суммой самих изображений и metadata; удаление идёт от старого файла.
 * ETag всегда удаляется вместе с данными, чтобы 304 не ссылался на отсутствующую картинку.
 */
export async function evictMedia(directory: string, limit = 100000000) {
  const files = [];

  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{64}$/.test(name)) {
      continue;
    }

    const file = path.join(directory, name);
    const data = await stat(file);
    const metadata = await stat(file + '.etag').catch(() => null);

    files.push({
      file,
      size: data.size + (metadata?.size || 0),
      at: data.mtimeMs,
    });
  }

  let total = files.reduce((sum, file) => sum + file.size, 0);

  for (const file of files.sort((a, b) => a.at - b.at)) {
    if (total <= limit) {
      break;
    }

    await rm(file.file, { force: true });
    await rm(file.file + '.etag', { force: true });
    total -= file.size;
  }
}
