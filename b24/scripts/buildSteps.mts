import path from 'node:path';

import {
  readNodeRuntime as readSharedRuntime,
} from '../../shared/node/nodeRuntime.ts';
import type { NodeRuntime } from '../../shared/node/nodeRuntime.ts';

export {
  assertUntracked,
  ensureNodeArchive,
  publishFile,
  SEA_FUSE,
} from '../../shared/node/nodeRuntime.ts';
export type { NodeRuntime } from '../../shared/node/nodeRuntime.ts';

export interface BuildOptions {
  outDir: string;
  cacheDir: string;
}

const USAGE = 'Использование: npm --prefix b24 run build -- [--out-dir <каталог>] [--cache-dir <каталог>]';
const FLAGS = new Map<string, keyof BuildOptions>([
  ['--out-dir', 'outDir'],
  ['--cache-dir', 'cacheDir'],
]);

/**
 * Разбирает каталоги сборки до сетевых и файловых эффектов.
 * Относительный путь относится к cwd процесса; повтор, пустое значение и чужой флаг — ошибка.
 */
export function parseBuildArgs(args: readonly string[], cwd: string, packageDir: string):
  BuildOptions | { error: string } {
  const root = path.resolve(packageDir, '..');
  const result: BuildOptions = {
    outDir: path.join(root, 'bin'),
    cacheDir: path.join(root, 'b24/.cache'),
  };
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 2) {
    const key = FLAGS.get(args[index] ?? '');
    const value = args[index + 1];

    if (!key || seen.has(key) || !value || value.startsWith('--')) {
      return { error: USAGE };
    }

    seen.add(key);
    result[key] = path.resolve(cwd, value);
  }

  return result;
}

/**
 * Читает манифест runtime с меткой своего выпуска.
 * Общая проверка версии, платформы и SHA256 живёт в shared/node/nodeRuntime.ts.
 */
export function readNodeRuntime(value: unknown): NodeRuntime {
  return readSharedRuntime(value, 'b24/build/node-runtime.json');
}

