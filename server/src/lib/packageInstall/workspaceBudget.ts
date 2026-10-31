import { lstat, readdir, statfs } from 'node:fs/promises';
import path from 'node:path';

import type { PluginWorkspaceBudget } from './runCommand.ts';

/**
 * Мягкий предел учитывает файлы всех стадий, не переходя по symlink наружу.
 * Один caller сериализует обходы, поэтому большой root не запускает накопившиеся измерения.
 */
async function treeBytes(root: string): Promise<number> {
  const info = await lstat(root);

  if (!info.isDirectory()) {
    return info.size;
  }

  let total = 0;

  for (const entry of await readdir(root)) {
    const child = path.join(root, entry);

    try {
      total += await treeBytes(child);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return total;
}

/**
 * Корень job задаётся сервисом и включает Git, cache и все npmDirs.
 * Ошибка измерения не выдаётся за подтверждённое наличие свободного места.
 */
export async function workspaceWithinBudget(budget: PluginWorkspaceBudget): Promise<boolean> {
  const root = await lstat(budget.root);

  if (!root.isDirectory() || root.isSymbolicLink()) {
    return false;
  }

  const filesystem = await statfs(budget.root);
  const bytes = await treeBytes(budget.root);

  return bytes <= budget.maxBytes && filesystem.bavail * filesystem.bsize >= budget.minFreeBytes;
}
