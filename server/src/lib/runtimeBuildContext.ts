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
    binary?: string;
  }
  | {
    mode: 'payload';
    bundleFile: string;
    binary: string;
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

/**
 * Source не может принять контекст внешнего payload и сменить собственную раскладку.
 * При сборке payload plugin заменяет этот export закрытым состоянием once-state.
 */
export function configurePayloadContext(_context: Extract<RuntimeBuildContext, { mode: 'payload' }>): never {
  throw Object.assign(new Error('Контекст payload недоступен в source'), {
    code: 'server_payload_context_unavailable',
  });
}
