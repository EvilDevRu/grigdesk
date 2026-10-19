import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadersFromDirectory } from './engineDirectory.ts';
import type { DbEngineLoader } from './engineDirectory.ts';

/**
 * Таблица загрузчиков движков БД для исходного дерева.
 *
 * В SEA-сборке модуль заменяется сгенерированной таблицей с литеральными
 * импортами; явный `dir` в createEngineRegistry по-прежнему идёт через
 * engineDirectory.ts и не зависит от этой таблицы.
 */

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'engines');

/**
 * Загрузчики движков из штатного каталога.
 * Чтение каталога происходит только при вызове реестра, не при импорте модуля.
 */
export async function dbEngineLoaders(): Promise<DbEngineLoader[]> {
  return loadersFromDirectory(DEFAULT_DIR);
}
