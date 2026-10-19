import { execFile } from 'node:child_process';

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export interface CommandResult {
  code: number;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: string[], options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
}) => Promise<CommandResult>;

/**
 * Разбирает строгую стабильную версию для плагинов и source-релизов.
 * Общий модуль не создаёт сервис обновления и не читает git либо его состояние.
 */
export function parseSemVer(value: unknown): SemVer | null {
  const match = VERSION_RE.exec(String(value || '').trim());

  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Сравнивает уже разобранные версии либо строки по прежнему правилу source updater.
 * Ошибка формата остаётся явным отказом вызывающего кода, без подстановки версии.
 */
export function compareSemVer(left: string | SemVer | null, right: string | SemVer | null): number {
  const a = typeof left === 'string' ? parseSemVer(left) : left;
  const b = typeof right === 'string' ? parseSemVer(right) : right;

  if (!a || !b) {
    throw new TypeError('Ожидалась строгая SemVer-версия');
  }

  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Отделяет стабильный v-тег от произвольного git ref и prerelease.
 * Тот же разбор нужен источникам плагинов без импорта source updater в SEA.
 */
export function parseStableTag(value: unknown): string | null {
  const match = TAG_RE.exec(String(value || '').trim());

  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export const defaultCommandRunner: CommandRunner = (file, args, options = {}) => (
  new Promise<CommandResult>((resolve) => {
    execFile(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 10_000,
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout = '', stderr = '') => {
      resolve({
        code: error ? (Number.isInteger(error.code) ? Number(error.code) : 1) : 0,
        signal: error?.signal || null,
        timedOut: !!error?.killed,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  })
);
