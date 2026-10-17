import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface ProcessOptions {
  env: Record<string, string>;
  input?: Uint8Array | string;
  cwd?: string;
  timeoutMs?: number;
}

export const SOURCE_MAIN = fileURLToPath(new URL('../../../b24/src/main.ts', import.meta.url));

/**
 * Запускает исполняемый файл асинхронно и собирает оба потока как Buffer.
 * Ненулевой код возвращается в результате; зависший ребёнок убивается по сроку.
 */
export async function runProcess(
  t: TestContext,
  executable: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const child = spawn(executable, [...args], {
    cwd: options.cwd ?? '/',
    env: options.env,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });

  const done = new Promise<ProcessResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
  });

  if (options.input !== undefined) {
    child.stdin?.end(options.input);
  }

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, options.timeoutMs ?? 10000);

  try {
    return await done;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Синтетическая домашняя папка под TMPDIR сторожа; удаление не требуется вне сторожа.
 * Возвращает HOME и COCKPIT_HOME, которые передаются ребёнку явно.
 */
export async function syntheticHome(): Promise<{ home: string; data: string }> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'b24-home-'));

  return {
    home,
    data: path.join(home, '.cockpit'),
  };
}

/**
 * Окружение ребёнка по белому списку: без COCKPIT_TOKEN, прокси и NODE_OPTIONS хоста.
 * Пустые overrides сохраняются как заданные ключи.
 */
export function childEnv(home: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    COCKPIT_HOME: path.join(home, '.cockpit'),
    PATH: '/usr/bin:/bin',
    ...overrides,
  };
}
