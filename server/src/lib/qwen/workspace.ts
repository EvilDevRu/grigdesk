import path from 'node:path';

import { validateWorkdirPath } from '../chat/workdir.ts';

/**
 * Адаптер и прямой запуск проверяют одинаковые физические корни до создания песочницы.
 * Ссылки и повторы не меняют набор доступа и identity памяти; главный cwd остаётся первым.
 */
export async function resolveQwenWorkspace(cwd: string, extraDirs: readonly string[] = []) {
  const main = await validateWorkdirPath(cwd);
  const resolved = await Promise.all(extraDirs.map((directory) => validateWorkdirPath(directory)));
  const additional = [...new Set(resolved)].filter((directory) => directory !== main).sort();
  const roots = [main, ...additional];

  for (const root of roots) {
    for (const name of ['.env', '.qwen']) {
      const hidden = path.join(root, name);

      if (roots.some((directory) => directory === hidden || directory.startsWith(`${hidden}${path.sep}`))) {
        throw new Error('Qwen: рабочий корень перекрывается скрываемой папкой .env или .qwen.');
      }
    }
  }

  return {
    cwd: main,
    extraDirs: additional,
    roots,
  };
}
