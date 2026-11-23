import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { USER_CLI_PARENT_KEY } from '../../../../shared/node/userCliParentEnvironment.ts';
import { darwinSetsidPath } from '../../../../shared/node/processIdentity.ts';
import { applyAccessEnvironment } from '../accessProfiles/runtime.ts';
import { helperCommand, runtimeKind, runtimeRoot } from '../runtimePaths.ts';

export interface ExternalCliProcessContext {
  providerId: string;
  executable: string;
  executableIdentity?: string;
  resourceKey: string;
  leaseDirectory: string;
  env: NodeJS.ProcessEnv;
}

const contexts = new AsyncLocalStorage<ExternalCliProcessContext>();
const leaseJobs = new AsyncLocalStorage<string>();

export interface GraphLaunchContext {
  admit(scope: { pid: number }): Promise<void>;
  stop(): Promise<void>;
  signal?: AbortSignal;
}

const graphLaunches = new AsyncLocalStorage<GraphLaunchContext>();

/**
 * Закрытый графовый порт действует только внутри подготовленного model helper.
 * Обычные вызовы адаптеров не наследуют permit-канал соседнего запроса.
 */
export function withGraphLaunch<T>(context: GraphLaunchContext, action: () => T): T {
  return graphLaunches.run(context, action);
}

export function currentGraphLaunch(): GraphLaunchContext | undefined {
  return graphLaunches.getStore();
}

// Контейнерный launcher удерживает тот же выбор CLI, даже когда запускается bwrap.
// Копия контекста не позволяет адаптеру заменить окружение соседнего вызова.
export function currentExternalCliProcess(): ExternalCliProcessContext | undefined {
  const context = contexts.getStore();

  return context ? { ...context, env: { ...context.env } } : undefined;
}

/**
 * Открытие живой сессии чата помечает spawns своего вызова разговором.
 * Метка попадает в lease-запись хелпера и позволяет окну установки показать,
 * какой именно чат держит копию исполнителя, не раскрывая окружение CLI.
 */
export function withExternalCliLeaseJob<T>(job: string, action: () => T): T {
  return leaseJobs.run(job, action);
}

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

  return applyAccessEnvironment(env);
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
  const job = leaseJobs.getStore();
  const graph = graphLaunches.getStore();
  const helper = helperCommand('external-cli-lease', [
    ...(context.executableIdentity ? ['--identity', context.executableIdentity] : []),
    '--lease-dir', context.leaseDirectory,
    '--provider', context.providerId,
    '--resource', context.resourceKey,
    ...(job ? ['--job', job] : []),
    ...(graph ? ['--graph-permit', '1'] : []),
    '--', file, ...args,
  ]);

  // execFile не переносит detached в свой spawn; setsid создаёт тот же session scope без shell.
  const launcher = () => process.platform === 'darwin'
    ? darwinSetsidPath({ root: runtimeRoot(), packaged: runtimeKind() === 'packaged' }) : '/usr/bin/setsid';
  if (graph && mode === 'execFile') {
    throw new Error('graph_model_permit_required');
  }
  const executable = mode === 'execFile' ? launcher() : helper.command;
  const helperArgs = mode === 'execFile' ? [helper.command, ...helper.args] : helper.args;

  const prepared = {
    ...options,
    env: launchEnvironment(context, options.env),
    detached: true,
  } as Record<string, unknown>;

  if (graph && mode === 'spawn') {
    prepared.stdio = ['pipe', 'pipe', 'pipe',
      'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore',
      'pipe', 'pipe'];
  }
  return [executable, helperArgs, prepared, ...tail];
}

/**
 * Permit-канал подтверждает scope до запуска провайдера.
 * EOF, чужой PID, отказ допуска или тайм-аут останавливают запуск машинным кодом.
 */
async function graphPermitHandshake(child: ChildProcess, graph: GraphLaunchContext): Promise<void> {
  const stdio = child.stdio as unknown[];
  const scope: unknown = stdio[11];
  const permit: unknown = stdio[10];
  let admitted = false;
  const cancel = () => {
    if (admitted) {
      void graph.stop().catch(() => {});
      return;
    }
    if (permit instanceof Writable) {
      permit.end();
    }
  };

  graph.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (!(scope instanceof Readable) || !(permit instanceof Writable)) {
      throw new Error('graph_permit_stdio_missing');
    }
    const pid = await new Promise<number>((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => reject(new Error('graph_permit_timeout')), 5000);

      scope.setEncoding('utf8');
      scope.on('data', (chunk: string) => {
        buffered += chunk;

        try {
          const value = JSON.parse(buffered) as { pid?: unknown };

          clearTimeout(timer);
          resolve(Number(value.pid));
        } catch {
          if (buffered.length > 4096) {
            clearTimeout(timer);
            reject(new Error('graph_permit_invalid'));
          }
        }
      });
      scope.on('error', () => {
        clearTimeout(timer);
        reject(new Error('graph_permit_invalid'));
      });
      scope.on('end', () => {
        clearTimeout(timer);
        reject(new Error('graph_permit_eof'));
      });
    });

    if (pid !== child.pid || graph.signal?.aborted) {
      throw new Error('graph_permit_pid_mismatch');
    }
    await graph.admit({ pid });
    admitted = true;
    permit.end(Buffer.from([1]));
  } catch {
    if (permit instanceof Writable) {
      permit.end();
    }
    child.kill('SIGKILL');
  } finally {
    graph.signal?.removeEventListener('abort', cancel);
    if (scope instanceof Readable) {
      scope.destroy();
    }
  }
}

/**
 * OS-владелец получает ту же команду helper/lease, что обычный spawn выбранного CLI.
 * Выбор executable, access overlay, identity и метка чата остаются в одном контракте.
 */
export function externalCliSpawnSpec(file: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}) {
  const prepared = launchArguments(file, [args, options]);

  return {
    command: String(prepared[0]),
    args: prepared[1] as string[],
    options: prepared[2] as { cwd: string; env: NodeJS.ProcessEnv },
  };
}

/**
 * Отмена относится ко всей собственной группе helper-а, включая SIGKILL без signal handler.
 * Без этого timeout убивал бы только посредника, оставляя CLI и reader живыми навсегда.
 */
function ownGroup<T extends ChildProcess>(file: string, child: T): T {
  if (contexts.getStore()?.executable !== file || process.platform === 'darwin') {
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

export const spawn = ((file: string, ...rest: unknown[]) => {
  const graph = graphLaunches.getStore();
  if (graph && contexts.getStore()?.executable !== file) {
    throw new Error('graph_model_runtime_unprepared');
  }
  const child = Reflect.apply(nodeSpawn, undefined, launchArguments(file, rest)) as ChildProcess;

  if (graph) {
    void graphPermitHandshake(child, graph);

    return child;
  }
  return ownGroup(file, child);
}) as typeof nodeSpawn;
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
