// Запуск голосового движка с текстом на stdin.
//
// Отдельный помощник появился по найденной причине: асинхронный `execFile`
// принимает поле `input` молча и НЕ передаёт его — процесс остаётся ждать stdin,
// а синтез выглядит как зависший движок вплоть до срока. Поэтому здесь spawn,
// явная запись реплики и закрытие потока.
//
// Реплика уходит именно на stdin, а не аргументом: её пишут человек и модель, и
// в командной строке ей не место.
import { spawn } from 'node:child_process';

import { ShowcaseError } from '../errors.ts';

export interface SpeakOptions {
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SpeakResult {
  stdout: string;
  stderr: string;
}

const STDERR_TAIL = 400;

export function runWithStdin(
  command: string,
  args: string[],
  options: SpeakOptions,
): Promise<SpeakResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    // Срок и отмена ведут к одному действию — снять процесс, — но причины у них
    // разные, и человек должен видеть свою.
    const stop = (reason: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill('SIGKILL');
      reject(new ShowcaseError('voice_failed', reason, 504));
    };

    const timer = setTimeout(() => {
      stop(`Движок не ответил за ${Math.round(options.timeoutMs / 1000)} с.`);
    }, options.timeoutMs);
    const onAbort = (): void => {
      stop('Синтез отменён.');
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new ShowcaseError('voice_failed', `Движок не запустился: ${error.message}`, 500));
    });
    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);

      if (code === 0) {
        resolve({ stdout, stderr });

        return;
      }

      reject(new ShowcaseError(
        'voice_failed',
        `Движок завершился с кодом ${code}: ${stderr.trim().slice(-STDERR_TAIL)}`,
        500,
      ));
    });

    child.stdin.on('error', () => {
      // Движок мог закрыть stdin раньше, чем дочитал реплику: это его отказ, и
      // он придёт кодом возврата — ронять из-за EPIPE нечего.
    });
    child.stdin.end(options.input, 'utf8');
  });
}
