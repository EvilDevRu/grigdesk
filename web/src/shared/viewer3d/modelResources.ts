import { dataResource, fetchModelBytes, IMAGE_BYTES, MODEL_BYTES, VIEWER_MEMORY } from './resourcePolicy.ts';
import type { ResourcePolicy } from './resourcePolicy.ts';
import { inspectFbx, validateFbxCompression } from './fbxResources.ts';
import type { FbxInspection } from './fbxResources.ts';

type JsonObject = Record<string, any>;

export interface ModelResources {
  json: JsonObject | null;
  binary: Uint8Array | null;
  references: { uri: string; image: boolean }[];
  embeddedImages: Uint8Array[];
  decodedMemory: number;
  fbx?: FbxInspection;
}

/**
 * Перед image decode читаются размеры из безопасного растрового заголовка.
 * Лимит 64 Мп предотвращает большую аллокацию bitmap, а не проверяет её уже после создания.
 */
export function checkImageDimensions(bytes: Uint8Array): number {
  if (bytes.byteLength > IMAGE_BYTES || bytes.byteLength < 16) {
    throw new Error('Изображение модели слишком большое или повреждено.');
  }
  
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  
  if (view.getUint32(0) === 0x89504e47 && bytes.byteLength >= 24) {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (view.getUint16(0) === 0xffd8) {
    let offset = 2;
    
    while (offset + 9 < bytes.byteLength && offset < 1024 * 1024) {
      if (bytes[offset++] !== 0xff) {
        throw new Error('Некорректный JPEG модели.');
      }
      
      while (bytes[offset] === 0xff) {
        offset += 1;
      }
      
      const marker = bytes[offset++]!;
      
      if (marker === 0xd9 || marker === 0xda) {
        break;
      }
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      
      const size = view.getUint16(offset);
      
      if (size < 2 || offset + size > bytes.byteLength) {
        throw new Error('Некорректный JPEG модели.');
      }
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      
      offset += size;
    }
  } else if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const tag = new TextDecoder().decode(bytes.subarray(12, 16));
    
    if (tag === 'VP8X' && bytes.length >= 30) {
      width = 1 + bytes[24]! + bytes[25]! * 256 + bytes[26]! * 65536;
      height = 1 + bytes[27]! + bytes[28]! * 256 + bytes[29]! * 65536;
    } else if (tag === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const packed = view.getUint32(21, true);
      
      width = 1 + (packed & 0x3fff); height = 1 + ((packed >>> 14) & 0x3fff);
    } else if (tag === 'VP8 ' && bytes.length >= 30) {
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
    }
  }
  if (!width || !height || width * height > 64_000_000) {
    throw new Error('Изображение модели превышает 64 Мп или имеет неподдержанный заголовок.');
  }

  return width * height * 8;
}

/**
 * Плоский список nodes тоже может содержать цикл или очень глубокую цепочку.
 * Итеративный обход проверяет DAG до рекурсивного создания Object3D загрузчиком.
 */
function validateNodes(nodes: JsonObject[]): void {
  const states = new Uint8Array(nodes.length);
  const heights = new Uint16Array(nodes.length);

  for (let start = 0; start < nodes.length; start += 1) {
    const stack = [{ id: start, next: 0 }];

    while (stack.length) {
      const frame = stack.at(-1)!;
      const node = nodes[frame.id];

      if (!node || !Array.isArray(node.children || [])) {
        throw new Error('Некорректный узел модели.');
      }
      if (states[frame.id] === 2) {
        stack.pop();
        continue;
      }

      states[frame.id] = 1;

      const children: number[] = node.children || [];

      if (frame.next < children.length) {
        const child = children[frame.next++]!;

        if (!Number.isSafeInteger(child) || child < 0 || child >= nodes.length) {
          throw new Error('Некорректная ссылка узла модели.');
        }
        if (states[child] === 1) {
          throw new Error('Цикл узлов модели.');
        }
        if (stack.length >= 256 || heights[child]! + stack.length > 256) {
          throw new Error('Глубина модели превышает 256.');
        }

        stack.push({ id: child, next: 0 });
      } else {
        let height = 1;

        for (const child of children) {
          height = Math.max(height, heights[child]! + 1);
        }

        heights[frame.id] = height;
        states[frame.id] = 2;
        stack.pop();
      }
    }
  }
}

/**
 * JSON имеет предел глубины/объёма и accessor memory до загрузчика Three.
 * Все объявленные URI проверяются заранее, даже если расширение не используется сценой.
 */
function inspectGltf(json: JsonObject, binary: Uint8Array | null, policy: ResourcePolicy): ModelResources {
  if (typeof json.asset?.version !== 'string' || !json.asset.version.startsWith('2.')) {
    throw new Error('Поддерживается только glTF2.');
  }
  
  const stack = [{ value: json, depth: 0 }];
  let count = 0;
  
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    
    if (depth > 256 || ++count > 100_000) {
      throw new Error('Слишком сложный JSON модели.');
    }
    if (!value || typeof value !== 'object') {
      continue;
    }
    
    for (const [key, child] of Object.entries(value)) {
      if (key === 'KHR_draco_mesh_compression' || key === 'KHR_texture_basisu') {
        throw new Error('Draco и KTX2 не поддержаны. Сохраните GLB без этих расширений.');
      }
      if (key === 'uri' && typeof child === 'string') {
        policy.resolve(child);
      }
      
      stack.push({ value: child as JsonObject, depth: depth + 1 });
    }
  }
  for (const name of [...json.extensionsUsed || [], ...json.extensionsRequired || []]) {
    if (['KHR_draco_mesh_compression', 'KHR_texture_basisu'].includes(name)) {
      throw new Error('Draco и KTX2 не поддержаны.');
    }
  }
  
  if ((json.nodes?.length || 0) > 100_000) {
    throw new Error('Слишком много узлов модели.');
  }

  validateNodes(json.nodes || []);
  
  let decoded = 0;
  const sizes: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16
  };
  
  for (const accessor of json.accessors || []) {
    if (!Number.isSafeInteger(accessor.count) || accessor.count < 0 || accessor.count > 16_000_000
      || !sizes[accessor.type]) {
        throw new Error('Некорректный accessor модели.');
      }
    
    decoded += accessor.count * sizes[accessor.type]! * 8;
    
    if (decoded > VIEWER_MEMORY / 2) {
      throw new Error('Слишком большой объём геометрии модели.');
    }
  }
  for (const item of json.bufferViews || []) {
    const meshopt = item.extensions?.EXT_meshopt_compression;
    
    if (meshopt && (!Number.isSafeInteger(meshopt.count) || !Number.isSafeInteger(meshopt.byteStride)
      || meshopt.count < 0 || meshopt.byteStride < 1 || meshopt.byteStride > 256
      || meshopt.count * meshopt.byteStride > MODEL_BYTES)) {
        throw new Error('Слишком большой meshopt buffer.');
      }
  }
  
  const references = [...(json.buffers || []).filter((item: JsonObject) => item.uri)
    .map((item: JsonObject) => ({ uri: item.uri as string, image: false })),
  ...(json.images || []).filter((item: JsonObject) => item.uri)
    .map((item: JsonObject) => ({ uri: item.uri as string, image: true }))];
  
  if (references.length > 256) {
    throw new Error('Слишком много внешних ресурсов модели.');
  }
  
  const embeddedImages: Uint8Array[] = [];
  
  for (const image of json.images || []) {
    if (image.uri?.startsWith('data:')) {
      decoded += checkImageDimensions(dataResource(image.uri).bytes);
    }
    if (image.bufferView !== undefined && binary) {
      const buffer = json.bufferViews?.[image.bufferView];
      
      if (!buffer || buffer.buffer !== 0 || buffer.byteLength > IMAGE_BYTES
        || (buffer.byteOffset || 0) + buffer.byteLength > binary.length) {
          throw new Error('Некорректная встроенная картинка.');
        }
      
      const imageBytes = binary.subarray(buffer.byteOffset || 0, (buffer.byteOffset ||
        0) + buffer.byteLength);
      
      decoded += checkImageDimensions(imageBytes);
      embeddedImages.push(imageBytes);
    }
  }
  
  return {
    json,
    binary,
    references,
    embeddedImages,
    decodedMemory: decoded
  };
}

/**
 * Заголовок GLB и длина JSON проверяются до TextDecoder/JSON.parse.
 * Node parse и браузер используют одинаковый входной предел без создания renderer.
 */
export function modelResources(bytes: Uint8Array, ext: string, policy: ResourcePolicy): ModelResources {
  if (bytes.byteLength > MODEL_BYTES) {
    throw new Error('Модель превышает 150 МиБ.');
  }
  
  let json: JsonObject | null = null;
  let binary: Uint8Array | null = null;
  
  if (ext === 'glb') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    
    if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
      || view.getUint32(8, true) !== bytes.length || view.getUint32(16, true) !== 0x4e4f534a) {
        throw new Error('Повреждённый GLB.');
      }
    
    const length = view.getUint32(12, true);
    
    if (length > 16 * 1024 * 1024 || 20 + length > bytes.length) {
      throw new Error('Слишком большой или повреждённый JSON GLB.');
    }
    
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, 20 + length)));
    
    if (20 + length + 8 <= bytes.length) {
      const binLength = view.getUint32(20 + length, true);
      
      if (view.getUint32(24 + length, true) !== 0x004e4942 || 28 + length + binLength !== bytes.length) {
        throw new Error('Повреждённый бинарный чанк GLB.');
      }
      
      binary = bytes.subarray(28 + length);
    }
  } else if (ext === 'gltf') {
    if (bytes.length > 16 * 1024 * 1024) {
      throw new Error('Слишком большой JSON glTF.');
    }
    
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  if (json) {
    return inspectGltf(json, binary, policy);
  }
  if (ext === 'fbx') {
    const fbx = inspectFbx(bytes, policy);
    let decodedMemory = fbx.memory;

    for (const image of fbx.images) {
      decodedMemory += checkImageDimensions(image);
    }

    return {
      json: null,
      binary: null,
      references: fbx.references.map((uri) => ({ uri, image: true })),
      embeddedImages: fbx.images,
      decodedMemory,
      fbx,
    };
  }
  
  return {
    json: null,
    binary: null,
    references: [],
    embeddedImages: [],
    decodedMemory: ext === 'splat' ? Math.floor(bytes.length / 32) * 64 : bytes.length * 8,
  };
}

/**
 * Соседние glTF buffers/images скачиваются с лимитом до вызова addon загрузчика.
 * LoadingManager затем видит только зарегистрированные Blob и не делает второй HTTP запрос.
 */
export async function prepareResources(resources: ModelResources, policy: ResourcePolicy,
  signal: AbortSignal, reserve: (memory: number) => void = () => {}): Promise<number> {
  let total = 0;
  const seen = new Set<string>();

  if (resources.fbx) {
    await validateFbxCompression(resources.fbx, signal);
  }
  
  for (const item of resources.references) {
    if (seen.has(item.uri)) {
      continue;
    }
    
    seen.add(item.uri);
    
    const resolved = policy.resolve(item.uri);
    const progress = (loaded: number) => reserve((total + loaded) * 2 + resources.decodedMemory);
    const data = item.uri.startsWith('data:') ? dataResource(item.uri) : {
      bytes: await fetchModelBytes(resolved, signal, item.image ? IMAGE_BYTES : MODEL_BYTES, progress),
      mime: '',
    };
    
    total += data.bytes.byteLength;
    
    if (total > VIEWER_MEMORY / 2) {
      throw new Error('Слишком большой общий объём соседей модели.');
    }
    if (item.image) {
      resources.decodedMemory += checkImageDimensions(data.bytes);
    }

    reserve(total * 2 + resources.decodedMemory);
    
    const mime = data.mime || (item.image ? (/\.webp$/i.test(item.uri) ? 'image/webp'
      : /\.jpe?g$/i.test(item.uri) ? 'image/jpeg' : 'image/png') : 'application/octet-stream');
    const blob = URL.createObjectURL(new Blob([data.bytes as BlobPart], { type: mime }));
    
    policy.replace(item.uri, blob);
  }
  
  return total;
}
