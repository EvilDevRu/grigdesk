import { VIEWER_MEMORY, dataResource } from './resourcePolicy.ts';
import type { ResourcePolicy } from './resourcePolicy.ts';

export interface FbxInspection {
  memory: number;
  compressed: { bytes: Uint8Array; length: number }[];
  images: Uint8Array[];
  references: string[];
}

/**
 * Binary FBX проверяется до рекурсивного addon и распаковки массивов.
 * Заявленные offsets, глубина и расширенный объём не управляют неограниченной аллокацией.
 */
export function inspectFbx(bytes: Uint8Array, policy: ResourcePolicy): FbxInspection {
  const result: FbxInspection = {
    memory: 0,
    compressed: [],
    images: [],
    references: []
  };
  const binary = new TextDecoder().decode(bytes.subarray(0, 20)).startsWith('Kaydara FBX Binary');
  const inspectString = (text: string) => {
    if (/(?:blob:|https?:\/\/|file:\/\/)/i.test(text)) {
      throw new Error('Внешние URI в FBX запрещены. Сохраните самостоятельный GLB.');
    }
  };

  if (!binary) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

    inspectString(text);

    for (const line of text.split('\n')) {
      if ((/^\t+/.exec(line)?.[0].length || 0) > 256) {
        throw new Error('Глубина FBX превышает 256.');
      }
    }

    for (const match of text.matchAll(/\*([0-9]+)\s*\{/g)) {
      result.memory += Number(match[1]) * 24;
    }
    for (const match of text.matchAll(/Content:\s*,?\s*"([A-Za-z0-9+/=]+)"/g)) {
      result.images.push(dataResource(`data:image/png;base64,${match[1]}`).bytes);
    }
    for (const match of text.matchAll(/(?:RelativeFilename|FileName|Filename):\s*"([^"\n]+)"/g)) {
      if (!result.images.length) {
        policy.resolve(match[1]!);
        result.references.push(match[1]!);
      }
    }

    result.memory = Math.max(result.memory, bytes.length * 8);

    if (result.memory > VIEWER_MEMORY / 2) {
      throw new Error('Слишком большой объём FBX.');
    }

    return result;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wide = bytes.length >= 27 && view.getUint32(23, true) >= 7500;
  const header = wide ? 25 : 13;
  const stack: number[] = [];
  let cursor = 27;
  let nodes = 0;
  let properties = 0;
  const integer = (at: number) => wide ? Number(view.getBigUint64(at, true)) : view.getUint32(at, true);
  const requireBytes = (length: number, end: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || cursor + length > end || end > bytes.length) {
      throw new Error('Повреждённые границы FBX.');
    }
  };

  while (cursor + header <= bytes.length) {
    while (stack.length && cursor === stack.at(-1)) {
      stack.pop();
    }

    const end = integer(cursor);

    if (end === 0) {
      cursor += header;

      if (!stack.length) {
        break;
      }
      if (cursor !== stack.pop()) {
        throw new Error('Некорректный конец node FBX.');
      }

      continue;
    }

    const count = integer(cursor + (wide ? 8 : 4));
    const length = integer(cursor + (wide ? 16 : 8));
    const nameLength = bytes[cursor + header - 1]!;

    properties += count;
    nodes += 1;

    if (!Number.isSafeInteger(end) || end > (stack.at(-1) ?? bytes.length) || end <= cursor
      || count > 100_000 || properties > 1_000_000 || nodes > 100_000 || stack.length >= 256) {
      throw new Error('Слишком сложный или повреждённый FBX.');
    }

    cursor += header;
    requireBytes(nameLength + length, end);

    const name = new TextDecoder().decode(bytes.subarray(cursor, cursor + nameLength));

    cursor += nameLength;

    const propertyEnd = cursor + length;

    for (let index = 0; index < count; index += 1) {
      requireBytes(1, propertyEnd);

      const type = String.fromCharCode(bytes[cursor++]!);
      const scalar = ({
        Y: 2,
        C: 1,
        I: 4,
        F: 4,
        D: 8,
        L: 8
      } as Record<string, number>)[type];

      if (scalar) {
        requireBytes(scalar, propertyEnd);
        cursor += scalar;
        continue;
      }
      if (type === 'S' || type === 'R') {
        requireBytes(4, propertyEnd);

        const size = view.getUint32(cursor, true);

        cursor += 4;
        requireBytes(size, propertyEnd);

        const value = bytes.subarray(cursor, cursor + size);

        if (type === 'S') {
          if (size > 128 * 1024) {
            throw new Error('Слишком длинная строка FBX.');
          }

          const text = new TextDecoder().decode(value);

          inspectString(text);

          if (['FileName', 'Filename', 'RelativeFilename'].includes(name) && text) {
            result.references.push(text);
          }
        } else if (name === 'Content' && size) {
          result.images.push(value);
        }

        cursor += size;
        continue;
      }

      const width = ({
        f: 4,
        d: 8,
        i: 4,
        l: 8,
        b: 1,
        c: 1
      } as Record<string, number>)[type];

      if (!width) {
        throw new Error('Неизвестное свойство FBX.');
      }

      requireBytes(12, propertyEnd);

      const elements = view.getUint32(cursor, true);
      const encoding = view.getUint32(cursor + 4, true);
      const size = view.getUint32(cursor + 8, true);
      const expanded = elements * width;

      cursor += 12;
      result.memory += elements * 24;
      requireBytes(size, propertyEnd);

      if (encoding > 1 || expanded > 64 * 1024 * 1024 || result.memory > VIEWER_MEMORY / 2
        || (encoding === 0 && size !== expanded)) {
        throw new Error('Слишком большой или повреждённый массив FBX.');
      }
      if (encoding === 1) {
        result.compressed.push({ bytes: bytes.subarray(cursor, cursor + size), length: expanded });
      }

      cursor += size;
    }
    
    if (cursor !== propertyEnd) {
      throw new Error('Неверная длина properties FBX.');
    }
    if (cursor < end) {
      stack.push(end);
    }
  }
  
  if (!nodes || stack.length) {
    throw new Error('FBX обрезан.');
  }

  // Embedded media подменяет exporter filename. Остальные пути всё равно проходят URL modifier.
  // Предварительная проверка внешних схем применяется ко всем строкам, включая embedded filename.
  if (result.images.length) {
    result.references = [];
  } else {
    result.references = [...new Set(result.references)];

    for (const uri of result.references) {
      policy.resolve(uri);
    }
  }

  return result;
}

/**
 * Поток deflate проверяется без накопления распакованного массива.
 * Ложная длина compressed bomb отклоняется раньше неограниченного fflate в FBXLoader.
 */
export async function validateFbxCompression(inspection: FbxInspection, signal: AbortSignal): Promise<void> {
  for (const item of inspection.compressed) {
    const blob = new Blob([item.bytes as BlobPart]);
    const stream = blob.stream().pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    let length = 0;

    try {
      while (true) {
        signal.throwIfAborted();

        const chunk = await reader.read();

        if (chunk.done) {
          break;
        }

        length += chunk.value.length;

        if (length > item.length) {
          throw new Error('Распакованный массив FBX превышает заявленную длину.');
        }
      }
      
      if (length !== item.length) {
        throw new Error('Неверная распакованная длина FBX.');
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
