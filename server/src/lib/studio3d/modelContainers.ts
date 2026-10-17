// Текстовые контейнеры и fixed records проверяются потоком с пределами.
// Float/индексы каждого элемента проверяются до предоставления файла исполнителю/GPU.
import type { FileHandle } from 'node:fs/promises';
import { openVerified } from './safePath.ts';
import { StudioHttpError } from './assetErrors.ts';

/**
 * Binary STL/splat читаются блоками, проверка касается каждой записи файла.
 * Non-finite значения не доходят до GPU в последнем треугольнике или point.
 */
export async function inspectRecords(handle: FileHandle,
  size: number, start: number, stride: number, floatBytes: number): Promise<void> {
  const block = Math.floor(65536 / stride) * stride;

  for (let position = start; position < size; position += block) {
    const length = Math.min(block, size - position);
    const bytes = Buffer.alloc(length);
    const result = await handle.read(bytes, 0, length, position);

    if (result.bytesRead !== length || length % stride) {
      throw new StudioHttpError(415, 'invalid_model', 'Модель обрезана.');
    }

    for (let record = 0; record < length; record += stride) {
      for (let offset = 0; offset < floatBytes; offset += 4) {
        if (!Number.isFinite(bytes.readFloatLE(record + offset))) {
          throw new StudioHttpError(415, 'invalid_model', 'Неверные координаты модели.');
        }
      }
    }
  }
}

/**
 * Последняя строка без newline не теряется; OBJ references проверяются целиком.
 * ASCII FBX проверяет depth/version, STL требует три вершины на каждую грань.
 */
export async function inspectTextModel(root: string, file: string, ext: string): Promise<void> {
  const opened = await openVerified(root, file);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const deadline = Date.now() + 20_000;
  let tail = '';
  let vertices = 0;
  let faces = 0;
  let normals = 0;
  let uvs = 0;
  let facetVertices = 0;
  let facet = false;
  let depth = 0;
  let fbxVersion = 0;
  let fbxObjects = 0;
  const references = {
    vertices: 0,
    normals: 0,
    uvs: 0
  };
  const assets: {
    id: string;
    kind: string;
    depth: number;
    file: boolean;
    embedded: boolean
  }[] = [];
  const connections: [string, string][] = [];
  let currentAsset: typeof assets[number] | undefined;

  /**
   * Строка не заказывает чтение материалов, иных путей или сети.
   * Геометрия и структура проверяются до публикации standalone файла.
   */
  const lineOf = (raw: string) => {
    const line = raw.trim();

    if (!line || line.startsWith('#') || line.startsWith(';')) {
      return;
    }

    if (ext === '.fbx') {
      const version = /^FBXVersion:\s*(\d+)/.exec(line);
      const asset = /^(Video|Texture):\s*(\d+)/.exec(line);
      const link = /^C:\s*"OO",\s*(\d+),\s*(\d+)/.exec(line);

      if (version) {
        fbxVersion = Number(version[1]);
      }
      if (/^(Geometry|Model):/.test(line)) {
        fbxObjects += 1;
      }
      if (asset) {
        currentAsset = {
          id: asset[2]!,
          kind: asset[1]!,
          depth: depth + 1,
          file: false,
          embedded: false
        };
        assets.push(currentAsset);
      }
      if (link) {
        connections.push([link[1]!, link[2]!]);
      }
      if (currentAsset && /^(?:RelativeFilename|FileName|Filename):\s*"[^"\s]/.test(line)) {
        currentAsset.file = true;
      }
      if (currentAsset && /^Content:\s*[^;]*"[a-z0-9+/=]+"/i.test(line)) {
        currentAsset.embedded = true;
      }

      const structural = line.replace(/"(?:[^"\\]|\\.)*"/g, '""').split(';')[0]!;

      for (const character of structural) {
        if (character === '{') {
          depth += 1;
        }
        if (character === '}') {
          depth -= 1;
        }
        if (depth < 0 || depth > 256) {
          throw new StudioHttpError(415, 'invalid_model', 'Неверные скобки FBX.');
        }
      }

      if (currentAsset && depth < currentAsset.depth) {
        currentAsset = undefined;
      }

      const numbers = /\ba:\s*([^}]+)/.exec(structural)?.[1];

      if (numbers && numbers.split(',').some((value) => !value.trim() || !Number.isFinite(Number(value)))) {
        throw new StudioHttpError(415, 'invalid_model', 'Неверный массив FBX.');
      }

      return;
    }

    if (/^mtllib\s/i.test(line)) {
      throw new StudioHttpError(415, 'external_resources',
        'Сохраните самостоятельный GLB без внешних ресурсов.');
    }

    const vertex = ext === '.obj' ? /^v\s/.test(line) : /^vertex\s/.test(line);
    const vector = vertex || (ext === '.obj' && /^vn\s/.test(line));

    if (vector || (ext === '.obj' && /^vt\s/.test(line))) {
      const numbers = line.split(/\s+/).slice(1).map(Number);
      const minimum = vector ? 3 : 1;
      const maximum = vector ? 4 : 3;

      if (numbers.length < minimum || numbers.length > maximum ||
        numbers.some((value) => !Number.isFinite(value))) {
        throw new StudioHttpError(415, 'invalid_model', 'Неверные координаты модели.');
      }

      if (vertex) {
        vertices += 1;
        facetVertices += 1;
      }
      else if (/^vn\s/.test(line)) {
        normals += 1;
      }
      else {
        uvs += 1;
      }
    }

    if (ext === '.obj' && /^f\s/.test(line)) {
      const entries = line.split(/\s+/).slice(1);

      if (entries.length < 3 || entries.length > 4096) {
        throw new StudioHttpError(415, 'invalid_model', 'Неверная грань OBJ.');
      }

      for (const entry of entries) {
        const parts = entry.split('/');

        if (parts.length > 3) {
          throw new StudioHttpError(415, 'invalid_model', 'Неверный индекс OBJ.');
        }

        for (let index = 0; index < parts.length; index += 1) {
          const part = parts[index]!;

          if (!part && index > 0) {
            continue;
          }
          if (!/^-?\d+$/.test(part) || !Number.isSafeInteger(Number(part)) || Number(part) === 0) {
            throw new StudioHttpError(415, 'invalid_model', 'Неверный индекс OBJ.');
          }

          const key = (['vertices', 'uvs', 'normals'] as const)[index]!;
          const count = key === 'vertices' ? vertices : key === 'uvs' ? uvs : normals;
          const value = Number(part);

          if (value < 0 && -value > count) {
            throw new StudioHttpError(415, 'invalid_model', 'Индекс вне OBJ.');
          }
          
          references[key] = Math.max(references[key], value);
        }
      }

      faces += 1;
    }

    if (ext === '.stl') {
      if (/^facet\s+normal\s/.test(line)) {
        if (facet || line.split(/\s+/).slice(2).length !== 3
          || line.split(/\s+/).slice(2).some((value) => !Number.isFinite(Number(value)))) {
          throw new StudioHttpError(415, 'invalid_model', 'Неверная грань STL.');
        }

        facet = true;
        facetVertices = 0;
      }
      if (/^endfacet\b/.test(line)) {
        if (!facet || facetVertices !== 3) {
          throw new StudioHttpError(415, 'invalid_model',
          'Неверная грань STL.');
        }
        
        facet = false;
        faces += 1;
      }
    }
  };

  try {
    if (opened.size > 150 * 1024 * 1024) {
      throw new StudioHttpError(413, 'too_large',
      'Модель слишком большая.');
    }

    for (let position = 0; position < opened.size;) {
      if (Date.now() > deadline) {
        throw new StudioHttpError(415, 'invalid_model', 'Модель слишком сложная.');
      }

      const bytes = Buffer.alloc(Math.min(65536, opened.size - position));
      const read = await opened.handle.read(bytes, 0, bytes.length, position);

      if (!read.bytesRead) {
        throw new StudioHttpError(415, 'invalid_model', 'Модель обрезана.');
      }

      position += read.bytesRead;
      tail += decoder.decode(bytes.subarray(0, read.bytesRead), { stream: true });

      if (tail.length > 1024 * 1024 || tail.includes('\0')) {
        throw new StudioHttpError(415, 'invalid_model', 'Строка модели слишком длинная или повреждена.');
      }

      const lines = tail.split(/\r?\n/);

      tail = lines.pop() ?? '';
      
      for (const raw of lines) {
        lineOf(raw);
      }
    }

    lineOf(tail + decoder.decode());
    await opened.verify();

    if (ext === '.fbx') {
      if (fbxVersion < 7000 || fbxVersion > 8000 || !fbxObjects || depth !== 0) {
        throw new StudioHttpError(415, 'invalid_model', 'Неверный контейнер FBX.');
      }

      const embeddedIds = new Set(assets.filter((asset) => asset.embedded).map((asset) => asset.id));
      const linked = new Set(connections.filter(([child]) => embeddedIds.has(child)).map(([,
        parent]) => parent));

      for (const asset of assets) {
        const embedded = asset.embedded || (asset.kind === 'Texture' && linked.has(asset.id));

        if (asset.file && !embedded) {
          throw new StudioHttpError(415, 'external_resources',
            'Сохраните FBX с встроенными текстурами или GLB.');
        }
      }

      return;
    }

    if (vertices < 3 || faces < 1 || facet || references.vertices > vertices
      || references.normals > normals || references.uvs > uvs) {
      throw new StudioHttpError(415, 'invalid_model', 'В модели нет корректной геометрии.');
    }
  } finally {
    await opened.handle.close();
  }
}
