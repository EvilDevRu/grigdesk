import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Таблица ленивых загрузчиков исполнителей для исходного дерева.
 *
 * В SEA-сборке этот модуль заменяется сгенерированной таблицей с литеральными
 * импортами: esbuild тогда включает адаптеры в бандл. Правила имён и расширений
 * здесь те же, что у генератора server/scripts/sea/registries.mts.
 */

export interface ExecutorModule {
  default?: unknown;
}

export interface ExecutorLoader {
  name: string;
  file: string;
  load: () => Promise<ExecutorModule>;
}

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_EXTENSIONS = ['.js', '.ts'];
const NOT_ADAPTERS = new Set(['index', 'registryTable']);

/**
 * Перечисляет файлы-адаптеры в каталоге по нынешним правилам.
 * Один ИИ — один файл: пара .js/.ts с одним именем остаётся ошибкой, а не дублем.
 */
export function loadersFromDirectory(dir: string): ExecutorLoader[] {
  const loaders: ExecutorLoader[] = [];
  const seenNames = new Set<string>();

  for (const file of readdirSync(dir).sort()) {
    // Файлы на `_` — вспомогательные модули исполнителей (каталоги моделей и т.п.), не ИИ.
    if (file.startsWith('_')) {
      continue;
    }

    const extension = ADAPTER_EXTENSIONS.find((suffix) => file.endsWith(suffix));

    if (!extension) {
      continue;
    }

    const name = file.slice(0, -extension.length);

    if (NOT_ADAPTERS.has(name)) {
      continue;
    }

    if (seenNames.has(name)) {
      throw new Error(`Исполнитель ${name} объявлен дважды: убери лишний файл в ${dir}`);
    }

    seenNames.add(name);

    const absolute = path.join(dir, file);

    loaders.push({
      name,
      file: absolute,
      load: () => import(pathToFileURL(absolute).href),
    });
  }

  return loaders;
}

/**
 * Загрузчики исполнителей текущего каталога.
 * Ленивая функция: импорт модуля не читает каталог и не запускает адаптеры.
 */
export function executorLoaders(): ExecutorLoader[] {
  return loadersFromDirectory(DIR);
}
