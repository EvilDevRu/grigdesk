import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * До mkdir проверяются уже существующие сегменты выбранного пути без следования symlink.
 * Отсутствующий хвост допустим, но ссылка в предке не разрешает запись в другой каталог.
 */
export async function assertInstallParents(target: string): Promise<void> {
  if (!path.isAbsolute(target) || path.resolve(target) !== target || target === path.sep) {
    throw new Error('installation_input_invalid');
  }

  let current: string = path.sep;

  for (const part of target.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);

    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return null;
    });

    if (!stat) {
      return;
    }

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('installation_path_invalid');
    }
  }
}
