import {
  readDeepSeekArtifactAsync,
  type DeepSeekWorkerRuntime,
} from '../../../shared/node/deepSeekArtifact.ts';

export type { DeepSeekWorkerRuntime };

/**
 * Поставка сверяет generation с выбранным worker, независимо от Node сервера.
 * Его версия, платформа и ABI обязательны даже при уже прогретом integrity cache.
 */
export function readWorkerArtifact(directory: string, worker: DeepSeekWorkerRuntime) {
  return readDeepSeekArtifactAsync(directory, worker);
}
