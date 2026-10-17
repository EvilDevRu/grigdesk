// Файлы проверяются по контейнеру и фактическому декодированию. Изображения не
// проходят по одному заголовку, decode работает с закреплённым fd без сетевых protocols.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { inspectGlbFile } from './analysisProcess.ts';
import { openVerified } from './safePath.ts';
import { StudioHttpError } from './assetErrors.ts';
import { validateGlbResources } from './gltfResources.ts';
import { inspectBinaryFbx } from './fbxContainer.ts';
import { inspectRecords, inspectTextModel } from './modelContainers.ts';

export const MODEL_EXT = new Set(['.glb', '.fbx', '.obj', '.stl', '.splat']);
export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
export const MODEL_LIMIT = 150 * 1024 * 1024;
export const IMAGE_LIMIT = 20 * 1024 * 1024;

/**
 * Декодер не может читать URL: ему доступны file/pipe и переданный fd.
 * Таймер и RSS watchdog завершают только собственный процесс, stdout ограничен.
 */
async function decode(command: string, args: string[], fd: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe', fd] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill('SIGKILL');
    }, 10_000);
    const rss = setInterval(async () => {
      const status = await fs.readFile(`/proc/${child.pid}/status`, 'utf8').catch(() => '');
      const kilobytes = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);

      if (kilobytes > 512 * 1024) {
        failed = true;
        child.kill('SIGKILL');
      }
    }, 100);

    const abort = () => {
      failed = true;
      child.kill('SIGKILL');
    };

    signal?.addEventListener('abort', abort, { once: true });

    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (size > 128 * 1024) {
        failed = true;
        child.kill('SIGKILL');
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr!.resume();
    child.on('error', () => {
      clearTimeout(timer);
      clearInterval(rss);
      signal?.removeEventListener('abort', abort);
      reject(new StudioHttpError(415, 'image_decode_failed', 'Не удалось декодировать изображение.'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(rss);
      signal?.removeEventListener('abort', abort);

      if (code !== 0 || failed) {
        reject(new StudioHttpError(415, 'image_decode_failed',
          'Изображение повреждено или слишком сложное.'));
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
  });
}

/**
 * Формат результата определяется по байтам, потому что CDN может неверно назвать файл.
 * Для загрузок объявленный MIME и расширение дополнительно должны совпасть с байтами.
 * Полное декодирование доказывает наличие пикселей и завершённость контейнера.
 */
export async function inspectImage(root: string, file: string, mime?: string, signal?: AbortSignal) {
  signal?.throwIfAborted();

  const ext = path.extname(file).toLowerCase();
  const expected = IMAGE_MIME[ext];
  const opened = await openVerified(root, file);

  try {
    if (!expected || (mime && mime !== expected)) {
      throw new StudioHttpError(415, 'unsupported_type', 'Нужна PNG, JPEG или WebP картинка.');
    }

    if (opened.size > IMAGE_LIMIT) {
      throw new StudioHttpError(413, 'too_large', 'Картинка должна быть до 20 МиБ.');
    }

    const head = Buffer.alloc(32);

    await opened.handle.read(head, 0, head.length, 0);

    const extension = head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? '.png'
      : head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP' ? '.webp'
        : head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? '.jpg' : null;

    if (!extension || (mime && mime !== IMAGE_MIME[extension])) {
      throw new StudioHttpError(415, 'unsupported_type', 'Сигнатура изображения не совпадает с форматом.');
    }

    const metadata = JSON.parse(await decode('ffprobe', [
      '-v', 'error', '-protocol_whitelist', 'file,pipe', '-max_alloc', '268435456',
      '-show_entries', 'stream=width,height', '-of', 'json', '/proc/self/fd/3',
    ], opened.handle.fd, signal)) as { streams?: { width?: number; height?: number }[] };
    const width = metadata.streams?.[0]?.width ?? 0;
    const height = metadata.streams?.[0]?.height ?? 0;

    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new StudioHttpError(415, 'image_decode_failed', 'Изображение не содержит пикселей.');
    }

    if (width * height > 64_000_000) {
      throw new StudioHttpError(413, 'too_large', 'Картинка должна быть до 64 мегапикселей.');
    }

    const decoded = await decode('ffmpeg', [
      '-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-threads', '1',
      '-max_alloc', '268435456', '-err_detect', 'explode', '-i', '/proc/self/fd/3',
      '-frames:v', '1', '-f', 'framemd5', 'pipe:1',
    ], opened.handle.fd, signal);

    if (!/^\d+,\s+\d+,/m.test(decoded)) {
      throw new StudioHttpError(415, 'image_decode_failed', 'Изображение не декодируется.');
    }

    await opened.verify();

    return {
      width,
      height,
      extension
    };
  } finally {
    await opened.handle.close();
  }
}

/**
 * Самостоятельные контейнеры ограничены 150 МиБ; GLTF с соседями остаётся viewer-only.
 * GLB использует общий process budget, бинарные STL/FBX проверяют размеры структуры.
 */
export async function inspectModel(root: string, file: string, signal?: AbortSignal) {
  const ext = path.extname(file).toLowerCase();

  if (!MODEL_EXT.has(ext)) {
    throw new StudioHttpError(415, 'unsupported_type',
      'Нужен GLB, FBX, OBJ, STL или splat. GLTF сохраните как GLB.');
  }

  const opened = await openVerified(root, file);
  const header = Buffer.alloc(128);

  try {
    if (opened.size > MODEL_LIMIT) {
      throw new StudioHttpError(413, 'too_large', 'Модель должна быть до 150 МиБ.');
    }

    await opened.handle.read(header, 0, header.length, 0);

    if (ext === '.glb') {
      if (header.toString('ascii', 0, 4) !== 'glTF') {
        throw new StudioHttpError(415, 'invalid_model', 'Повреждён GLB.');
      }

      await validateGlbResources(opened, true);
    } else if (ext === '.stl') {
      const triangles = header.readUInt32LE(80);

      if (opened.size === 84 + triangles * 50 && triangles > 0) {
        await inspectRecords(opened.handle, opened.size, 84, 50, 48);
        await opened.verify();

        return null;
      }
    } else if (ext === '.fbx') {
      const binary = header.toString('ascii', 0, 23) === 'Kaydara FBX Binary  \x00\x1a\x00';
      const version = binary ? header.readUInt32LE(23) : 0;

      if (binary && version >= 7000 && version <= 8000 && opened.size > 64) {
        await inspectBinaryFbx(opened.handle, opened.size, version);
        await opened.verify();

        return null;
      }

      if (binary) {
        throw new StudioHttpError(415, 'invalid_model', 'Неверный контейнер FBX.');
      }
    } else if (ext === '.splat') {
      if (!opened.size || opened.size % 32 !== 0) {
        throw new StudioHttpError(415, 'invalid_model', 'Неверный контейнер splat.');
      }

      await inspectRecords(opened.handle, opened.size, 0, 32, 24);
      await opened.verify();

      return null;
    }

    await opened.verify();
  } finally {
    await opened.handle.close();
  }

  if (ext === '.glb') {
    return inspectGlbFile(file, { root, signal });
  }

  await inspectTextModel(root, file, ext);

  return null;
}
