export const MODEL_BYTES = 150 * 1024 * 1024;
export const IMAGE_BYTES = 20 * 1024 * 1024;
export const VIEWER_MEMORY = 1024 * 1024 * 1024;

/**
 * URI декодируется ровно один раз, до построения URL и нормализации dot segments.
 * Закодированный separator или вложенное кодирование не обходят папку токена.
 */
function safeParts(raw: string): string[] {
  if (!raw || /[\\\x00-\x1f?#]/.test(raw)) {
    throw new Error('Недопустимый путь ресурса модели.');
  }
  
  return raw.split('/').map((part) => {
    let decoded;
    
    try {
      decoded = decodeURIComponent(part);
    }
    catch {
      throw new Error('Некорректное кодирование ресурса модели.');
    }
    
    if (!decoded || ['.', '..'].includes(decoded) || /[%/:\\\x00-\x1f]/.test(decoded)) {
      throw new Error('Ресурс выходит из папки модели.');
    }
    
    return encodeURIComponent(decoded);
  });
}

/**
 * Встраиваемые URI ограничены безопасными image/buffer MIME и размером до decode.
 * SVG, HTML и адреса иной схемы не становятся запросом или активным содержимым.
 */
export function dataResource(uri: string): { mime: string; bytes: Uint8Array } {
  const pattern = '^data:(image/(?:png|jpeg|webp)|application/(?:octet-stream|gltf-buffer));base64,'
    + '([A-Za-z0-9+/]*={0,2})$';
  const match = new RegExp(pattern).exec(uri);
  
  if (!match || match[2]!.length % 4 !== 0) {
    throw new Error('Недопустимый data URI модели.');
  }
  
  const limit = match[1]!.startsWith('image/') ? IMAGE_BYTES : MODEL_BYTES;
  
  if (match[2]!.length * 3 / 4 > limit + 2) {
    throw new Error('Встроенный ресурс слишком большой.');
  }
  
  const decoded = atob(match[2]!);
  
  return { mime: match[1]!, bytes: Uint8Array.from(decoded, (character) => character.charCodeAt(0)) };
}

/**
 * Источник и все соседи принадлежат одной папке scoped токена либо одной версии библиотеки.
 * Проверка происходит до fetch; Blob принимается только после явной регистрации владельцем.
 */
export function createResourcePolicy(source: string, origin = globalThis.location?.origin ||
  'http://localhost') {
  if (!source || source.startsWith('//') || source.includes('\\')) {
    throw new Error('Недопустимый источник модели.');
  }
  
  const base = new URL(origin);
  const sourceUrl = new URL(source, base);
  
  if (sourceUrl.origin !== base.origin || sourceUrl.search || sourceUrl.hash
    || !sourceUrl.pathname.startsWith('/api/studio3d/')) {
      throw new Error('Модель вне собственного API.');
    }
  
  const rawPath = source.replace(/^https?:\/\/[^/]+/i, '').replace(/^\//, '');
  const normalized = '/' + safeParts(rawPath).join('/');
  const token = /^\/api\/studio3d\/viewer\/file\/[a-f0-9]{48}\/[^/]+$/i;
  const library = /^\/api\/studio3d\/files\/[^/]+\/[^/]+\/[^/]+$/;
  
  if ((!token.test(normalized) && !library.test(normalized)) || normalized !== sourceUrl.pathname) {
    throw new Error('Недопустимый адрес файла модели.');
  }
  
  const directory = normalized.slice(0, normalized.lastIndexOf('/') + 1);
  const blobs = new Set<string>();
  const replacements = new Map<string, string>();
  const registerBlob = (url: string) => {
    blobs.add(url);
    
    return url;
  };
  /**
   * Ресурс разрешается только внутри папки источника или среди Blob текущего разбора.
   * Недоверенная схема и traversal отклоняются до сетевого запроса загрузчика.
   */
  const resolve = (uri: string): string => {
    if (uri.startsWith('blob:')) {
      if (!blobs.has(uri)) {
        throw new Error('Чужой Blob URL модели.');
      }
      
      return uri;
    }
    if (uri.startsWith('data:')) {
      dataResource(uri);
      
      return replacements.get(uri) || uri;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(uri) || uri.startsWith('//')) {
      throw new Error('Внешние ресурсы модели запрещены. Сохраните самостоятельный GLB.');
    }
    
    let relative = uri;
    
    if (uri.startsWith('/')) {
      if (!uri.startsWith(directory)) {
        throw new Error('Ресурс из чужой папки API.');
      }
      
      relative = uri.slice(directory.length);
    }
    
    const path = directory + safeParts(relative).join('/');
    
    if (!/\.(?:bin|png|jpe?g|webp|glb|gltf|fbx|obj|stl|splat)$/i.test(path)) {
      throw new Error('Ресурс этого формата не поддержан (KTX2/Draco требуют другого декодера).');
    }
    
    return replacements.get(path) || path;
  };
  
  return {
    source: normalized,
    directory,
    resolve,
    registerBlob,
    replace: (uri: string, blob: string) => {
      replacements.set(resolve(uri), registerBlob(blob));
    },
    dispose: () => {
      for (const blob of blobs) {
        URL.revokeObjectURL(blob);
      }

      blobs.clear();
      replacements.clear();
    },
  };
}

export type ResourcePolicy = ReturnType<typeof createResourcePolicy>;

/**
 * Размер Content-Length не является доказательством: поток ограничивается по реально прочитанным байтам.
 * Abort отменяет чтение и reader закрывается даже при превышении или ошибке progress consumer.
 */
export async function fetchModelBytes(url: string, signal: AbortSignal, limit = MODEL_BYTES,
  progress?: (loaded: number, total: number | null) => void): Promise<Uint8Array> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    signal,
    redirect: 'error'
  });
  
  if (!response.ok) {
    throw new Error(`Файл модели: HTTP ${response.status}`);
  }
  
  const declared = Number(response.headers.get('Content-Length'));
  const total = declared > 0 && Number.isFinite(declared) ? declared : null;
  
  if (total && total > limit) {
    throw new Error('Файл превышает допустимый размер просмотра.');
  }
  
  const reader = response.body?.getReader();
  
  if (!reader) {
    throw new Error('Поток файла модели отсутствует.');
  }
  
  const chunks: Uint8Array[] = [];
  let length = 0;
  
  try {
    while (true) {
      const piece = await reader.read();
      
      if (piece.done) {
        break;
      }
      
      length += piece.value.byteLength;
      
      if (length > limit || chunks.length >= 65536) {
        throw new Error('Файл превышает допустимый размер просмотра.');
      }
      
      chunks.push(piece.value);
      progress?.(length, total);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  
  if (total !== null && total !== length) {
    throw new Error('Файл скачан не полностью.');
  }
  
  const bytes = new Uint8Array(length);
  let offset = 0;
  
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  
  return bytes;
}
