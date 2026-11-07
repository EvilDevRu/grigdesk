// Descriptor закрепляет packageId ELF до подготовки настроек и запуска.
// Независимая замена файла не меняет argv уже подготовленного запуска.

import os from 'node:os';
import path from 'node:path';
import { probeDeepSeekBinaryCached, probeDeepSeekBinarySync } from './binaryProbe.ts';
import { selectedDeepSeekBinary } from './distribution.ts';
import type { DeepSeekBinaryFile } from './binaryProbe.ts';
import type { ExecutorProbe } from '../executors/index.ts';
import { dataHome, dataPath } from '../../../../shared/runtime/dataHome.ts';
import type { DeepSeekRuntimeInfo } from '../../../../shared/chat/deepSeekBinary.ts';
import { deepSeekRuntimeError, type DeepSeekArtifactContract }
  from '../../../../shared/node/deepSeekArtifact.ts';

export interface DeepSeekRuntimeConfig {
  rootDir?: string;
  deepseekBin?: string;
  deepseekBinOverride?: string;
  deepseekRuntimeMode?: 'installed' | 'embedded' | 'binary';
  deepseekCacheDir?: string;
  deepseekArtifactDir?: string;
  deepseekGenerationRoot?: string;
}

export interface DeepSeekRuntimeDescriptor {
  readonly kind: 'embedded' | 'external' | 'binary';
  readonly command: string;
  readonly prefixArgs: readonly string[];
  readonly upstreamVersion: string;
  readonly buildId: string | null;
  readonly runtimeVersion: string;
  readonly generationDir: string | null;
  readonly identity: string;
  readonly capabilities: Readonly<DeepSeekArtifactContract['capabilities']>;
  readonly metadata?: DeepSeekRuntimeInfo;
  readonly binaryFile?: DeepSeekBinaryFile;
}

/**
 * Server-owned cache и ожидаемый packageId закрепляются до любого запуска Harness.
 * Worker ABI берётся из metadata; generation не должна существовать рядом с ELF.
 */
function binaryDescriptor(
  command: string,
  metadata: DeepSeekRuntimeInfo,
  config: DeepSeekRuntimeConfig,
  binaryFile?: DeepSeekBinaryFile,
): DeepSeekRuntimeDescriptor {
  const cacheDir = config.deepseekCacheDir
    ?? dataPath(dataHome({ env: process.env, home: os.homedir() }), 'deepseekRuntime');

  if (!path.isAbsolute(cacheDir) || cacheDir === '/' || cacheDir.includes('\0')) {
    throw deepSeekRuntimeError('deepseek_cache_invalid', 'Кэш DeepSeek требует абсолютный путь');
  }

  return Object.freeze({
    kind: 'binary',
    command,
    prefixArgs: Object.freeze(['--expect-package-id', metadata.packageId, '--cache-dir', cacheDir]),
    upstreamVersion: metadata.upstreamVersion,
    buildId: metadata.buildId,
    runtimeVersion: metadata.runtimeVersion,
    generationDir: null,
    identity: `deepseek-package:${metadata.packageId}`,
    capabilities: Object.freeze({ ...metadata.capabilities }),
    metadata: Object.freeze(metadata),
    ...(binaryFile ? { binaryFile } : {}),
  });
}

/**
 * Descriptor разрешается один раз на запуск с полной проверкой поколения.
 * Синхронная версия для CLI и wrapper конвейера, у которых нет общего event loop.
 */
export function resolveDeepSeekRuntime(config: DeepSeekRuntimeConfig): DeepSeekRuntimeDescriptor {
  const binary = selectedDeepSeekBinary(config);

  return binaryDescriptor(binary, probeDeepSeekBinarySync(binary), config);
}

/**
 * Та же полная проверка без остановки event loop сервера: обход и хеширование поколения
 * идут асинхронно, контракт ошибок и cache общие с синхронной версией.
 */
export async function resolveDeepSeekRuntimeAsync(
  config: DeepSeekRuntimeConfig,
  options: { signal?: AbortSignal } = {},
): Promise<DeepSeekRuntimeDescriptor> {
  options.signal?.throwIfAborted();

  const binary = selectedDeepSeekBinary(config);
  const { info, file } = await probeDeepSeekBinaryCached(binary, options.signal);

  options.signal?.throwIfAborted();

  return binaryDescriptor(binary, info, config, file);
}

/**
 * Отпечаток выбранной сборки без обхода её файлов: внешний CLI или buildId поколения.
 * Недоступность — исключение с безопасной причиной: вызывающий отказывает в запуске,
 * а не подменяет привязку сессии отпечатком «недоступно».
 */
export function requireDeepSeekRuntimeIdentity(config: DeepSeekRuntimeConfig): string {
  return describeDeepSeekRuntime(config).identity;
}

/**
 * Лёгкое описание выбранной сборки для карточки и ключей кэша: identity и версии.
 * Целостность файлов здесь не доказывается — её проверяют descriptor и probe.
 */
export function describeDeepSeekRuntime(config: DeepSeekRuntimeConfig): {
  identity: string;
  buildId: string | null;
  runtimeVersion: string;
} {
  const runtime = resolveDeepSeekRuntime(config);

  return {
    identity: runtime.identity,
    buildId: runtime.buildId,
    runtimeVersion: runtime.runtimeVersion,
  };
}

/**
 * Проверенный descriptor остаётся единственным источником argv и upstream version.
 * Node без целого артефакта никогда не означает installed DeepSeek.
 */
export async function probeDeepSeekRuntime(
  config: DeepSeekRuntimeConfig,
  prepared?: DeepSeekRuntimeDescriptor,
): Promise<ExecutorProbe> {
  try {
    const runtime = prepared ?? await resolveDeepSeekRuntimeAsync(config);
    const described = {
      ...(runtime.buildId ? { buildId: runtime.buildId } : {}),
      runtimeVersion: runtime.runtimeVersion,
      ...(runtime.metadata ? {
        packageId: runtime.metadata.packageId,
        binaryVersion: runtime.metadata.binaryVersion,
      } : {}),
    };

    return {
      ok: true,
      version: runtime.upstreamVersion,
      ...described,
    };
  } catch (error) {
    const rawCode = (error as { code?: unknown }).code;
    const code = typeof rawCode === 'string' ? rawCode : undefined;

    return {
      ok: false,
      version: null,
      code,
      error: code?.startsWith('deepseek_')
        ? (error as Error).message
        : 'Бинарь DeepSeek Harness недоступен',
    };
  }
}

/**
 * Сохранённый settings snapshot принадлежит конкретной сборке до создания session.
 * Смена поколения требует новой подготовки, даже при неизменной upstream version.
 */
export function assertDeepSeekPreparedRuntime(
  runtime: DeepSeekRuntimeDescriptor,
  plan?: { runtimeIdentity?: string },
): void {
  if (plan?.runtimeIdentity && plan.runtimeIdentity !== runtime.identity) {
    throw deepSeekRuntimeError(
      'deepseek_runtime_changed',
      'Runtime DeepSeek изменился после подготовки настроек',
    );
  }
}

/**
 * Проверка закреплённого файла сохраняет signature, SHA и packageId до spawn.
 * Optional signal отменяет только caller; shared probe остальных ожидателей продолжает работать.
 */
export async function verifyDeepSeekRuntimeDescriptorAsync(runtime: DeepSeekRuntimeDescriptor, options: {
  signal?: AbortSignal;
} = {}): Promise<void> {
  options.signal?.throwIfAborted();

  try {
    const current = await probeDeepSeekBinaryCached(runtime.command, options.signal);

    options.signal?.throwIfAborted();

    if (current.info.packageId !== runtime.metadata?.packageId
      || runtime.binaryFile && (current.file.signature !== runtime.binaryFile.signature
        || current.file.sha256 !== runtime.binaryFile.sha256)) {
      throw new Error('changed');
    }
  } catch {
    options.signal?.throwIfAborted();

    throw deepSeekRuntimeError('deepseek_runtime_changed', 'Закреплённый бинарник DeepSeek изменился');
  }
}

/**
 * Ключ кэша различает каждое поколение и безопасное состояние недоступности.
 * Он не обращается к модели и не наследует identity последней успешной сборки.
 */
export function deepSeekRuntimeIdentity(config: DeepSeekRuntimeConfig): string {
  try {
    return requireDeepSeekRuntimeIdentity(config);
  } catch (error) {
    return `${(error as { code?: string }).code}:unavailable`;
  }
}
