import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { HelperManifest } from './helpers.mts';

export interface CompatibilityManifest {
  schema: number;
  wrappers: Array<{
    path: string;
    helper: string;
    kind: 'script' | 'library';
  }>;
}

/**
 * Выпускает тонкие обёртки прежних shell-путей только в staging-комплект.
 * Весь список проверяется до записи; относительный import переносится вместе с R.
 */
export async function writeCompatibility(root: string, manifest: CompatibilityManifest,
  helpers: Pick<HelperManifest, 'helpers'>): Promise<string[]> {
  if (manifest.schema !== 1 || !Array.isArray(manifest.wrappers)) {
    throw new Error('Некорректный manifest обёрток');
  }

  const seen = new Set<string>();

  for (const wrapper of manifest.wrappers) {
    const relative = path.relative(root, path.resolve(root, wrapper.path));
    const helper = helpers.helpers.find((entry) => entry.id === wrapper.helper);

    if (!relative || relative.startsWith('..') || path.isAbsolute(wrapper.path)
      || seen.has(wrapper.path)) {
      throw new Error(`Некорректный путь обёртки: ${wrapper.path}`);
    }

    if (!helper || !['script', 'library'].includes(wrapper.kind)) {
      throw new Error(`Неизвестный helper или вид обёртки: ${wrapper.path}`);
    }

    if ((wrapper.kind === 'library') !== (helper.entryKind === 'library')) {
      throw new Error(`Несовместимый вид helper для обёртки: ${wrapper.path}`);
    }

    const entry = path.join(root, 'server/runtime/helpers', `${wrapper.helper}.mjs`);

    await stat(entry);
    seen.add(wrapper.path);
  }

  for (const wrapper of manifest.wrappers) {
    const target = path.join(root, wrapper.path);
    const entry = path.join(root, 'server/runtime/helpers', `${wrapper.helper}.mjs`);
    const relative = path.relative(path.dirname(target), entry).split(path.sep).join('/');
    const specifier = JSON.stringify(relative.startsWith('.') ? relative : `./${relative}`);
    const statement = wrapper.kind === 'library' ? `export * from ${specifier};` : `import ${specifier};`;

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '// Совместимый путь комплекта GrigDesk.\n' + statement + '\n');
  }

  return [...seen];
}
