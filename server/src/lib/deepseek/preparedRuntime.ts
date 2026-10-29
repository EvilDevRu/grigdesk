// Opaque handle связывает discovery, security binding и запуск с одним descriptor.
// Ни descriptor, ни пути и metadata не сериализуются в сам handle.

import type { PreparedExecutorRuntime } from '../executorSettings/types.ts';
import path from 'node:path';
import {
  resolveDeepSeekRuntimeAsync,
  verifyDeepSeekRuntimeDescriptorAsync,
} from './runtimeProcess.ts';
import type { DeepSeekRuntimeConfig, DeepSeekRuntimeDescriptor } from './runtimeProcess.ts';
import { deepSeekRuntimeError } from './runtimeArtifact.ts';
import { selectedDeepSeekBinary, usesDeepSeekBinary } from './distribution.ts';
import { ExecutorRuntimeError } from '../executors/errors.ts';

/**
 * Handle нельзя перенести на другую выбранную поставку или cache через замену config.
 * Остальные поля server config не влияют на принадлежность runtime.
 */
function selectionKey(config: DeepSeekRuntimeConfig): string {
  return JSON.stringify([
    usesDeepSeekBinary(config) ? selectedDeepSeekBinary(config) : null,
    config.deepseekRuntimeMode,
    config.deepseekBin,
    config.deepseekBinOverride,
    config.deepseekCacheDir,
    config.deepseekArtifactDir,
    config.deepseekGenerationRoot,
  ]);
}


function changedRuntime() {
  return deepSeekRuntimeError('deepseek_runtime_changed', 'Подготовленный runtime DeepSeek изменился');
}


/**
 * Отдельный scope выдаёт handles только своему адаптеру и хранит descriptor в WeakMap.
 * Общая проверка выбора и файла не позволяет двум провайдерам принимать чужие handles.
 */
export function createDeepSeekRuntimeScope() {
  const prepared = new WeakMap<PreparedExecutorRuntime, {
    runtime: DeepSeekRuntimeDescriptor;
    selection: string;
  }>();

  /**
   * Один async descriptor принадлежит одному серверному handle на время подготовки хода.
   * Объект не раскрывает внутренние поля и принимается только через этот WeakMap.
   */
  async function prepare(
    config: DeepSeekRuntimeConfig,
    { signal }: { signal: AbortSignal },
  ): Promise<PreparedExecutorRuntime> {
    const selection = selectionKey(config);
    const runtime = await resolveDeepSeekRuntimeAsync(config, { signal });

    if (selectionKey(config) !== selection) {
      throw changedRuntime();
    }

    const handle = Object.freeze(Object.create(null)) as PreparedExecutorRuntime;

    prepared.set(handle, { runtime, selection });

    return handle;
  }

  /**
   * Подготовленный ход никогда не выбирает текущий бинарник повторно вместо закреплённого.
   * Перед эффектами проверяет принадлежность handle и целостность его descriptor.
   */
  async function read(
    config: DeepSeekRuntimeConfig,
    handle?: PreparedExecutorRuntime,
  ): Promise<DeepSeekRuntimeDescriptor> {
    if (handle === undefined) {
      return resolveDeepSeekRuntimeAsync(config);
    }

    const bound = prepared.get(handle);

    if (!bound || bound.selection !== selectionKey(config)) {
      throw changedRuntime();
    }

    await verifyDeepSeekRuntimeDescriptorAsync(bound.runtime);

    return bound.runtime;
  }

  return { prepare, read };
}

const scope = createDeepSeekRuntimeScope();

export const prepareDeepSeekRuntime = scope.prepare;
export const preparedDeepSeekRuntime = scope.read;

/**
 * Новый чат допускается только на ELF с обязательной native проверкой инструментов.
 * Общий runtime scope остаётся совместимым с metadata, Factory и GLM.
 */
export function requireDeepSeekToolPermissions(runtime: DeepSeekRuntimeDescriptor): void {
  if (runtime.capabilities.toolPermissions !== true) {
    throw new ExecutorRuntimeError(
      'deepseek_tool_permissions_unavailable',
      'Обновите бинарник DeepSeek: установленная версия не поддерживает подтверждение действий.',
    );
  }
}

/**
 * Capability бинарника не заменяет обязательный флаг запуска конкретного чата.
 * Отсутствующая policy останавливает ход до подготовки native настроек и spawn.
 */
export function requireDeepSeekToolPolicy(policyPath: unknown): asserts policyPath is string {
  if (typeof policyPath !== 'string' || !path.isAbsolute(policyPath)) {
    throw new ExecutorRuntimeError(
      'deepseek_tool_permissions_unavailable',
      'Не создана обязательная политика разрешений DeepSeek.',
    );
  }
}

/**
 * Preflight проверяет capability до подготовки настроек и изменения session binding.
 * Handle по-прежнему принадлежит единственному descriptor текущего запуска.
 */
export async function prepareDeepSeekChatRuntime(
  config: DeepSeekRuntimeConfig,
  options: { signal: AbortSignal },
): Promise<PreparedExecutorRuntime> {
  const handle = await scope.prepare(config, options);
  const runtime = await scope.read(config, handle);

  requireDeepSeekToolPermissions(runtime);

  return handle;
}
