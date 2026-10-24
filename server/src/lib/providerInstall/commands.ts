import { constants, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ExecutorAdapter, ProviderInstallCommand } from '../executors/index.ts';
import { nodeExecutable, runtimeKind } from '../runtimePaths.ts';

interface InstallRuntimePaths {
  kind: string;
  node: string;
}

const execute = promisify(execFile);

/**
 * Только исполняемый файл из абсолютного пользовательского PATH считается npm.
 * Собственный npm packaged-поставки не предназначен для глобальных установок CLI.
 */
export async function findProviderNpm(env: NodeJS.ProcessEnv,
  runtime?: InstallRuntimePaths): Promise<string | null> {
  const paths = runtime || { kind: runtimeKind(), node: nodeExecutable() };

  for (const directory of (env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)
      || (paths.kind === 'packaged' && path.resolve(directory) === path.dirname(paths.node))) {
      continue;
    }

    const candidate = path.join(directory, 'npm');
    const executable = await fs.stat(candidate).then((stat) => stat.isFile(), () => false)
      && await fs.access(candidate, constants.X_OK).then(() => true, () => false);

    if (executable) {
      return candidate;
    }
  }

  return null;
}

/**
 * Карточка и запуск операции получают один способ выбора команды из адаптера.
 * Проверка повторяется при старте: npm мог появиться или исчезнуть после чтения карточки.
 */
export async function resolveProviderInstallation(adapter: ExecutorAdapter, config: unknown,
  env: NodeJS.ProcessEnv, runtime?: InstallRuntimePaths) {
  if (!adapter.installation) {
    return undefined;
  }

  return adapter.installation(config, { npm: await findProviderNpm(env, runtime) });
}

/**
 * Установка latest одинаково подходит первой установке и явному обновлению CLI.
 * Вход в аккаунт остаётся отдельным действием и не запускается вместе с npm.
 */
export function npmInstallCommand(packageId: string, executable: string,
  npmBinding: NonNullable<ProviderInstallCommand['npmBinding']>): ProviderInstallCommand {
  const target = `${packageId}@latest`;
  const command = `npm i -g ${target}`;

  return {
    executable,
    args: ['i', '-g', target],
    command,
    fallbackCommand: command,
    npmBinding,
  };
}

/**
 * Путь берётся у того же npm с тем же окружением, который установил пакет.
 * Сохраняется ссылка prefix/bin, чтобы следующий npm update мог заменить её цель.
 */
export async function installedNpmBinary(executable: string, binName: string,
  env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  const { stdout } = await execute(executable, ['prefix', '-g'], {
    env,
    signal,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const prefix = stdout.trim();

  if (!path.isAbsolute(prefix) || !binName || path.basename(binName) !== binName) {
    throw new Error('npm вернул недопустимый путь установки CLI');
  }

  const binary = path.join(prefix, 'bin', binName);
  const stat = await fs.stat(binary);

  if (!stat.isFile()) {
    throw new Error('В npm prefix отсутствует исполняемый файл CLI');
  }

  await fs.access(binary, constants.X_OK);

  return binary;
}
