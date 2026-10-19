import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Контекст сборки для контракта путей.
 *
 * Исходная реализация возвращает корень дерева и Node текущего процесса.
 * Сборщик SEA подменяет этот модуль контекстом `sea` либо `helper`, поэтому
 * packaged-код не может переключиться на исходники переменной окружения.
 */

export type RuntimeBuildContext =
  | {
    mode: 'source';
    root: string;
    execPath: string;
  }
  | {
    mode: 'sea';
    execPath: string;
  }
  | {
    mode: 'helper';
    helperUrl: string;
  };

/**
 * Возвращает контекст исходного запуска: корень дерева вычисляется от этого файла.
 * Никаких переменных окружения и обращений к папке данных здесь нет.
 */
export function runtimeBuildContext(): RuntimeBuildContext {
  return {
    mode: 'source',
    root: path.resolve(fileURLToPath(new URL('../../../', import.meta.url))),
    execPath: process.execPath,
  };
}
