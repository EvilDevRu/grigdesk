import path from 'node:path';

import { dataPath } from '../../../shared/runtime/dataHome.ts';
import type { RuntimeKind } from './runtimePaths.ts';

/**
 * Изменяемые каталоги хоста, которые зависят от режима запуска.
 *
 * Source сохраняет прежние умолчания в корне дерева. Packaged-комплект
 * только для чтения, поэтому новые профили по умолчанию живут в папке данных.
 * Явный FACTORY_PROFILES_DIR имеет приоритет в обоих режимах.
 */

export interface WritableLayoutInput {
  kind: RuntimeKind;
  rootDir: string;
  dataHome: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Выбирает каталог проектных профилей фабрики.
 * Пустой или отсутствующий override не считается выбором человека.
 */
export function profilesDirFor(input: WritableLayoutInput): string {
  const explicit = input.env.FACTORY_PROFILES_DIR;

  if (typeof explicit === 'string' && explicit !== '') {
    return explicit;
  }

  if (input.kind === 'packaged') {
    return dataPath(input.dataHome, 'profiles');
  }

  return path.join(input.rootDir, 'profiles');
}
