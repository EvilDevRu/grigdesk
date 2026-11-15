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

export type { CliBuildOptions as BuildOptions } from '../../shared/node/cliBuildArgs.ts';
export { parseCliBuildArgs as parseBuildArgs } from '../../shared/node/cliBuildArgs.ts';

/**
 * Читает манифест runtime с меткой своего выпуска.
 * Общая проверка версии, платформы и SHA256 живёт в shared/node/nodeRuntime.ts.
 */
export function readNodeRuntime(value: unknown): NodeRuntime {
  return readSharedRuntime(value, 'tracker/build/node-runtime.json');
}

