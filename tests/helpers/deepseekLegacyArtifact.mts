import {
  readDeepSeekArtifact as readArtifact,
  readDeepSeekArtifactAsync as readArtifactAsync,
  type DeepSeekWorkerRuntime,
} from '../../shared/node/deepSeekArtifact.ts';

export {
  deepSeekRuntimeError,
  readDeepSeekArtifactHeader,
  type DeepSeekArtifact,
  type DeepSeekArtifactContract,
  type DeepSeekArtifactHeader,
} from '../../shared/node/deepSeekArtifact.ts';

function hostNode(): DeepSeekWorkerRuntime {
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    nativeAbi: process.versions.modules,
  };
}

/**
 * Legacy generation исполняется Node сервера и сохраняет прежнюю сверку его ABI.
 * Общая integrity-проверка не выбирает среду исполнения за вызывающего.
 */
export function readDeepSeekArtifact(directory: string) {
  return readArtifact(directory, hostNode());
}

/**
 * Серверный обход остаётся асинхронным, включая хеширование и инвентарь ссылок.
 * Вынос кода не меняет совместимость legacy generation с текущим host Node.
 */
export function readDeepSeekArtifactAsync(directory: string) {
  return readArtifactAsync(directory, hostNode());
}
