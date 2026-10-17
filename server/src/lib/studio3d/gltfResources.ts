import path from 'node:path';
import type { openVerified } from './safePath.ts';
import { StudioHttpError } from './assetErrors.ts';

type Opened = Awaited<ReturnType<typeof openVerified>>;

const NEIGHBORS = new Set(['.bin', '.png', '.jpg', '.jpeg', '.webp']);

/**
 * JSON не может заказывать сеть или decoder CDN. Разрешены bounded embedded data
 * и относительные соседи; KTX2/Draco требуют явного неподдержанного формата.
 */
export function validateGltf(value: unknown, standalone = false): void {
  const json = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const used = [...(Array.isArray(json.extensionsUsed) ? json.extensionsUsed : []),
    ...(Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [])];

  if (used.some((extension) => ['KHR_draco_mesh_compression',
    'KHR_texture_basisu'].includes(String(extension)))) {
    throw new StudioHttpError(415, 'unsupported_decoder',
      'Draco и KTX2 пока не поддержаны. Сохраните обычный GLB.');
  }

  for (const entry of [...(Array.isArray(json.buffers) ? json.buffers : []),
    ...(Array.isArray(json.images) ? json.images : [])]) {
    const uri = (entry as { uri?: unknown })?.uri;

    if (uri === undefined) {
      continue;
    }

    if (typeof uri !== 'string' || uri.length > 16 * 1024 * 1024) {
      throw new StudioHttpError(415, 'external_resources', 'Некорректный ресурс модели.');
    }

    if (/^data:(?:image\/(?:png|jpeg|webp)|application\/octet-stream);base64,[a-z0-9+/=]+$/i.test(uri)) {
      continue;
    }

    if (standalone) {
      throw new StudioHttpError(415, 'external_resources',
        'Сохраните самостоятельный GLB без внешних ресурсов.');
    }

    if (uri.includes('\\') || uri.includes('%') || uri.startsWith('/') || uri.includes(':')
      || uri.split('/').some((part) => !part || part === '.' || part === '..')
      || !NEIGHBORS.has(path.extname(uri).toLowerCase())) {
      throw new StudioHttpError(415, 'external_resources',
        'Модель ссылается на внешний или недоступный ресурс.');
    }
  }
}

/**
 * Читается только bounded JSON chunk GLB, весь бинарный файл остаётся в fd.
 * Заголовок и длины подтверждаются до выделения памяти и выдачи token/upload.
 */
export async function validateGlbResources(opened: Opened, standalone = false): Promise<void> {
  const header = Buffer.alloc(20);

  await opened.handle.read(header, 0, header.length, 0);

  const length = header.readUInt32LE(12);

  if (opened.size < 20 || header.toString('ascii', 0, 4) !== 'glTF' || header.readUInt32LE(4) !== 2
    || header.readUInt32LE(8) !== opened.size || header.readUInt32LE(16) !== 0x4e4f534a
    || length < 4 || length > 16 * 1024 * 1024 || length % 4 || 20 + length > opened.size) {
    throw new StudioHttpError(415, 'invalid_model', 'Неверный контейнер GLB.');
  }

  const bytes = Buffer.alloc(length);
  const read = await opened.handle.read(bytes, 0, length, 20);

  if (read.bytesRead !== length) {
    throw new StudioHttpError(415, 'invalid_model', 'JSON модели обрезан.');
  }

  let document: unknown;

  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new StudioHttpError(415, 'invalid_model', 'JSON модели повреждён.');
  }

  validateGltf(document, standalone);
  await opened.verify();
}

