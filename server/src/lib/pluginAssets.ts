import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isRecord } from '../../../shared/lib/objects.ts';
import { installError } from './packageInstall/errors.ts';

export const PLUGIN_MEDIA_LIMITS = {
  icon: 256 * 1024,
  screenshot: 4 * 1024 * 1024,
  screenshots: 6,
};

/**
 * Ресурс принадлежит пакету и не проходит через скрытые каталоги или зависимости.
 * Исходный путь проверяется до нормализации, чтобы не спрятать переход к родителю.
 */
export function pluginResourcePath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || /[:?#\\\x00-\x1f\x7f]/u.test(raw)
    || raw.split('/').some((part) => !part || part.startsWith('.') || part === 'node_modules')) {
    throw installError('manifest_invalid', 'нужен обычный относительный путь ресурса');
  }

  return raw;
}

/**
 * Каждый компонент проверяется без раскрытия ссылок, включая корень пакета.
 * Проверка повторяется перед выдачей файла, а не только при чтении манифеста.
 */
export function assertPluginResource(root: string, relative: string): string {
  let current = root;
  const parts = pluginResourcePath(relative).split('/');

  try {
    for (const [index, part] of ['', ...parts].entries()) {
      current = path.join(current, part);

      const info = lstatSync(current);
      const directory = index < parts.length;

      if (info.isSymbolicLink()) {
        throw installError('symlink_forbidden');
      }

      if (directory ? !info.isDirectory() : !info.isFile()) {
        throw installError('manifest_invalid', 'ресурс отсутствует или не является обычным файлом');
      }
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'symlink_forbidden') {
      throw error;
    }

    throw installError('manifest_invalid', 'ресурс отсутствует или не является обычным файлом');
  }

  return current;
}

/**
 * Расширение и сигнатура должны описывать один разрешённый растровый формат.
 * Размер проверяется до чтения; URL содержит отпечаток фактических байтов.
 */
export function readPluginRaster(root: string, relative: string, maximum: number) {
  const file = assertPluginResource(root, relative);
  const size = lstatSync(file).size;

  if (size > maximum) {
    throw installError('manifest_invalid', 'изображение превышает допустимый размер');
  }

  const bytes = readFileSync(file);
  const extension = path.extname(relative).toLowerCase();
  let mediaType: string | null = null;

  if (extension === '.png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    mediaType = 'image/png';
  } else if (['.jpg', '.jpeg'].includes(extension)
    && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) {
    mediaType = 'image/jpeg';
  } else if (extension === '.webp' && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP') {
    mediaType = 'image/webp';
  }

  if (!mediaType || bytes.length > maximum) {
    throw installError('manifest_invalid', 'нужно изображение PNG, JPEG или WebP с верной сигнатурой');
  }

  return {
    bytes,
    mediaType,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * Scanner и installer проверяют один набор файлов с одинаковыми пределами.
 * Скриншоты остаются данными пакета и не публикуют весь каталог ресурсов.
 */
export function resolvePluginAssets(root: string, id: string, raw: Record<string, unknown>) {
  const iconPath = pluginResourcePath(raw.icon);
  const icon = readPluginRaster(root, iconPath, PLUGIN_MEDIA_LIMITS.icon);
  const gallery = raw.gallery;

  if (gallery !== undefined && !isRecord(gallery)) {
    throw installError('manifest_invalid', 'gallery должен быть объектом');
  }

  const screenshots = isRecord(gallery) ? gallery.screenshots ?? [] : [];

  if (!Array.isArray(screenshots) || screenshots.length > PLUGIN_MEDIA_LIMITS.screenshots
    || new Set(screenshots).size !== screenshots.length) {
    throw installError('manifest_invalid', 'gallery.screenshots: не больше шести разных файлов');
  }

  for (const screenshot of screenshots) {
    readPluginRaster(root, pluginResourcePath(screenshot), PLUGIN_MEDIA_LIMITS.screenshot);
  }

  return { iconPath, icon: `/api/plugins/${id}/icon/${icon.digest}` };
}
