import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { VoiceError } from './contract.ts';

export interface ProcessOptions {
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export type RunProcess = (
  command: string,
  args: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

const STDOUT_BYTES = 1024 * 1024;
const STDERR_BYTES = 64 * 1024;

/**
 * Хранит только хвост потока: pip и Python не могут бесконечно наращивать память.
 * Последняя строка JSON остаётся доступной после завершения синтеза.
 */
function appendTail(previous: Buffer, chunk: Buffer, limit: number): Buffer {
  if (chunk.length >= limit) {
    return Buffer.from(chunk.subarray(chunk.length - limit));
  }

  const keep = Math.min(previous.length, limit - chunk.length);

  return Buffer.concat([previous.subarray(previous.length - keep), chunk]);
}

/**
 * Передаёт текст на stdin и обязательно закрывает поток; async execFile(input)
 * этого не делает. Отмена и срок завершаются лишь после close собственного ребёнка.
 */
export const runWithStdin: RunProcess = async (command, args, options) => {
  if (options.signal?.aborted) {
    throw new VoiceError('Операция отменена.');
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new VoiceError('Срок дочернего процесса должен быть положительным.', 2);
  }

  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;

    try {
      child = spawn(command, [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform === 'linux',
      });
    } catch {
      reject(new VoiceError('Не удалось запустить дочерний процесс.'));

      return;
    }

    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let failure: VoiceError | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Завершает только собственную группу процессов после отмены или срока.
     * Promise будет отклонён после close, когда ребёнок больше не пишет файлы.
     */
    const stop = (message: string): void => {
      failure ??= new VoiceError(message);

      if (process.platform === 'linux' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
    };
    const onAbort = (): void => {
      stop('Операция отменена.');
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk, STDOUT_BYTES);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk, STDERR_BYTES);
    });
    child.stdin.on('error', () => {
      // Раннее закрытие stdin даёт собственный exit/error ребёнка; EPIPE не роняет CLI.
    });
    child.on('error', () => {
      failure ??= new VoiceError('Не удалось запустить дочерний процесс.');
    });
    child.once('close', (code: number | null) => {
      if (timer) {
        clearTimeout(timer);
      }

      options.signal?.removeEventListener('abort', onAbort);

      if (failure) {
        reject(failure);

        return;
      }

      if (code !== 0) {
        reject(new VoiceError(`Дочерний процесс завершился с кодом ${code ?? 'нет'}.`));

        return;
      }

      resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });

    timer = setTimeout(() => {
      stop('Истёк срок дочернего процесса.');
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    if (options.signal?.aborted) {
      onAbort();
    } else {
      child.stdin.end(options.input ?? '', 'utf8');
    }
  });
};
