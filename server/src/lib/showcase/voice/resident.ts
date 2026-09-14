// Резидентный процесс голосового движка: одна модель на всё задание.
//
// Скрипт синтеза поднимает модель один раз и дальше читает запросы построчно —
// JSON на строку — и на каждый отвечает одной строкой JSON с тем же `id`.
// Реплики уходят на stdin, как и в одноразовом режиме: в командной строке им не
// место. Запросы идут по одному: движок и так синтезирует последовательно, а
// очередь проще разбора ответов вперемешку.
//
// Чужие строки stdout ответом не считаются — библиотеки печатают предупреждения
// при импорте, — ответ только JSON с полем `id`. Конец stdin — команда выйти:
// процесс не переживает задание, и между заданиями память свободна, как раньше.
import { spawn } from 'node:child_process';

import { ShowcaseError } from '../errors.ts';
import { VoiceProcessError } from './process.ts';

export interface ResidentReply<T> {
  id: string;
  results?: T[];
  error?: string;
  code?: string;
}

export interface ResidentRequestOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ResidentProcess {
  request<T>(
    payload: Record<string, unknown>,
    options: ResidentRequestOptions,
  ): Promise<ResidentReply<T>>;
  close(): Promise<void>;
}

interface Waiter {
  resolve: (reply: ResidentReply<unknown>) => void;
  reject: (error: Error) => void;
}

const STDERR_TAIL = 400;
const STDERR_KEEP = 4000;
const STDOUT_LINE_LIMIT = 1024 * 1024;

// Сколько ждать штатного выхода после закрытия stdin, прежде чем снять процесс:
// модель выгружается быстро, а зависший на выходе процесс держал бы видеопамять.
const CLOSE_GRACE_MS = 5000;

/**
 * Строка stdout как ответ движка: JSON-объект со строковым `id`. Всё остальное —
 * шум библиотек, и он пропускается молча.
 */
function parseReply(line: string): ResidentReply<unknown> | null {
  const trimmed = line.trim();

  if (!trimmed.startsWith('{')) {
    return null;
  }

  try {
    const value = JSON.parse(trimmed) as { id?: unknown };

    return typeof value.id === 'string' ? (value as ResidentReply<unknown>) : null;
  } catch {
    return null;
  }
}

export function startResident(command: string, args: string[]): ResidentProcess {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map<string, Waiter>();

  let pendingStdout = '';
  let stderr = '';
  let exited: { code: number | null; failure: ShowcaseError } | null = null;
  let counter = 0;
  let queue: Promise<unknown> = Promise.resolve();

  function rejectAll(error: Error): void {
    for (const waiter of [...waiting.values()]) {
      waiter.reject(error);
    }
  }

  child.stdout.on('data', (chunk: Buffer) => {
    pendingStdout += chunk.toString('utf8');

    const lines = pendingStdout.split('\n');

    pendingStdout = lines.pop() ?? '';

    if (pendingStdout.length > STDOUT_LINE_LIMIT) {
      exited = {
        code: null,
        failure: new ShowcaseError(
          'voice_failed',
          'Движок вернул слишком длинную строку ответа.',
          500,
        ),
      };
      rejectAll(exited.failure);
      child.kill('SIGKILL');

      return;
    }

    for (const line of lines) {
      if (line.length > STDOUT_LINE_LIMIT) {
        exited = {
          code: null,
          failure: new ShowcaseError(
            'voice_failed',
            'Движок вернул слишком длинную строку ответа.',
            500,
          ),
        };
        rejectAll(exited.failure);
        child.kill('SIGKILL');

        return;
      }

      const reply = parseReply(line);

      if (reply) {
        waiting.get(reply.id)?.resolve(reply);
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-STDERR_KEEP);
  });
  child.on('error', (error: Error) => {
    exited = {
      code: null,
      failure: new ShowcaseError('voice_failed', `Движок не запустился: ${error.message}`, 500),
    };
    rejectAll(exited.failure);
  });
  child.on('close', (code: number | null) => {
    if (!exited) {
      exited = {
        code,
        failure: new VoiceProcessError(
          `Движок завершился с кодом ${code}: ${stderr.trim().slice(-STDERR_TAIL)}`,
          code,
        ),
      };
    }

    rejectAll(exited.failure);
  });
  child.stdin.on('error', () => {
    // Движок мог выйти раньше, чем дочитал запрос: это его отказ, и он придёт
    // кодом возврата — ронять из-за EPIPE нечего.
  });

  /**
   * Один запрос: строка на stdin и ожидание строки с тем же `id`. Срок и отмена
   * снимают процесс целиком — недописанный ответ всё равно негоден, а следующий
   * запрос получит отказ по коду выхода.
   */
  function send<T>(
    payload: Record<string, unknown>,
    options: ResidentRequestOptions,
  ): Promise<ResidentReply<T>> {
    return new Promise((resolve, reject) => {
      if (exited) {
        reject(exited.failure);

        return;
      }

      counter += 1;

      const id = String(counter);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (outcome: () => void): void => {
        if (!waiting.has(id)) {
          return;
        }

        waiting.delete(id);
        if (timer) {
          clearTimeout(timer);
        }
        options.signal?.removeEventListener('abort', onAbort);
        outcome();
      };
      const stop = (reason: string): void => {
        settle(() => reject(new ShowcaseError('voice_failed', reason, 504)));
        child.kill('SIGKILL');
      };
      waiting.set(id, {
        resolve: (reply) => settle(() => resolve(reply as ResidentReply<T>)),
        reject: (error) => settle(() => reject(error)),
      });
      timer = setTimeout(() => {
        stop(`Движок не ответил за ${Math.round(options.timeoutMs / 1000)} с.`);
      }, options.timeoutMs);
      const onAbort = (): void => {
        stop('Синтез отменён.');
      };

      if (options.signal?.aborted) {
        onAbort();

        return;
      }

      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, 'utf8');
    });
  }

  function request<T>(
    payload: Record<string, unknown>,
    options: ResidentRequestOptions,
  ): Promise<ResidentReply<T>> {
    const own = queue.then(() => send<T>(payload, options));

    queue = own.catch(() => null);

    return own;
  }

  /**
   * Штатное завершение: stdin закрывается, движок доделывает и выходит сам. Не
   * вышел за отведённое время — снимается: висящий процесс держал бы память.
   */
  async function close(): Promise<void> {
    if (exited) {
      return;
    }

    await queue;

    if (exited) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, CLOSE_GRACE_MS);

      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  }

  return { request, close };
}
