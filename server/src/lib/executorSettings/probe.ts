// Probe владеет отдельным процессом и ограничивает только его время и вывод.
// Ошибки не включают stdout/stderr или приватные ответы протокола.

import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SettingsStdioProbe {
  send(message: unknown): void;
  request(
    message: unknown,
    matches: (response: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>>;
}

/**
 * Версия источника публикуется только как распознанный номер CLI.
 * Произвольный stdout и текст ошибки команды не становятся метаданными каталога.
 */
export async function readSettingsCliVersion(bin: string, signal: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], {
      signal,
      timeout: 2000,
      maxBuffer: 16_384,
      killSignal: 'SIGKILL',
    });

    return stdout.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/)?.[1] ?? null;
  } catch {
    signal.throwIfAborted();

    return null;
  }
}

/**
 * Cleanup ждёт завершения собственного child после TERM, затем использует KILL.
 * Вывод и запросы ограничены независимо от того, завершился ли initialize.
 */
async function stopProbe(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  child.kill('SIGTERM');

  const timer = setTimeout(() => child.kill('SIGKILL'), 750);

  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Адаптер задаёт только wire-envelope и сопоставление ответа, а не собственную
 * копию жизненного цикла процесса. При abort следующий probe начинает чистый процесс.
 */
export async function withSettingsStdioProbe<T>(
  options: {
    bin: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    signal: AbortSignal;
  },
  work: (probe: SettingsStdioProbe) => Promise<T>,
): Promise<T> {
  options.signal.throwIfAborted();

  const child = spawn(options.bin, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let bytes = 0;
  let failed: Error | undefined;
  const pending = new Set<{
    matches: (value: Record<string, unknown>) => boolean;
    resolve(value: Record<string, unknown>): void;
    reject(error: Error): void;
  }>();
  const fail = () => {
    failed = new Error('Probe настроек завершился без корректного ответа');

    for (const request of pending) {
      request.reject(failed);
    }

    pending.clear();
  };
  const abort = () => {
    fail();
    child.kill('SIGTERM');
  };

  options.signal.addEventListener('abort', abort, { once: true });
  child.once('error', fail);
  child.once('exit', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.byteLength;
    buffer += chunk.toString();

    if (bytes > 8_388_608 || buffer.length > 2_097_152) {
      abort();

      return;
    }

    let newline = buffer.indexOf('\n');

    while (newline !== -1) {
      const line = buffer.slice(0, newline);

      buffer = buffer.slice(newline + 1);

      let value: Record<string, unknown>;

      try {
        value = JSON.parse(line);
      } catch {
        fail();

        return;
      }

      for (const request of pending) {
        if (value && request.matches(value)) {
          pending.delete(request);
          request.resolve(value);
          break;
        }
      }

      newline = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    bytes += chunk.byteLength;

    if (bytes > 8_388_608) {
      abort();
    }
  });

  const send = (message: unknown) => {
    options.signal.throwIfAborted();

    if (failed) {
      throw failed;
    }

    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  try {
    return await work({
      send,
      request(message, matches) {
        return new Promise((resolve, reject) => {
          const request = {
            matches,
            resolve,
            reject,
          };

          pending.add(request);

          try {
            send(message);
          } catch (error) {
            pending.delete(request);
            reject(error);
          }
        });
      },
    });
  } finally {
    options.signal.removeEventListener('abort', abort);
    fail();
    await stopProbe(child);
  }
}

/**
 * И локальный RPC, и фиксированный внешний URL читаются с общим пределом объёма.
 * Ссылки из схемы или браузера этот helper не разрешает самостоятельно.
 */
export async function readSettingsJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    throw new Error('Источник схемы недоступен');
  }

  const reader = response.body.getReader();
  let content = '';
  let bytes = 0;
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      bytes += value.byteLength;

      if (bytes > 2_097_152) {
        throw new Error('Источник схемы превысил предел объёма');
      }

      content += decoder.decode(value, { stream: true });
    }

    return JSON.parse(content + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
