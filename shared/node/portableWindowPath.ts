import fs from 'node:fs/promises';
import path from 'node:path';

import { isPortableBundle } from './bundleLayout.ts';

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
