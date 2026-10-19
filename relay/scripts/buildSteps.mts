import path from 'node:path';

import {
  ensureNodeArchive as ensureSharedArchive,
  readNodeRuntime as readSharedRuntime,
} from '../../shared/node/nodeRuntime.ts';
import type { ArchiveOptions, NodeRuntime } from '../../shared/node/nodeRuntime.ts';

export {
  publishFile,
  SEA_FUSE,
} from '../../shared/node/nodeRuntime.ts';
export type { NodeRuntime } from '../../shared/node/nodeRuntime.ts';

/**
 * Разбирает единственную настройку сборки до сетевых и файловых эффектов.
 * Относительный путь всегда относится к папке вызывающего процесса.
 */
export function parseBuildArgs(args: readonly string[], cwd: string, relayDir: string):
  { outDir: string } | { error: string } {
  if (args.length === 0) {
    return { outDir: path.resolve(relayDir, '..', 'bin') };
  }

  if (args.length === 2 && args[0] === '--out-dir' && args[1] && !args[1].startsWith('--')) {
    return { outDir: path.resolve(cwd, args[1]) };
  }

  return { error: 'Использование: npm --prefix relay run build -- [--out-dir <каталог>]' };
}

/**
 * Читает манифест runtime посредника с его меткой в сообщении об ошибке.
 * Общая проверка версии, платформы и SHA256 живёт в shared/node/nodeRuntime.ts.
 */
export function readNodeRuntime(value: unknown): NodeRuntime {
  return readSharedRuntime(value, 'relay/build/node-runtime.json');
}

/**
 * Сохраняет прежний контракт посредника: испорченный архив кэша удаляется
 * до повторной загрузки, чтобы неудачная попытка не оставляла мусор.
 */
export function ensureNodeArchive(
  runtime: NodeRuntime,
  cacheDir: string,
  options: ArchiveOptions,
): Promise<string> {
  return ensureSharedArchive(runtime, cacheDir, {
    ...options,
    discardInvalidArchive: true,
  });
}
