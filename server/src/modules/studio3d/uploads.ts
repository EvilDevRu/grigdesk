// Multipart записывается потоком в собственную UUID-папку с закреплённым parent.
// Недопустимый файл и отказ допуска не оставляют опубликованного upload.
import { randomUUID } from 'node:crypto';
import { constants, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';

import { parseStudio3d } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { StudioLibrary } from '../../lib/studio3d/library.ts';
import { ensureDirectory, pinDirectory, verifiedHash } from '../../lib/studio3d/safePath.ts';
import { inspectImage, inspectModel, IMAGE_LIMIT, IMAGE_MIME, MODEL_EXT, MODEL_LIMIT } from './formats.ts';
import { StudioHttpError } from './errors.ts';

/**
 * Сначала читается libraryId, затем появляется файл; stale запрос ничего не пишет.
 * Размер ограничен во время чтения, декодер проверяет готовый файл до manifest.
 */
export async function receiveUpload(request: FastifyRequest, library: StudioLibrary,
  check: (libraryId: string) => void) {
  const uploadId = randomUUID();
  const folder = path.join(library.uploadsDir(), uploadId);
  let libraryId: string | null = null;
  let uploaded: ReturnType<typeof parseStudio3d.upload> | null = null;
  let pinned: Awaited<ReturnType<typeof pinDirectory>> | null = null;
  let published = false;

  try {
    for await (const part of request.parts({
      limits: {
        fileSize: MODEL_LIMIT,
        files: 1,
        fields: 1,
        parts: 2,
        fieldSize: 128
      },
    })) {
      if (part.type === 'field') {
        if (part.fieldname !== 'libraryId' || libraryId !== null || typeof part.value !== 'string') {
          throw new StudioHttpError(400, 'invalid_request', 'Передайте libraryId и один файл.');
        }

        libraryId = part.value;
        check(libraryId);

        continue;
      }

      if (!libraryId || uploaded || part.fieldname !== 'file') {
        throw new StudioHttpError(400, 'invalid_request', 'Сначала передайте libraryId, затем один файл.');
      }

      check(libraryId);

      const ext = path.extname(part.filename).toLowerCase();
      const image = Object.hasOwn(IMAGE_MIME, ext);

      if ((!image && !MODEL_EXT.has(ext)) || part.filename.length > 256) {
        throw new StudioHttpError(415, 'unsupported_type', 'Нужна картинка или самостоятельная 3D-модель.');
      }

      const name = `input${ext}`;
      const limit = image ? IMAGE_LIMIT : MODEL_LIMIT;

      await ensureDirectory(library.dir, folder);
      pinned = await pinDirectory(library.dir, folder);

      const handle = await fs.open(pinned.child(name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const destination = createWriteStream(pinned.child(name), { fd: handle, autoClose: false });
      let size = 0;

      try {
        const bounded = new Transform({
        /**
         * Каждый chunk повторяет допуск и учитывается до записи на диск.
         * Потоковый предел прекращает upload с типизированным отказом.
         */
        transform(bytes: Buffer, _encoding, done) {
            size += bytes.length;

            try {
              check(libraryId!);

              if (size > limit) {
                throw new StudioHttpError(413, 'too_large', 'Файл превышает допустимый размер.');
              }

              done(null, bytes);
            } catch (error) {
              done(error as Error);
            }
          },
        });

        await pipeline(part.file, bounded, destination);

        if (part.file.truncated) {
          throw new StudioHttpError(413, 'too_large', 'Файл превышает допустимый размер.');
        }

        await handle.sync();
      } finally {
        destination.destroy();
        await handle.close();
      }

      const file = path.join(folder, name);
      const dimensions = image ? await inspectImage(library.dir, file, part.mimetype) : null;
      const stats = image ? null : await inspectModel(library.dir, file);
      const verified = await verifiedHash(library.dir, file);

      check(libraryId);
      await pinned.verify();

      uploaded = parseStudio3d.upload({
        libraryId: library.libraryId,
        uploadId,
        name,
        kind: image ? 'image' : 'model',
        size: verified.size,
        stats,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null
      });
    }

    if (!uploaded || !libraryId) {
      throw new StudioHttpError(400, 'invalid_request', 'Передайте один файл.');
    }

    check(libraryId);
    await library.persist(path.join(folder, 'upload.json'), uploaded, false);
    published = true;

    return uploaded;
  } finally {
    if (!published && pinned) {
      const parent = await pinDirectory(library.dir, library.uploadsDir());

      try {
        await pinned.verify();
        await parent.verify();
        await fs.rm(parent.child(uploadId), { recursive: true, force: true });
      } finally {
        await parent.close();
      }
    }

    await pinned?.close();
  }
}
