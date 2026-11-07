import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Каталог движков БД для исходного дерева и явного `dir` в тестах.
 *
 * В SEA-сборке реестр по умолчанию берёт сгенерированную таблицу с литеральными
 * импортами, а этот модуль остаётся для проверок на временном каталоге.
 */

export interface DbEngineModule {
  default?: unknown;
}

export interface DbEngineLoader {
  name: string;
  load: () => Promise<DbEngineModule>;
}

/**
 * Перечисляет self-describing движки в каталоге.
 * Расширения .js/.mjs/.ts/.mts сохраняют прежнее поведение реестра.
 */
export async function loadersFromDirectory(dir: string): Promise<DbEngineLoader[]> {
  const names = (await readdir(dir))
    .filter((name) => /\.(?:m?[jt]s)$/u.test(name))
    .sort();

  return names.map((name) => {
    const absolute = path.join(dir, name);

    return {
      name,
      load: () => import(pathToFileURL(absolute).href),
    };
  });
}
