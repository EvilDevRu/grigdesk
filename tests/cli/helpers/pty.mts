import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

interface PtyResult {
  code: number;
  before: unknown;
  after: unknown;
  timedOut: boolean;
}

interface PtyOptions {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  columns?: number;
  rows?: number;
  inputTTY?: boolean;
  outputTTY?: boolean;
}

/**
 * Независимый Python-канал управляет настоящим PTY, не подменяя process.isTTY.
 * Весь вывод собирается сразу; cleanup касается только дерева этой фикстуры.
 */
export function startPty(t: TestContext, options: PtyOptions) {
  const child = spawn('python3', [fileURLToPath(new URL('./pty.py', import.meta.url))], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const decoder = new StringDecoder('utf8');
  let output = '';
  let errors = '';
  let pending = '';
  let result: PtyResult | undefined;
  let childPid = 0;
  let helperClosed = false;
  let settle: (value: PtyResult) => void;
  let reject: (error: Error) => void;
  const done = new Promise<PtyResult>((resolve, fail) => {
    settle = resolve;
    reject = fail;
  });
  const send = (value: object) => {
    if (!child.stdin.destroyed && !helperClosed) {
      child.stdin.write(JSON.stringify(value) + '\n');
    }
  };

  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') {
      reject(error);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  child.stdout.on('data', (chunk: Buffer) => {
    pending += chunk.toString();

    while (pending.includes('\n')) {
      const index = pending.indexOf('\n');
      const event = JSON.parse(pending.slice(0, index));

      pending = pending.slice(index + 1);

      if (event.output) {
        output += decoder.write(Buffer.from(event.output, 'base64'));
      }

      if (event.pid) {
        childPid = event.pid;
      }

      if ('code' in event) {
        output += decoder.end();
        result = event;
        settle(event);
      }
    }
  });
  child.once('error', (error) => reject(error));
  child.once('close', () => {
    helperClosed = true;

    if (!result) {
      reject(new Error(`PTY не вернул результат: ${errors}\n${output}`));
    }
  });
  // Отклонение уже наблюдается, даже если assertion прервёт тест до ожидания done.
  void done.catch(() => undefined);
  send({
    argv: options.argv,
    cwd: options.cwd ?? '/',
    env: options.env,
    columns: options.columns ?? 100,
    rows: options.rows ?? 24,
    inputTTY: options.inputTTY ?? true,
    outputTTY: options.outputTTY ?? true,
  });
  t.after(async () => {
    send({ close: true });
    child.stdin.end();

    if (!helperClosed) {
      await new Promise<void>((resolve) => child.once('close', () => resolve()));
    }
  });

  return {
    output: () => output,
    finished: () => result !== undefined,
    pid: () => childPid,
    done,
    write: (value: string) => send({ write: Buffer.from(value).toString('base64') }),
    resize: (columns: number) => send({ resize: columns }),
    signal: (name: string) => send({ signal: name }),
    /**
     * Ждёт наблюдаемую строку до срока, завершаясь сразу при раннем выходе CLI.
     * Ошибка называет недостающее поведение, а не таймаут внешнего сервиса.
     */
    async wait(pattern: RegExp, timeout = 4000, from = 0) {
      const end = Date.now() + timeout;

      while (!pattern.test(output.slice(from)) && !result && Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }

      assert.match(output.slice(from), pattern, `Не появился ожидаемый экран CLI: ${errors}`);
    },
  };
}

/**
 * Сравнивает настройки до cleanup; восстановление фикстурой не засчитывается.
 * Если курсор скрывался, последнее управление видимостью должно его показать.
 */
export function assertRestored(result: PtyResult, output: string) {
  assert.equal(result.timedOut, false, output);
  assert.deepEqual(result.after, result.before, 'CLI оставил изменённый termios');

  if (output.includes('\x1b[?25l')) {
    assert.ok(output.lastIndexOf('\x1b[?25h') > output.lastIndexOf('\x1b[?25l'), 'Курсор скрыт');
  }
}
