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

/**
 * Отказ движка с кодом выхода. Код нужен адаптеру: у скрипта синтеза бывают
 * причины со своим действием — нехватка видеопамяти, невидимая видеокарта, — и
 * называть их по хвосту трассировки было бы гаданием.
 */
export class VoiceProcessError extends ShowcaseError {
  exitCode: number | null;

  constructor(message: string, exitCode: number | null) {
    super('voice_failed', message, 500);
    this.name = 'VoiceProcessError';
    this.exitCode = exitCode;
  }
}

const STDERR_TAIL = 400;
const OUTPUT_KEEP = 1024 * 1024;

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
    let stopError: ShowcaseError | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      options.signal?.removeEventListener('abort', onAbort);
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    // Срок и отмена ведут к одному действию — снять процесс, — но причины у них
    // разные, и человек должен видеть свою. Promise завершается только после
    // `close`: вызывающий код не считает память освобождённой раньше процесса.
    const stop = (reason: string): void => {
      if (settled || stopError) {
        return;
      }

      stopError = new ShowcaseError('voice_failed', reason, 504);
      cleanup();
      child.kill('SIGKILL');
    };

    const onAbort = (): void => {
      stop('Синтез отменён.');
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-OUTPUT_KEEP);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-OUTPUT_KEEP);
    });
    child.on('error', (error: Error) => {
      fail(stopError ?? new ShowcaseError(
        'voice_failed',
        `Движок не запустился: ${error.message}`,
        500,
      ));
    });
    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (stopError) {
        reject(stopError);

        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });

        return;
      }

      reject(new VoiceProcessError(
        `Движок завершился с кодом ${code}: ${stderr.trim().slice(-STDERR_TAIL)}`,
        code,
      ));
    });

    child.stdin.on('error', () => {
      // Движок мог закрыть stdin раньше, чем дочитал реплику: это его отказ, и
      // он придёт кодом возврата — ронять из-за EPIPE нечего.
    });

    timer = setTimeout(() => {
      stop(`Движок не ответил за ${Math.round(options.timeoutMs / 1000)} с.`);
    }, options.timeoutMs);

    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdin.end(options.input, 'utf8');
    }
  });
}
