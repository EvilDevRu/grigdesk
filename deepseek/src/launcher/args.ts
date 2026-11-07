import path from 'node:path';

export interface LauncherArguments {
  mode: 'run' | 'help' | 'version' | 'license' | 'runtime-info' | 'verify';
  json: boolean;
  cacheDir: string | null;
  expectedPackageId: string | null;
  harnessArgs: string[];
}

const modes: Readonly<Record<string, LauncherArguments['mode']>> = {
  '--help': 'help',
  '-V': 'version',
  '--version': 'version',
  '--license': 'license',
  '--runtime-info': 'runtime-info',
  '--verify': 'verify',
};

export class LauncherArgumentError extends Error {
  readonly code = 'deepseek_arguments_invalid';
  readonly metadata: boolean;

  constructor(message: string, metadata: boolean) {
    super(message);

    this.metadata = metadata;
  }
}

/**
 * Разбирает только префикс launcher перед первым аргументом Harness.
 * Файловая система и окружение не участвуют в этом контракте.
 */
export function parseLauncherArgs(args: readonly string[]): LauncherArguments {
  const result: LauncherArguments = {
    mode: 'run',
    json: false,
    cacheDir: null,
    expectedPackageId: null,
    harnessArgs: [],
  };
  const seen = new Set<string>();
  let problem: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    const mode = Object.hasOwn(modes, flag) ? modes[flag] : undefined;

    if (!mode && flag !== '--json' && flag !== '--cache-dir' && flag !== '--expect-package-id') {
      result.harnessArgs = args.slice(index);

      break;
    }

    const key = mode ? 'mode' : flag;

    if (seen.has(key)) {
      problem ??= 'Флаги launcher повторяются или выбирают несколько режимов';
    }

    seen.add(key);

    if (flag === '--cache-dir' || flag === '--expect-package-id') {
      const value = args[index + 1];

      if (value === undefined || value.startsWith('-')) {
        problem ??= 'У флага launcher отсутствует значение';

        continue;
      }

      if (flag === '--cache-dir') {
        result.cacheDir = value;
      } else {
        result.expectedPackageId = value;
      }

      index += 1;
    } else if (flag === '--json') {
      result.json = true;
    } else if (mode) {
      result.mode = mode;
    }
  }

  const metadata = result.mode !== 'run' || result.json;
  const jsonMode = result.mode === 'runtime-info' || result.mode === 'verify';

  if (result.cacheDir !== null && !path.isAbsolute(result.cacheDir)) {
    problem ??= '--cache-dir требует абсолютный путь';
  }

  if (result.expectedPackageId !== null && !/^[a-f0-9]{64}$/u.test(result.expectedPackageId)) {
    problem ??= '--expect-package-id требует полный SHA256';
  }

  if (metadata && result.harnessArgs.length > 0) {
    problem ??= 'Metadata-режим несовместим с аргументами Harness';
  }

  if (result.json !== jsonMode) {
    problem ??= '--json требуется только вместе с --runtime-info или --verify';
  }

  if (problem) {
    throw new LauncherArgumentError(problem, metadata);
  }

  return result;
}

/**
 * Формирует отказ для единственной точки записи stdout/stderr в launcher.
 * Сырые ошибки и пользовательское окружение не включаются в диагностику.
 */
export function launcherFailure(error: unknown, metadata = false): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const argumentError = error instanceof LauncherArgumentError;
  const diagnostic = {
    code: argumentError ? error.code : 'deepseek_launcher_failed',
    message: argumentError ? error.message : 'Не удалось запустить DeepSeek',
  };
  const json = metadata || (argumentError && error.metadata);

  return {
    exitCode: argumentError ? 2 : 1,
    stdout: '',
    stderr: `${json ? JSON.stringify(diagnostic) : diagnostic.message}\n`,
  };
}

