import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import { decodeAppUpdate } from '../contract.ts';
import { MobileInputError } from '../errors.ts';
import type { MobileApp } from '../mobileServer.ts';
import type { FacadeDeps } from './common.ts';

/**
 * Открытый FD закрепляет именно те байты, чей размер и hash проверяются по manifest.
 * Подмена имени во время download не переключает чтение на другой файл; symlink отвергается.
 */
async function verifiedApk(directory: string) {
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;

  try {
    const metadata = await fs.readFile(path.join(directory, 'grigdesk-mobile.json'));

    if (metadata.length > 4096) {
      throw new Error('invalid_manifest');
    }

    const manifest = decodeAppUpdate(JSON.parse(metadata.toString('utf8')));

    file = await fs.open(
      path.join(directory, 'grigdesk-mobile.apk'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );

    const stat = await file.stat();

    if (!stat.isFile() || stat.size !== manifest.size || stat.size > 268435456) {
      throw new Error('apk_size');
    }

    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let offset = 0;

    while (offset < stat.size) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      );

      if (!bytesRead) {
        throw new Error('short_apk');
      }

      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }

    if (hash.digest('hex') !== manifest.sha256) {
      throw new Error('apk_hash');
    }

    return {
      file,
      manifest,
    };
  } catch (error) {
    await file?.close();

    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MobileInputError('no_apk', 'Обновление приложения пока не опубликовано.', 404);
    }

    throw new MobileInputError('apk_mismatch', 'Файл обновления не совпадает с описанием.', 409);
  }
}

/**
 * Публикует только проверенный manifest и APK из фиксированного мобильного каталога.
 * Даже чтение версии проверяет файл: UI не предлагает заведомо повреждённое обновление.
 */
export function registerAppRoutes(app: MobileApp, deps: Pick<FacadeDeps, 'apkDirectory'>) {
  app.get('/api/mobile/v1/app', async () => {
    const { file, manifest } = await verifiedApk(deps.apkDirectory);

    await file.close();

    return manifest;
  });
  app.get('/api/mobile/v1/app/apk', async (_request, reply) => {
    const { file, manifest } = await verifiedApk(deps.apkDirectory);
    const stream = file.createReadStream({
      start: 0,
      autoClose: true,
    });

    return reply
      .type('application/vnd.android.package-archive')
      .header('Content-Length', manifest.size)
      .header('Cache-Control', 'private, no-store')
      .send(stream);
  });
}
