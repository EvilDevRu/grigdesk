// Общее OS-владение процессом исполнителя: отдельный transient user scope.
//
// Извлечено из Qwen Host без его overlay/ACP/cron: тот же контракт owner unit,
// подтверждённого закрытия и сигналов только собственному UUID. Исполнитель
// передаёт свои метки, env-швы и код отказа; семантика шагов не меняется.
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export interface OwnedProcessScopeOptions {
  // Префикс уникального unit: grigdesk-qwen/grigdesk-codex, без имени чата.
  unitPrefix: string;
  // Метка исполнителя в сообщениях отказа; наружу не уходит имя scope.
  label: string;
  unavailableCode: string;
  // Пути менеджера читаются лениво при каждом вызове: тест подменяет их env-швом.
  systemdRunBin: () => string;
  systemctlBin: () => string;
  // Явная проба user bus до запуска; Qwen сохраняет прежний порядок без неё.
  probeBus?: boolean;
}

export interface PreparedProcessScopeOwner {
  owner: string;
  options: OwnedProcessScopeOptions;
}

export interface OwnedProcessScope {
  child: ReturnType<typeof spawn>;
  ready: Promise<void>;
  close: () => Promise<void>;
  stderr: () => string;
}

/**
 * Владелец определяется ОС для собственного процесса сервера, а не выбором модели.
 * Терминальная сессия и user@ manager не подходят: scope должен пережить терминал
 * и погаснуть вместе с отдельным unit приложения.
 */
async function ownerUnit(options: OwnedProcessScopeOptions): Promise<string> {
  const text = await fs.readFile('/proc/self/cgroup', 'utf8');
  const group = text.split('\n').find((line) => line.startsWith('0::'))?.slice(3);
  const unit = group?.split('/').reverse().find((part) => /\.(service|scope)$/.test(part));

  if (!unit || !/^[a-zA-Z0-9_.@\\x-]+\.(service|scope)$/.test(unit)
    || /^user@/.test(unit)
    || (unit.endsWith('.scope') && !/^app-grigdesk-[a-zA-Z0-9_-]+\.scope$/.test(unit))) {
    throw Object.assign(new Error(`${options.label}: требуется отдельный user unit приложения.`), {
      code: options.unavailableCode,
    });
  }

  return unit;
}

/**
 * Подготовка проверяет владельца и, по флагу исполнителя, доступность user bus.
 * Отказ здесь означает видимую причину до рабочего turn, а не слабый fallback.
 */
export async function prepareOwnedProcessScope(
  options: OwnedProcessScopeOptions,
): Promise<PreparedProcessScopeOwner> {
  const owner = await ownerUnit(options);

  if (options.probeBus) {
    try {
      await execute(options.systemctlBin(), ['--user', 'show-environment'], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 16384,
      });
    } catch {
      throw Object.assign(new Error(`${options.label}: user bus процессов недоступен.`), {
        code: options.unavailableCode,
      });
    }
  }

  return { owner, options };
}

/**
 * В ответе читаются только собственные lifecycle-поля уникального unit.
 * Ошибка user bus не считается доказанным завершением и не заменяется пустым снимком.
 */
async function unitState(unit: string, env: NodeJS.ProcessEnv, options: OwnedProcessScopeOptions) {
  const result = await execute(options.systemctlBin(), ['--user', 'show', unit,
    '--property=LoadState', '--property=ActiveState', '--property=ControlGroup'], {
    env,
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 16384,
  });
  const values = Object.fromEntries(result.stdout.trim().split('\n').map((line) => {
    const at = line.indexOf('=');

    return [line.slice(0, at), line.slice(at + 1)];
  }));

  return {
    loaded: values.LoadState,
    active: values.ActiveState,
    group: values.ControlGroup || '',
  };
}

/**
 * Синхронный старт по подготовленному owner сохраняет контракт open живой сессии.
 * Scope содержит helper, CLI и все его detached shell/MCP/monitor; BindsTo+After
 * завершает scope при остановке app unit, в том числе после аварии приложения.
 */
export function startOwnedProcessScope(
  prepared: PreparedProcessScopeOwner,
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): OwnedProcessScope {
  const { owner, options } = prepared;
  const unit = `${options.unitPrefix}-${randomUUID()}.scope`;
  const child = spawn(options.systemdRunBin(), [
    '--user', '--scope', '--collect', '--quiet',
    '--expand-environment=no', `--unit=${unit}`, `--working-directory=${cwd}`,
    '--property=KillMode=control-group', '--property=SendSIGKILL=yes',
    '--property=TimeoutStopSec=2s', `--property=BindsTo=${owner}`, `--property=After=${owner}`,
    '--', command, ...args,
  ], {
    cwd,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let didExit = false;
  let group = '';
  let stderr = '';
  const exited = new Promise<void>((resolve) => {
    const finish = () => {
      didExit = true;
      resolve();
    };

    child.once('error', finish);
    child.once('close', finish);
  });

  child.stderr?.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-8192);
  });

  /**
   * Успешный stop подтверждается inactive/not-found и пустой собственной cgroup.
   * При отказе остаются lease и live entry; чужие unit/PID не являются fallback-целями.
   */
  const close = async () => {
    let state = await unitState(unit, env, options);

    if (state.loaded !== 'not-found' && !['inactive', 'failed'].includes(state.active || '')) {
      await execute(options.systemctlBin(), ['--user', 'stop', unit], {
        env,
        timeout: 8000,
        encoding: 'utf8',
      }).catch(async () => {
        await execute(options.systemctlBin(), ['--user', 'kill', '--kill-whom=all', '--signal=KILL', unit], {
          env,
          timeout: 3000,
          encoding: 'utf8',
        });
      });

      state = await unitState(unit, env, options);
    }

    const deadline = Date.now() + 3000;

    while (true) {
      state = await unitState(unit, env, options);

      const inactive = state.loaded === 'not-found' || ['inactive', 'failed'].includes(state.active || '');
      const events = group ? await fs.readFile(path.join('/sys/fs/cgroup', group, 'cgroup.events'), 'utf8')
        .catch((error) => {
          if (error.code === 'ENOENT') {
            return 'populated 0';
          }

          throw error;
        }) : '';

      if (inactive && (!group || /^populated 0$/m.test(events))) {
        break;
      }

      if (Date.now() >= deadline) {
        throw new Error(`${options.label}: завершение собственного process scope не подтверждено.`);
      }

      await pause(20);
    }

    if (!didExit) {
      child.kill('SIGTERM');

      const timer = setTimeout(() => child.kill('SIGKILL'), 500);

      await exited;
      clearTimeout(timer);
    }
  };

  const ready = (async () => {
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline && !didExit) {
      const state = await unitState(unit, env, options);

      if (state.active === 'active' && state.group.endsWith('/' + unit)) {
        group = state.group;

        return;
      }

      await pause(20);
    }

    throw Object.assign(new Error(`${options.label}: не удалось открыть user process scope.`), {
      code: options.unavailableCode,
    });
  })();

  return {
    child,
    ready,
    close,
    stderr: () => stderr,
  };
}
