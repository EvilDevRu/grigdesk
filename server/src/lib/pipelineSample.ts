import path from 'node:path';

import { runtimeRoot } from './runtimePaths.ts';

/**
 * Находит поставляемый образец относительно физического корня runtime.
 * Папка данных, cwd и каталог установки не меняют адрес ресурса.
 */
export function pipelineSampleDirectoryFor(paths: { root: string }): string {
  return path.join(paths.root, 'server/seed/pipeline-sample');
}

/**
 * Привязывает accessor конфигурации к физическому корню текущего runtime.
 * Разрешение ресурса не читает и не устанавливает пользовательские профили.
 */
export function pipelineSampleDirectory(): string {
  return pipelineSampleDirectoryFor({ root: runtimeRoot() });
}
