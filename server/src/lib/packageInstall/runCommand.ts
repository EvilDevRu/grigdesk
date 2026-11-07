import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import { helperCommand } from '../runtimePaths.ts';
import { liveGroupMembers } from './workerIdentity.ts';

export interface PluginCommandResult {
  code: number;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  workspaceLimitExceeded: boolean;
}

export interface PluginWorkspaceBudget {
  root: string;
  maxBytes: number;
  minFreeBytes: number;
  checkIntervalMs: number;
}

export interface CommandWorker {
  commandId: string;
  supervisorPid: number;
  supervisorStartTime: string;
  pid: number;
  pgid: number;
  startTime: string;
}

export interface CommandOwnership {
  started(worker: CommandWorker): Promise<void>;
  finished(commandId: string): Promise<void>;
}

export interface PluginCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  ownership?: CommandOwnership;
  workspaceBudget?: PluginWorkspaceBudget;
}

export type PluginCommandRunner = (
  file: string,
  args: string[],
  options: PluginCommandOptions,
) => Promise<PluginCommandResult>;

const OUTPUT_LIMIT = 256 * 1024;

/**
 * Буфер хранит ограниченный хвост каждого потока отдельно от callback.
 * При декодировании отрезанная начальная часть UTF-8 символа не даёт битое имя.
 */
class OutputTail {
  private buffer = Buffer.alloc(0);
  truncated = false;

  append(chunk: Buffer): void {
    const next = Buffer.concat([this.buffer, chunk]);

    this.truncated ||= next.length > OUTPUT_LIMIT;
    this.buffer = next.subarray(Math.max(0, next.length - OUTPUT_LIMIT));
  }

  text(): string {
    let start = 0;

    while (start < this.buffer.length && ((this.buffer[start] ?? 0) & 0xc0) === 0x80) {
      start += 1;
    }

    return this.buffer.subarray(start).toString('utf8');
  }
}

/**
 * Полная форма результата нужна и отказу до spawn, и завершившейся команде.
 * Отсутствие процесса не теряет обязательные flags публичного контракта.
 */
function emptyResult(): PluginCommandResult {
  return {
    code: 130,
    signal: null,
    timedOut: false,
    aborted: true,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    workspaceLimitExceeded: false,
  };
}

/**
 * Команда запускается gated leader после устойчивой регистрации identity.
 * Ошибка callback или ownership останавливает свою группу и не бросает Promise наружу.
 */
export const runCommand: PluginCommandRunner = (file, args, options) => new Promise((resolve) => {
  if (options.signal?.aborted) {
    resolve(emptyResult());

    return;
  }

  const supervisor = helperCommand('plugin-command-supervisor', []);
  const child = fork(supervisor.args[0]!, [], {
    execPath: supervisor.command,
    env: { PATH: '/usr/bin:/bin' },
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const commandId = randomUUID();
  const stdout = new OutputTail();
  const stderr = new OutputTail();
  const decoder = new StringDecoder('utf8');
  const stdoutDecoder = new StringDecoder('utf8');
  let aborted = false;
  let timedOut = false;
  let failed = false;
  let resultCode = 1;
  let resultSignal: string | null = null;
  let registered = false;
  let worker: CommandWorker | null = null;
  let confirmed = false;
  let workspaceLimitExceeded = false;
  let registration: Promise<void> = Promise.resolve();

  const stop = () => {
    if (child.connected) {
      child.send({ type: 'stop' }, () => {});
    }
  };
  const onAbort = () => {
    aborted = true;
    stop();
  };
  /**
   * Чужой callback не может бросить из обработчика потока и оставить writer живым.
   * Диагностика callback остаётся за безопасной границей результата.
   */
  const deliver = (chunk: string, callback: ((chunk: string) => void) | undefined) => {
    try {
      callback?.(chunk);
    } catch {
      failed = true;
      stop();
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);

  options.signal?.addEventListener('abort', onAbort, { once: true });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.append(chunk);
    deliver(stdoutDecoder.write(chunk), options.onStdout);
  });
  child.stdout?.once('end', () => {
    const tail = stdoutDecoder.end();

    if (tail) {
      deliver(tail, options.onStdout);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.append(chunk);
    deliver(decoder.write(chunk), options.onStderr);
  });
  child.stderr?.once('end', () => {
    const tail = decoder.end();

    if (tail) {
      deliver(tail, options.onStderr);
    }
  });
  child.on('message', (raw) => {
    const message = raw as {
      type: string;
      worker?: CommandWorker;
      code?: number;
      signal?: string | null;
      workspaceLimitExceeded?: boolean;
    };

    if (message.type === 'worker' && message.worker) {
      worker = message.worker;

      const startedWorker = worker;

      registration = Promise.resolve().then(async () => {
        try {
          await options.ownership?.started(startedWorker);
          registered = true;

          if (!aborted && !timedOut && !failed && child.connected) {
            child.send({
              type: 'ack',
              command: {
                file,
                args,
                cwd: options.cwd,
                env: options.env ?? process.env,
              },
            }, () => {});
          } else {
            stop();
          }
        } catch {
          failed = true;
          stop();
        }
      });
    } else if (message.type === 'result') {
      confirmed = true;
      resultCode = message.code ?? 1;
      resultSignal = message.signal ?? null;
      workspaceLimitExceeded = message.workspaceLimitExceeded === true;
    }
  });
  child.once('error', () => {
    failed = true;
    stderr.append(Buffer.from('Не удалось запустить supervisor.'));
  });
  child.once('close', async () => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);

    await registration;

    try {
      confirmed &&= worker === null || (await liveGroupMembers(worker.pgid)).length === 0;
    } catch {
      confirmed = false;
    }

    if (!confirmed) {
      failed = true;
    }

    if (registered && confirmed) {
      try {
        await options.ownership?.finished(commandId);
      } catch {
        failed = true;
      }
    }

    resolve({
      code: failed ? 1 : resultCode,
      signal: resultSignal,
      timedOut,
      aborted,
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      workspaceLimitExceeded,
    });
  });
  child.send({
    type: 'start',
    commandId,
    workspaceBudget: options.workspaceBudget,
  }, () => {});
});
