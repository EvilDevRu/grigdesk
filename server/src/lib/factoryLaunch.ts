import fs from 'node:fs/promises';
import path from 'node:path';

import { dataPath } from '../../../shared/runtime/dataHome.ts';
import { PACKAGE_ID, runtimeError } from '../binary/leases.ts';
import {
  reserveFactoryRuntime,
  resolveFactoryRuntimePin,
  type FactoryRuntimeSelection,
} from './factoryRuntimePins.ts';
import { helperCommandFor, nodeExecutable, readHelperCatalog, runtimeMode } from './runtimePaths.ts';

import { config as runtimeConfig } from '../config.ts';

// Аргументы transient-юнита route-оркестратора (resume после ворот и после возврата).
//
// KillMode=mixed вместо дефолтного control-group — не украшение. Оркестратор по TERM
// обязан сделать три вещи ПО ПОРЯДКУ: остановить активный раннер, снять инструментацию
// (временные логи из рабочего дерева) и только потом умереть. Дефолт шлёт TERM ВСЕМУ
// cgroup сразу, поэтому процессы, которые оркестратор запускает уже внутри обработчика
// сигнала, гибнут вместе с ним: очистка возвращает код 143, задача встаёт в
// STALLED_HUMAN=1, а инструментация остаётся в дереве.
// mixed = TERM только главному процессу (он сам знает, кого и в каком порядке гасить),
// KILL всей группе — уже после TimeoutStopSec, если главный не уложился.
//
// TimeoutStopSec задаём явно: дефолт наследуется от менеджера и в любой момент может
// оказаться меньше, чем стоит снятие инструментации. 120 с — с большим запасом: очистка
// это сравнение снимков файлов и восстановление из бэкапа, секунды.
export function factoryUnitArgs(task: string | number): string[] {
  return [
    '--user', '--collect', `--unit=factory-t${task}`,
    '--property=KillMode=mixed', '--property=TimeoutStopSec=120',
  ];
}

// Пути фабрики, которые обязаны доехать до дочернего процесса.
export interface FactoryLaunchPaths {
  dataHome?: string;
  factoryHome: string;
  profilesDir: string;
  stateDir: string;
  factoryConfigRoot: string;
}

// Окружение процесса фабрики. Оно передаётся и обычному detached child, и
// `systemd-run --setenv`: transient scope не обязан наследовать env GrigDesk.
export function factoryLaunchEnv(
  config: FactoryLaunchPaths,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...extra,
    GRIGDESK_HOME: config.dataHome ?? runtimeConfig.dataHome,
    FACTORY_HOME: config.factoryHome,
    FACTORY_PROFILES_DIR: config.profilesDir,
    FACTORY_STATE: config.stateDir,
    STATE_DIR: config.stateDir,
    FACTORY_CONFIG_ROOT: config.factoryConfigRoot,
  };
}

export interface FactoryRouteLaunchPaths extends FactoryLaunchPaths {
  rootDir: string;
  factoryBin: string;
  factoryControlDir: string;
  runtime?: FactoryRuntimeSelection & { cacheDir: string };
  runtimeNode?: string;
  runtimeHostEnv?: Record<string, string>;
}

/**
 * Один выбранный runtime задаёт и engine, и helper Node, и host environment.
 * Читающий probe использует тот же конструктор без reservation или resolver с миграцией.
 */
export function selectedFactoryRuntimeConfig<T extends FactoryRouteLaunchPaths>(
  config: T,
  selected: FactoryRuntimeSelection,
) {
  return {
    ...config,
    rootDir: selected.runtimeRoot,
    factoryHome: selected.engineHome,
    factoryBin: selected.engineBin,
    runtimeNode: selected.node,
    runtimeHostEnv: {
      GRIGDESK_SERVER_RUNTIME_RESERVATION: '',
      GRIGDESK_SERVER_RUNTIME_NODE: '',
      GRIGDESK_SERVER_RUNTIME_PIN_HELPER: '',
    },
  };
}

/**
 * Команда helper-а строится по каталогу выбранного A, а не по текущему процессу B.
 * Таким образом его Node, ресурсы и движок принадлежат одному закреплённому runtime.
 */
function selectedRuntimeHelper(runtime: FactoryRuntimeSelection) {
  const packaged = runtime.packageId !== null;
  const helperDirectory = path.join(runtime.runtimeRoot, 'server/runtime/helpers');
  const catalog = readHelperCatalog(packaged ? path.join(helperDirectory, 'helpers.json')
    : path.join(runtime.runtimeRoot, 'server/build/helpers.json'));

  return helperCommandFor({
    mode: packaged ? 'helper' : 'source',
    kind: packaged ? 'packaged' : 'source',
    root: runtime.runtimeRoot,
    node: runtime.node,
    execPath: runtime.node,
    helperDirectory,
    installationRoot: runtime.runtimeRoot,
    installationBin: path.join(runtime.runtimeRoot, 'bin'),
  }, catalog, 'factory-runtime-pin', []);
}

/**
 * До engine spawn выбирается pin существующей попытки либо reservation нового start.
 * Административные команды и прежние source/v3 без host context сохраняют свой запуск.
 */
export async function prepareFactoryRouteLaunch<T extends FactoryRouteLaunchPaths>(config: T, args: string[])
  : Promise<{
    config: T;
    command: string;
    args: string[];
  }> {
  const raw = {
    config,
    command: config.factoryBin,
    args,
  };
  const task = args[0] ?? '';
  const action = args[1] ?? '';

  if (!/^[1-9][0-9]{0,18}$/u.test(task)) {
    return raw;
  }

  const attemptIndex = args.indexOf('--attempt');
  const attempt = attemptIndex >= 0 ? args[attemptIndex + 1] ?? '' : '';
  const profile = args[args.indexOf('--profile') + 1] ?? '';
  const context = config.runtime ?? (runtimeMode() === 'payload' ? {
    cacheDir: path.dirname(path.dirname(config.rootDir)),
    packageId: path.basename(config.rootDir),
    runtimeRoot: config.rootDir,
    engineHome: config.factoryHome,
    engineBin: config.factoryBin,
    node: nodeExecutable(),
  } : null);

  if (!context && !attempt) {
    return raw;
  }

  if (!context && !(await fs.lstat(path.join(config.factoryControlDir,
    'protocol-v2/tasks', `t${task}`, 'attempts', attempt, 'attempt.json')).catch(() => null))) {
    return raw;
  }

  if (!attempt && action !== 'start' && action !== 'recover') {
    return raw;
  }

  const roots = {
    controlRoot: config.factoryControlDir,
    stateRoot: config.stateDir,
    profileRoot: config.profilesDir,
  };
  const current = context ?? {
    cacheDir: dataPath(config.dataHome ?? runtimeConfig.dataHome, 'serverRuntime'),
    packageId: null,
    runtimeRoot: config.rootDir,
    engineHome: config.factoryHome,
    engineBin: config.factoryBin,
    node: nodeExecutable(),
  };

  if (current.packageId !== null && !PACKAGE_ID.test(current.packageId)) {
    throw runtimeError('factory_runtime_pin_invalid');
  }

  const selected = attempt ? await resolveFactoryRuntimePin({
    ...roots,
    task,
    attempt,
    profile,
    current,
    cacheDir: current.cacheDir,
  }) : current;
  const prepared = selectedFactoryRuntimeConfig(config, selected);

  if (selected.packageId === null) {
    return {
      config: prepared,
      command: selected.engineBin,
      args,
    };
  }

  const helper = selectedRuntimeHelper(selected);

  if (!attempt) {
    const reservation = await reserveFactoryRuntime({
      ...roots,
      ...selected,
      task,
      cacheDir: current.cacheDir,
    });

    prepared.runtimeHostEnv = {
      GRIGDESK_SERVER_RUNTIME_RESERVATION: reservation.reservation,
      GRIGDESK_SERVER_RUNTIME_NODE: helper.command,
      GRIGDESK_SERVER_RUNTIME_PIN_HELPER: helper.args[0]!,
    };
  }

  return {
    config: prepared,
    command: helper.command,
    args: [...helper.args, 'run', '--cache-dir', current.cacheDir,
      '--package-id', selected.packageId, '--engine', selected.engineBin, '--', ...args],
  };
}
