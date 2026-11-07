// Приватные extensions существуют только между host и дочерним ACP процессом.
// Они сохраняют интерфейс web settings RPC, не добавляя model/MCP инструменты.

import { spawn, type SpawnOptions } from 'node:child_process';
import type { AcpClient } from '../acp/client.ts';
import { createAcpClient, initializeAcp } from '../acp/client.ts';
import type { DeepSeekRuntimeDescriptor } from './runtimeProcess.ts';
import { verifyDeepSeekRuntimeDescriptorAsync } from './runtimeProcess.ts';
import { combineDeepSeekCleanupFailure, spawnDeepSeekBinary } from './binaryProcess.ts';

export interface DeepSeekSettingsRpc {
  rpc(method: string, args?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>;
}

/**
 * Первый запрос ждёт также распаковку и полную проверку холодного ELF до появления ACP reader.
 * Единый бюджет запуска равен verify: 120 с; один id сохраняется без повторной отправки initialize.
 */
export async function initializeDeepSeekAcp(client: AcpClient, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();

  return initializeAcp(client, 120_000);
}

/**
 * Неизвестный bridge contract запрещает запись до создания рабочей сессии.
 * Request отменяется host-ом; владелец процесса обязан закрыть частично изменённый запуск.
 */
export function acpDeepSeekSettingsRpc(client: AcpClient, initialized: unknown): DeepSeekSettingsRpc {
  const capability = (initialized as {
    agentCapabilities?: { _meta?: Record<string, { contract?: number }> };
  } | null)?.agentCapabilities?._meta?.['grigdesk.settings'];

  if (capability?.contract !== 1) {
    throw new Error('Приватный мост настроек ACP не подтверждён');
  }

  return {
    /**
     * Отмена прерывает ожидание mutation до prompt и освобождает listener запроса.
     * Закрытие частичного процесса остаётся обязанностью единственного владельца запуска.
     */
    async rpc(method, args = {}, timeoutMs = 10_000, signal) {
      if (!['settings/describe', 'settings/mutate'].includes(method)) {
        throw new Error('Метод не принадлежит private settings bridge');
      }

      signal?.throwIfAborted();

      let aborted: (() => void) | undefined;
      const cancellation = new Promise<never>((_resolve, reject) => {
        if (signal) {
          aborted = () => reject(signal.reason || new Error('Настройки ACP отменены'));
          signal.addEventListener('abort', aborted, { once: true });
        }
      });

      try {
        return await Promise.race([
          client.request(`_grigdesk/${method}`, args, timeoutMs), cancellation,
        ]);
      } finally {
        if (aborted) {
          signal?.removeEventListener('abort', aborted);
        }
      }
    },
  };
}

/**
 * Metadata-only процесс не открывает session и использует тот же launch document, что worker.
 * Stop ожидает освобождение stdio и locks; ошибки и отмена не оставляют reusable процесс.
 */
export async function startDeepSeekAcpSettings(options: {
  runtime: DeepSeekRuntimeDescriptor;
  overlayPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) {
  options.signal?.throwIfAborted();
  await verifyDeepSeekRuntimeDescriptorAsync(options.runtime);
  options.signal?.throwIfAborted();

  const args = [
    ...options.runtime.prefixArgs, '--profile', 'acp', '--patch', options.overlayPath,
  ];
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  const owned = options.runtime.kind === 'binary'
    ? spawnDeepSeekBinary(options.runtime.command, args, spawnOptions) : null;
  const child = owned?.child ?? spawn(options.runtime.command, args, spawnOptions);
  const client = createAcpClient(child, { requestTimeoutMs: 15_000 });
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });

  // stderr ограничивается pipe, но не публикуется: он может содержать внутренние значения.
  child.stderr?.resume();

  /**
   * Binary owner подтверждает завершение раньше EOF, исключая повторный TERM worker.
   * Client закрывается и при cleanup отказе; исход владельца остаётся видимым caller.
   */
  const stop = async () => {
    if (owned) {
      try {
        await owned.stop();
      } finally {
        client.close();
      }

      return;
    }

    client.close();

    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');

      const timeout = setTimeout(() => child.kill('SIGKILL'), 4_000);

      await exit;
      clearTimeout(timeout);
    }
  };
  const abort = () => void stop().catch(() => {});

  options.signal?.addEventListener('abort', abort, { once: true });

  if (options.signal?.aborted) {
    abort();
  }

  try {
    const initialized = await initializeDeepSeekAcp(client, options.signal);
    const rpc = acpDeepSeekSettingsRpc(client, initialized);

    return {
      client: rpc,
      stop: async () => {
        options.signal?.removeEventListener('abort', abort);
        await stop();
      },
    };
  } catch (error) {
    options.signal?.removeEventListener('abort', abort);

    try {
      await stop();
    } catch (cleanup) {
      throw combineDeepSeekCleanupFailure(error, cleanup);
    }

    throw error;
  }
}
