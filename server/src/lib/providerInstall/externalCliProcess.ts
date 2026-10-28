import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { USER_CLI_PARENT_KEY } from '../../../../shared/node/userCliParentEnvironment.ts';
import { helperCommand } from '../runtimePaths.ts';

export interface ExternalCliProcessContext {
  providerId: string;
  executable: string;
  executableIdentity?: string;
  resourceKey: string;
  leaseDirectory: string;
  env: NodeJS.ProcessEnv;
}

const contexts = new AsyncLocalStorage<ExternalCliProcessContext>();

/**
 * Runtime учитывает выбранную программу и окружение, включая маршрут авторизации.
 * Наружу выходит только внутренний хеш: значения окружения не попадают в журнал или handle.
 */
export function externalCliProcessFingerprint(): string {
  const context = contexts.getStore();

  return context ? createHash('sha256').update(JSON.stringify([
    context.executableIdentity,
    context.resourceKey,
    Object.entries(context.env).sort(([left], [right]) => left.localeCompare(right)),
  ])).digest('hex') : '';
}

/**
 * Контекст принадлежит серверной подготовке адаптера и распространяется только на её async-вызовы.
 * Посторонний и managed запуск не наследует чужой выбор CLI из соседнего запроса.
 */
export function withExternalCliProcess<T>(context: ExternalCliProcessContext, action: () => T): T {
  return contexts.run(context, action);
}

/**
 * Shell exports составляют базу, а явно изменённые адаптером значения — защитный overlay.
 * Копия process.env не возвращает packaged PATH/prefix поверх пользовательской среды.
 */
function launchEnvironment(context: ExternalCliProcessContext, supplied: unknown): NodeJS.ProcessEnv {
  const env = { ...context.env };

  if (isRecord(supplied)) {
    for (const [key, value] of Object.entries(supplied)) {
      if (value !== process.env[key] && (typeof value === 'string' || value === undefined)) {
        env[key] = value;
      }
    }
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(supplied, key)) {
        delete env[key];
      }
    }
  }

  delete env[USER_CLI_PARENT_KEY];
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;

  return env;
}

/**
 * Только подготовленный executable получает helper и reader; другие children не меняются.
 * Стандартные overloads spawn/execFile сохраняются, shell-команд и пользовательских wrappers нет.
 */
function launchArguments(file: string, rest: unknown[], mode: 'spawn' | 'execFile' = 'spawn'): unknown[] {
  const context = contexts.getStore();

  if (!context || file !== context.executable) {
    return [file, ...rest];
  }

  const hasArgs = Array.isArray(rest[0]);
  const args = hasArgs ? rest[0] as string[] : [];
  const index = hasArgs ? 1 : 0;
  const options = isRecord(rest[index]) ? rest[index] : {};
  const tail = rest.slice(index + (isRecord(rest[index]) ? 1 : 0));
  const helper = helperCommand('external-cli-lease', [
    ...(context.executableIdentity ? ['--identity', context.executableIdentity] : []),
    '--lease-dir', context.leaseDirectory,
    '--provider', context.providerId,
    '--resource', context.resourceKey,
    '--', file, ...args,
  ]);

  // execFile не переносит detached в свой spawn; setsid создаёт тот же session scope без shell.
  const executable = mode === 'execFile' ? '/usr/bin/setsid' : helper.command;
  const helperArgs = mode === 'execFile' ? [helper.command, ...helper.args] : helper.args;

  return [executable, helperArgs, {
    ...options,
    env: launchEnvironment(context, options.env),
    detached: true,
  }, ...tail];
}

/**
 * Отмена относится ко всей собственной группе helper-а, включая SIGKILL без signal handler.
 * Без этого timeout убивал бы только посредника, оставляя CLI и reader живыми навсегда.
 */
function ownGroup<T extends ChildProcess>(file: string, child: T): T {
  if (contexts.getStore()?.executable !== file) {
    return child;
  }

  const original = child.kill.bind(child);

  child.kill = (signal = 'SIGTERM') => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // До setsid своей группы ещё может не быть: ниже действует обычная отмена child.
      }
    }

    return original(signal);
  };

  return child;
}

export const spawn = ((file: string, ...rest: unknown[]) =>
  ownGroup(file, Reflect.apply(nodeSpawn, undefined, launchArguments(file, rest)))) as typeof nodeSpawn;
export const execFile = ((file: string, ...rest: unknown[]) => ownGroup(file,
  Reflect.apply(nodeExecFile, undefined, launchArguments(file, rest, 'execFile')))) as typeof nodeExecFile;

Object.defineProperty(execFile, promisify.custom, {
  value: (file: string, ...rest: unknown[]) => {
    const promise = Reflect.apply(promisify(nodeExecFile), undefined,
      launchArguments(file, rest, 'execFile')) as Promise<unknown> & { child: ChildProcess };

    ownGroup(file, promise.child);

    return promise;
  },
});
