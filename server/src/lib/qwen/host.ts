import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/**
 * Путь менеджера процессов переопределяется только окружением теста (§4в).
 * Значение читается лениво при каждом вызове, продукт остаётся на системных путях.
 */
const systemdRunBin = () => process.env.GRIGDESK_QWEN_SYSTEMD_RUN_BIN || '/usr/bin/systemd-run';
const systemctlBin = () => process.env.GRIGDESK_QWEN_SYSTEMCTL_BIN || '/usr/bin/systemctl';

interface HostScopeOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  executableFd: number;
}

/**
 * Срок жизни native scope привязан к отдельному unit приложения, а не терминалу.
 * Unit определяется ОС для собственного процесса; модель не выбирает имя цели сигналов.
 */
async function hostOwnerUnit(): Promise<string> {
  const text = await fs.readFile('/proc/self/cgroup', 'utf8');
  const group = text.split('\n').find((line) => line.startsWith('0::'))?.slice(3);
  const unit = group?.split('/').reverse().find((part) => /\.(service|scope)$/.test(part));

  if (!unit || !/^[a-zA-Z0-9_.@\\x-]+\.(service|scope)$/.test(unit)
    || /^user@/.test(unit)
    || (unit.endsWith('.scope') && !/^app-grigdesk-[a-zA-Z0-9_-]+\.scope$/.test(unit))) {
    throw Object.assign(new Error('Qwen Host: требуется отдельный user unit приложения.'), {
      code: 'qwen_host_scope_unavailable',
    });
  }

  return unit;
}

/**
 * В ответе читаются только собственные lifecycle-поля уникального unit.
 * Ошибка user bus не считается доказанным завершением и не заменяется пустым снимком.
 */
async function unitState(unit: string, env: NodeJS.ProcessEnv) {
  const result = await execute(systemctlBin(), ['--user', 'show', unit,
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
 * Уникальный scope содержит helper, CLI и все его detached shell/MCP/monitor.
 * BindsTo+After завершает scope при остановке app unit, в том числе после аварии приложения.
 */
export async function startQwenHostScope(
  command: string, args: readonly string[], options: HostScopeOptions,
) {
  const { cwd, env, executableFd } = options;
  const owner = await hostOwnerUnit();
  const unit = `grigdesk-qwen-${randomUUID()}.scope`;
  const child = spawn(systemdRunBin(), [
    '--user', '--scope', '--collect', '--quiet',
    '--expand-environment=no', `--unit=${unit}`, `--working-directory=${cwd}`,
    '--property=KillMode=control-group', '--property=SendSIGKILL=yes',
    '--property=TimeoutStopSec=2s', `--property=BindsTo=${owner}`, `--property=After=${owner}`,
    '--', command, ...args,
  ], {
    cwd,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', executableFd],
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
    let state = await unitState(unit, env);

    if (state.loaded !== 'not-found' && !['inactive', 'failed'].includes(state.active || '')) {
      let stopFailure: unknown;

      await execute(systemctlBin(), ['--user', 'stop', unit], {
        env,
        timeout: 8000,
        encoding: 'utf8',
      }).catch(async () => {
        await execute(systemctlBin(), ['--user', 'kill', '--kill-whom=all', '--signal=KILL', unit], {
          env,
          timeout: 3000,
          encoding: 'utf8',
        }).catch((error) => {
          stopFailure = error;
        });
      });

      state = await unitState(unit, env);

      // Между снимком и сигналами CLI может завершиться, а --collect удалить scope.
      // Ошибка сигналов не заменяет проверку состояния и пустоты cgroup ниже.
      if (stopFailure && state.loaded !== 'not-found'
        && !['inactive', 'failed'].includes(state.active || '')) {
        throw stopFailure;
      }
    }

    const deadline = Date.now() + 3000;

    while (true) {
      state = await unitState(unit, env);

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
        throw new Error('Qwen Host: завершение собственного process scope не подтверждено.');
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
      const state = await unitState(unit, env);

      if (state.active === 'active' && state.group.endsWith('/' + unit)) {
        group = state.group;

        return;
      }

      await pause(20);
    }

    throw Object.assign(new Error('Qwen Host: не удалось открыть user process scope.'), {
      code: 'qwen_host_scope_unavailable',
    });
  })();

  return {
    child,
    ready,
    close,
    stderr: () => stderr,
  };
}
