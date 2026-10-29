import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { sha256File } from '../../../../shared/node/hash.ts';

/**
 * Полный отпечаток связывает preview с байтами, mode и ссылками, не следуя за symlink.
 * Отсутствие цели имеет отдельное значение; IO-ошибка никогда не считается отсутствием.
 */
export async function treeSnapshot(root: string): Promise<string> {
  const hash = createHash('sha256');
  let count = 0;

  /**
   * Снимок различает отсутствие и ошибку IO и не следует за symlink.
   * Специальные файлы закрывают снимок: их нельзя сравнивать по содержимому.
   */
  async function visit(file: string): Promise<void> {
    const stat = await fs.lstat(file).catch((error) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });
    const relative = path.relative(root, file);

    count += 1;

    if (count > 250_000) {
      throw new Error('Слишком большое дерево установки');
    }
    if (!stat) {
      hash.update(JSON.stringify([relative, 'missing']));

      return;
    }

    const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file';

    hash.update(JSON.stringify([relative, kind, stat.mode]));

    if (stat.isSymbolicLink()) {
      hash.update(await fs.readlink(file));
    } else if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(file)).sort()) {
        await visit(path.join(file, entry));
      }
    } else if (stat.isFile()) {
      hash.update(await sha256File(file));
    } else {
      throw new Error('Специальный файл в дереве установки');
    }
  }

  await visit(root);

  return hash.digest('hex');
}
