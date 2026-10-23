import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const bundleMarker = 'bin/bundle.json';

/**
 * Marker отличает переносимый комплект от исходников и прежней поставки R.
 * Само чтение не готовит сервер и не меняет пользовательские настройки.
 */
export function isPortableBundle(root: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(path.join(root, bundleMarker), 'utf8'));

    return marker.format === 1 && marker.kind === 'portable';
  } catch {
    return false;
  }
}

/**
 * AppImage сообщает физический исходный файл отдельно от временной точки монтирования.
 * Неверный APPIMAGE закрывает discovery, чтобы не выбрать сервер из временной распаковки.
 */
export async function portableWindowPath(input: {
  isPackaged: boolean;
  execPath: string;
  env: NodeJS.ProcessEnv;
}): Promise<string | null> {
  if (!input.isPackaged) {
    return null;
  }

  const file = input.env.APPIMAGE ?? input.execPath;

  if (!path.isAbsolute(file)) {
    return null;
  }

  try {
    const physical = await fs.realpath(file);

    return await isPortableBundle(path.dirname(physical)) ? physical : null;
  } catch {
    return null;
  }
}
