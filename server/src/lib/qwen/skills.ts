import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Общий каталог и цели ссылок на bundles доступны песочнице только для чтения.
 * Родительские home и вложенные ссылки за пределы bundle этим доступом не открываются.
 */
export async function resolveQwenSkills(home = homedir()): Promise<{
  directories: string[];
  roots: string[];
}> {
  const directory = await fs.realpath(path.join(home, '.agents', 'skills')).catch(() => null);

  if (!directory) {
    return { directories: [], roots: [] };
  }

  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => null);

  if (!entries) {
    return { directories: [], roots: [] };
  }

  const roots = new Set([directory]);

  for (const entry of entries) {
    if (!entry.isSymbolicLink()) {
      continue;
    }

    try {
      const target = await fs.realpath(path.join(directory, entry.name));
      const manifest = await fs.stat(path.join(target, 'SKILL.md'));

      if (manifest.isFile()) {
        roots.add(target);
      }
    } catch {
      // Исчезнувший или сломанный bundle не закрывает остальные навыки.
    }
  }

  return { directories: [directory], roots: [...roots] };
}
