// Binary FBX проверяется по всем node/property границам, включая compressed arrays.
// Inspector не открывает текстуры: неподтверждённые внешние зависимости запрещены.
import { inflateSync } from 'node:zlib';
import type { FileHandle } from 'node:fs/promises';

import { StudioHttpError } from './assetErrors.ts';

interface Asset {
  id: string;
  kind: string;
  file: boolean;
  embedded: boolean;
}

/**
 * File metadata читается небольшими блоками, выделение массивов имеет общий budget.
 * Абсолютные node offsets проверяются до чтения, обход имеет пределы depth/count/time.
 */
export async function inspectBinaryFbx(handle: FileHandle, size: number, version: number): Promise<void> {
  const wide = version >= 7500;
  const headerSize = wide ? 25 : 13;
  const deadline = Date.now() + 20_000;
  const assets = new Map<string, Asset>();
  const connections: [string, string][] = [];
  const stack: { end: number; asset: Asset | null }[] = [];
  let cursor = 27;
  let nodes = 0;
  let properties = 0;
  let expanded = 0;

  /**
   * Любая запрошенная область должна целиком принадлежать открытому файлу.
   * Неверная длина не вызывает большой allocation и не раскрывает host path.
   */
  const read = async (at: number, length: number): Promise<Buffer> => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0
      || at + length > size || length > 64 * 1024 * 1024 || Date.now() > deadline) {
      throw new StudioHttpError(415, 'invalid_model', 'Структура FBX превышает допустимые границы.');
    }

    const bytes = Buffer.alloc(length);
    const result = await handle.read(bytes, 0, length, at);

    if (result.bytesRead !== length) {
      throw new StudioHttpError(415, 'invalid_model', 'FBX обрезан.');
    }

    return bytes;
  };

  /**
   * Property cursor всегда движется вперёд внутри заявленного propertiesLen.
   * Float arrays декодируются bounded и проверяют NaN/Infinity каждого элемента.
   */
  const property = async (end: number): Promise<string | number | boolean | null> => {
    const type = (await read(cursor++, 1)).toString('ascii');
    const scalarSizes: Record<string, number> = {
      Y: 2,
      C: 1,
      I: 4,
      F: 4,
      D: 8,
      L: 8
    };
    const scalarSize = scalarSizes[type];

    if (scalarSize) {
      const value = await read(cursor, scalarSize);

      cursor += scalarSize;

      if (cursor > end) {
        throw new StudioHttpError(415, 'invalid_model', 'Повреждён property FBX.');
      }
      if (type === 'L') {
        return value.readBigInt64LE().toString();
      }
      if (type === 'C') {
        return value[0] !== 0;
      }

      const number = type === 'F' ? value.readFloatLE() : type === 'D' ? value.readDoubleLE()
        : type === 'Y' ? value.readInt16LE() : value.readInt32LE();

      if (!Number.isFinite(number)) {
        throw new StudioHttpError(415, 'invalid_model', 'Неверное число FBX.');
      }

      return number;
    }

    if (type === 'S' || type === 'R') {
      const length = (await read(cursor, 4)).readUInt32LE();

      cursor += 4;

      if (cursor + length > end || (type === 'S' && length > 128 * 1024)) {
        throw new StudioHttpError(415, 'invalid_model', 'Неверная строка FBX.');
      }

      const value = type === 'S' ? (await read(cursor, length)).toString('utf8') : length > 0;

      cursor += length;

      return value;
    }

    const widths: Record<string, number> = {
      f: 4,
      d: 8,
      i: 4,
      l: 8,
      b: 1,
      c: 1
    };
    const width = widths[type];

    if (!width) {
      throw new StudioHttpError(415, 'invalid_model', 'Неизвестный property FBX.');
    }

    const meta = await read(cursor, 12);
    const count = meta.readUInt32LE(0);
    const encoding = meta.readUInt32LE(4);
    const length = meta.readUInt32LE(8);
    const decodedLength = count * width;

    cursor += 12;
    expanded += decodedLength;

    if (encoding > 1 || decodedLength > 64 * 1024 * 1024 || expanded > 150 * 1024 * 1024
      || cursor + length > end || (encoding === 0 && length !== decodedLength)) {
      throw new StudioHttpError(415, 'invalid_model', 'Массив FBX превышает допустимые границы.');
    }

    const bytes = await read(cursor, length);
    let decoded = bytes;

    if (encoding === 1) {
      try {
        decoded = inflateSync(bytes, { maxOutputLength: Math.max(1, decodedLength) });
      } catch {
        throw new StudioHttpError(415, 'invalid_model', 'Повреждён compressed массив FBX.');
      }
    }

    if (decoded.length !== decodedLength) {
      throw new StudioHttpError(415, 'invalid_model', 'Неверная длина массива FBX.');
    }

    if (type === 'f' || type === 'd') {
      for (let index = 0; index < decoded.length; index += width) {
        const number = width === 4 ? decoded.readFloatLE(index) : decoded.readDoubleLE(index);

        if (!Number.isFinite(number)) {
          throw new StudioHttpError(415, 'invalid_model', 'Неверное число FBX.');
        }
      }
    }

    cursor += length;

    return null;
  };

  while (cursor + headerSize <= size) {
    while (stack.length && cursor === stack.at(-1)!.end) {
      stack.pop();
    }

    const start = cursor;
    const header = await read(cursor, headerSize);

    cursor += headerSize;

    if (header.every((byte) => byte === 0)) {
      if (!stack.length) {
        break;
      }
      if (cursor !== stack.at(-1)!.end) {
        throw new StudioHttpError(415, 'invalid_model',
        'Неверный конец node FBX.');
      }
      
      stack.pop();

      continue;
    }

    nodes += 1;

    const end = wide ? Number(header.readBigUInt64LE(0)) : header.readUInt32LE(0);
    const count = wide ? Number(header.readBigUInt64LE(8)) : header.readUInt32LE(4);
    const length = wide ? Number(header.readBigUInt64LE(16)) : header.readUInt32LE(8);
    const nameLength = header[headerSize - 1]!;

    properties += count;

    if (!Number.isSafeInteger(end) || !Number.isSafeInteger(count) || !Number.isSafeInteger(length)
      || end > (stack.at(-1)?.end ?? size) || end < cursor + nameLength + length
      || end <= start || count > 100_000 || nodes > 100_000 || properties > 1_000_000 ||
        stack.length >= 256) {
      throw new StudioHttpError(415, 'invalid_model', 'Неверные границы node FBX.');
    }

    const name = (await read(cursor, nameLength)).toString('utf8');

    cursor += nameLength;

    const propertyEnd = cursor + length;
    const values: (string | number | boolean | null)[] = [];

    for (let index = 0; index < count; index += 1) {
      values.push(await property(propertyEnd));
    }

    if (cursor !== propertyEnd) {
      throw new StudioHttpError(415, 'invalid_model',
      'Неверный propertiesLen FBX.');
    }

    let asset = stack.at(-1)?.asset ?? null;

    if (['Video', 'Texture'].includes(name)) {
      asset = {
        id: String(values[0] ?? ''),
        kind: name,
        file: false,
        embedded: false
      };

      if (assets.has(asset.id)) {
        throw new StudioHttpError(415, 'invalid_model', 'Повтор ID ресурса FBX.');
      }

      assets.set(asset.id, asset);
    }

    if (asset && ['FileName', 'Filename',
      'RelativeFilename'].includes(name)) {
        asset.file ||= Boolean(values[0]);
      }
    if (asset && name === 'Content') {
      asset.embedded ||= Boolean(values[0]);
    }
    if (name === 'C' && values[0] === 'OO') {
      connections.push([String(values[1]), String(values[2])]);
    }

    if (cursor < end) {
      stack.push({ end, asset });
    }
  }

  if (!nodes || stack.length) {
    throw new StudioHttpError(415, 'invalid_model', 'FBX обрезан.');
  }

    const embedded = [...assets.values()].filter((asset) => asset.embedded);
    const embeddedIds = new Set(embedded.map((asset) => asset.id));
  const linked = new Set(connections.filter(([child]) => embeddedIds.has(child)).map(([, parent]) => parent));

  for (const asset of assets.values()) {
    const embedded = asset.embedded || (asset.kind === 'Texture' && linked.has(asset.id));

    if (asset.file && !embedded) {
      throw new StudioHttpError(415, 'external_resources', 'Сохраните FBX с встроенными текстурами или GLB.');
    }
  }
}
