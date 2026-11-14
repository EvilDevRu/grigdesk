import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
import { parse, type ParseError } from 'jsonc-parser';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { currentExternalCliProcess, externalCliSpawnSpec }
  from '../providerInstall/externalCliProcess.ts';
import { inspectCliLeases } from '../providerInstall/leases.ts';
import { redactRunnerError } from '../factoryProviderRunner.ts';
import { qwenConfig, type QwenSnapshot } from './settings.ts';
import type { QwenLaunchOptions } from './sandbox.ts';

const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const execute = promisify(execFile);

/**
 * Путь менеджера процессов переопределяется только окружением теста (§4в).
 * Значение читается лениво при каждом вызове, продукт остаётся на системных путях.
 */
const systemdRunBin = () => process.env.GRIGDESK_QWEN_SYSTEMD_RUN_BIN || '/usr/bin/systemd-run';
const systemctlBin = () => process.env.GRIGDESK_QWEN_SYSTEMCTL_BIN || '/usr/bin/systemctl';

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
async function startHostScope(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
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

  child.stderr.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-8192);
  });

  /**
   * Успешный stop подтверждается inactive/not-found и пустой собственной cgroup.
   * При отказе остаются lease и live entry; чужие unit/PID не являются fallback-целями.
   */
  const close = async () => {
    let state = await unitState(unit, env);

    if (state.loaded !== 'not-found' && !['inactive', 'failed'].includes(state.active || '')) {
      await execute(systemctlBin(), ['--user', 'stop', unit], {
        env,
        timeout: 8000,
        encoding: 'utf8',
      }).catch(async () => {
        await execute(systemctlBin(), ['--user', 'kill', '--kill-whom=all', '--signal=KILL', unit], {
          env,
          timeout: 3000,
          encoding: 'utf8',
        });
      });

      state = await unitState(unit, env);
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

/**
 * Системный слой копируется во временный overlay без изменения исходного JSONC.
 * Native hooks, LSP и MCP сохраняются; ключи маршрутов заменены проверенным снимком моделей.
 */
async function hostSettings(
  snapshot: QwenSnapshot, extraDirs: readonly string[],
): Promise<Record<string, unknown>> {
  const file = process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH || '/etc/qwen-code/settings.json';
  const text = await fs.readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') {
      return '{}';
    }

    throw error;
  });
  const errors: ParseError[] = [];
  const source: unknown = parse(text, errors, { allowTrailingComma: true });

  if (errors.length || !isRecord(source)) {
    throw new Error('Qwen: повреждён системный слой настроек Host');
  }

  return {
    ...source,
    modelProviders: snapshot.settings.modelProviders,
    tools: {
      ...record(source.tools),
      toolSearch: { enabled: false },
    },
    context: {
      ...record(source.context),
      includeDirectories: [...new Set([
        ...(Array.isArray(record(source.context).includeDirectories)
          ? record(source.context).includeDirectories as string[] : []),
        ...extraDirs,
      ])],
    },
    general: { ...(isRecord(source.general) ? source.general : {}), enableAutoUpdate: false },
    telemetry: { ...(isRecord(source.telemetry) ? source.telemetry : {}), enabled: false },
  };
}

/**
 * Доверенный Host сохраняет mandatory builtin guard, но не attached provider v1.
 * Launcher владеет reader lease, а эта обёртка завершает только собственную группу процесса.
 */
export async function startQwenHost(
  configValue: unknown, snapshot: QwenSnapshot, options: QwenLaunchOptions,
) {
  const context = currentExternalCliProcess();
  const config = qwenConfig(configValue);

  if (!context) {
    throw new Error('Qwen: не подготовлена выбранная копия CLI');
  }

  await fs.mkdir(options.home, { recursive: true, mode: 0o700 });

  const staging = await fs.mkdtemp(path.join(options.home, 'host-'));
  let cleanupScope: (() => Promise<void>) | undefined;

  try {
    const settingsFile = path.join(staging, 'settings.json');
    const runtimeDir = path.join(options.home, '.qwen');
    const env = Object.fromEntries(Object.entries(context.env).filter(([key]) => {
      return !/^(?:GRIGDESK_|FACTORY_|LD_|DYLD_|QWEN_CODE_PRIVATE_)/.test(key)
        && !['NODE_OPTIONS', 'NODE_PATH'].includes(key);
    }));
    const nonce = randomUUID();

    await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(settingsFile,
      JSON.stringify(await hostSettings(snapshot, options.extraDirs || [])), { mode: 0o400 });

    const defaultsFile = path.join(staging, 'defaults.json');
    const defaultsPath = process.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH || '/etc/qwen-code/system-defaults.json';
    const defaultsText = await fs.readFile(defaultsPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') {
        return '{}';
      }

      throw error;
    });
    const errors: ParseError[] = [];
    const defaults: unknown = parse(defaultsText, errors, { allowTrailingComma: true });

    if (errors.length || !isRecord(defaults)) {
      throw new Error('Qwen: повреждён слой defaults Host');
    }

    const effectiveDefaults = { ...defaults };

    for (const field of ['tools', 'experimental', 'agents', 'omni']) {
      effectiveDefaults[field] = { ...record(snapshot.settings[field]), ...record(defaults[field]) };
    }

    await fs.writeFile(defaultsFile, JSON.stringify(effectiveDefaults), { mode: 0o400 });
    delete env.QWEN_CONVERSATIONS_DIR;
    Object.assign(env, {
      HOME: context.env.HOME || os.homedir(),
      QWEN_HOME: config.qwenHome || process.env.GRIGDESK_QWEN_HOME || process.env.QWEN_HOME
        || path.join(os.homedir(), '.qwen'),
      QWEN_RUNTIME_DIR: runtimeDir,
      QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsFile,
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaultsFile,
      QWEN_CODE_PRIVATE_ACP_CAPABILITY: nonce,
      QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD: 'required-v1',
      CI: '1',
      NO_COLOR: '1',
    });

    for (const key of snapshot.envKeys) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }

    const secrets = Object.entries(env)
      .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)
        && value && value.length > 5)
      .map(([, value]) => value);
    const launch = externalCliSpawnSpec(context.executable, [
      '--acp', '--auth-type', options.authType, '--approval-mode', options.mode,
    ], { cwd: options.cwd, env });

    delete launch.options.env.QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER;

    const scope = await startHostScope(launch.command, launch.args, options.cwd, launch.options.env);

    cleanupScope = scope.close;

    let closing: Promise<void> | undefined;
    const resource = {
      child: scope.child,
      nonce,
      stderr: () => redactRunnerError(scope.stderr(), secrets),
      /**
       * Provisional owner сохраняется у actor ещё до готовности scope/ACP.
       * Ошибка cleanup оставляет доступный повтор того же ресурса, а не новый launch.
       */
      close(): Promise<void> {
        closing ??= (async () => {
          await scope.close();
          // Подчистка мёртвой записи своего lease после завершения процесса;
          // живость читателя отдельным оракулом проверяет §6.9, здесь без assert.
          await inspectCliLeases({ directory: context.leaseDirectory, providerId: context.providerId });
          await fs.rm(staging, { recursive: true, force: true });
        })().catch((error) => {
          closing = undefined;

          throw error;
        });

        return closing;
      },
    };

    options.onOwnedProcess?.(resource);

    try {
      await scope.ready;

      return resource;
    } catch (error) {
      await resource.close();

      throw error;
    }
  } catch (error) {
    await cleanupScope?.();
    await fs.rm(staging, { recursive: true, force: true });

    throw error;
  }
}