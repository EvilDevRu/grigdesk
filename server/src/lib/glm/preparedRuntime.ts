import type { PreparedExecutorRuntime } from '../executorSettings/types.ts';
import type { DeepSeekRuntimeConfig, DeepSeekRuntimeDescriptor } from '../deepseek/runtimeProcess.ts';
import { createDeepSeekRuntimeScope } from '../deepseek/preparedRuntime.ts';
import { glmRuntimeConfig } from './generation.ts';
import { glmAccessError } from './env.ts';

const scope = createDeepSeekRuntimeScope();

/**
 * GLM получает собственный opaque handle, несовместимый с handles DeepSeek.
 * Подготовка использует тот же async resolver и проверки целостности descriptor.
 */
export function prepareGlmRuntime(config: DeepSeekRuntimeConfig, options: { signal: AbortSignal }) {
  return scope.prepare(glmRuntimeConfig(config), options);
}

/**
 * Сохранённый descriptor читается без нового выбора current или ELF по тому же пути.
 * Ошибка подмены получает публичный код GLM до binding или файловых эффектов run.
 */
export async function preparedGlmRuntime(
  config: DeepSeekRuntimeConfig,
  handle?: PreparedExecutorRuntime,
): Promise<DeepSeekRuntimeDescriptor> {
  try {
    return await scope.read(glmRuntimeConfig(config), handle);
  } catch (error) {
    if ((error as { code?: string }).code === 'deepseek_runtime_changed') {
      throw glmAccessError('glm_runtime_changed', 'Подготовленный runtime GLM изменился');
    }

    throw error;
  }
}
