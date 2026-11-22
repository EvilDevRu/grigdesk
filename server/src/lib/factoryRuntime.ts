import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { dataPath } from '../../../shared/runtime/dataHome.ts';
import { profilesDirFor } from './runtimeLayout.ts';
import type { RuntimeKind } from './runtimePaths.ts';
import { readFactoryGoDescriptor } from './factoryGoDescriptor.ts';

export type FactoryEngineMode = 'source' | 'bundled' | 'external';

export type FactoryEngineProtocol = 'go-v1';

export interface FactoryCommands {
  home: string;
  bin: string;
  protocol: FactoryEngineProtocol;
}

export type FactoryHelper = 'route' | 'context' | 'profile-check' | 'stage-progress' | 'stage-result';

/**
 * Строит команду для выбранного поколения. Наличие других файлов или отказ
 * выбранного helper-а не меняет протокол посреди операции.
 */
export function factoryHelper(
  runtime: FactoryCommands, helper: FactoryHelper, args: readonly string[],
): { command: string; args: string[] } {
  return { command: runtime.bin, args: [helper, ...args] };
}

export const FACTORY_STATUS_ENGINE_ENV = [
  'FACTORY_STATUS_ENGINE_PROTOCOL', 'FACTORY_STATUS_BIN', 'FACTORY_STATUS_ENGINE_HOME',
  'FACTORY_RUN_ATTEMPT',
] as const;

function absoluteEnginePath(value: string | undefined): value is string {
  return Boolean(value && path.isAbsolute(value) && path.normalize(value) === value
    && !/[\0\n\r]/u.test(value));
}

/**
 * Определяет writer для host status context. Долгоживущий broker получает эти
 * поля от оркестратора данного запуска.
 */
export function factoryStatusCommands(env: NodeJS.ProcessEnv): FactoryCommands {
  const protocol = env.FACTORY_STATUS_ENGINE_PROTOCOL;
  const home = env.FACTORY_STATUS_ENGINE_HOME;

  if (protocol === 'go-v1' && absoluteEnginePath(env.FACTORY_STATUS_BIN) && absoluteEnginePath(home)
    && /^a_[a-f0-9]{32}$/u.test(env.FACTORY_RUN_ATTEMPT ?? '')) {
    return {
      home,
      bin: env.FACTORY_STATUS_BIN,
      protocol,
    };
  }

  throw new Error('factory status engine descriptor invalid');
}

export interface FactoryRuntime {
  mode: FactoryEngineMode;
  home: string;
  bin: string;
  ignored: string[];
  protocol: 'go-v1';
}

export interface ProfilesFileSystem {
  realpathSync(file: string): string;
  lstatSync(file: string): { isSymbolicLink(): boolean };
}

type Env = Readonly<Record<string, string | undefined>>;

// Прежние переопределения source-движка: в одиночном ELF они только диагностируются.
const ENGINE_OVERRIDES = ['FACTORY_HOME', 'GRIGDESK_FACTORY_BIN'] as const;
const ENGINE_MODES = new Set(['', 'bundled', 'external']);

const nodeFileSystem: ProfilesFileSystem = {
  realpathSync: (file) => realpathSync(file),
  lstatSync: (file) => lstatSync(file),
};

/**
 * Именованная ошибка конфигурации фабрики: код для проверок, текст для человека.
 * Значения секретов в текст не попадают, только пути и имена переменных.
 */
function factoryConfigError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Выбирает Go-фабрику из bin checkout или из собственного каталога поставки.
 * Старые FACTORY_HOME/GRIGDESK_FACTORY_BIN не возвращают packaged к checkout;
 * внешний движок включается только явным GRIGDESK_ENGINE_MODE=external с абсолютными путями.
 */
export function factoryRuntimePaths(input: {
  kind: RuntimeKind;
  root: string;
  env: Env;
  platform?: string;
}): FactoryRuntime {
  const mode = input.env.GRIGDESK_ENGINE_MODE ?? '';
  const executable = (input.platform ?? process.platform) === 'win32' ? 'factory.exe' : 'factory';

  if (!ENGINE_MODES.has(mode)) {
    throw factoryConfigError('GRIGDESK_ENGINE_MODE: допустимо bundled или external',
      'factory_engine_mode_unsupported');
  }

  if (mode === 'external') {
    const home = input.env.FACTORY_HOME ?? '';
    const bin = input.env.GRIGDESK_FACTORY_BIN || path.join(home, 'bin', executable);

    if (!path.isAbsolute(home) || !path.isAbsolute(bin)) {
      throw factoryConfigError('Внешний движок требует абсолютные FACTORY_HOME и GRIGDESK_FACTORY_BIN',
        'factory_engine_external_invalid');
    }

    return {
      mode: 'external',
      home,
      bin,
      protocol: 'go-v1',
      ignored: [],
    };
  }

  if (input.kind === 'source') {
    return {
      mode: 'source',
      home: input.env.FACTORY_HOME || path.join(input.root, 'engine'),
      bin: input.env.GRIGDESK_FACTORY_BIN || path.join(input.root, 'bin', executable),
      protocol: 'go-v1',
      ignored: [],
    };
  }

  const home = path.join(input.root, 'engine');

  const descriptor = readFactoryGoDescriptor(input.root);

  if (!descriptor) {
    throw factoryConfigError('В комплекте отсутствует Go-фабрика', 'factory_runtime_engine_invalid');
  }

  return {
    mode: 'bundled',
    home,
    bin: path.join(input.root, descriptor.path),
    protocol: 'go-v1',
    ignored: ENGINE_OVERRIDES.filter((key) => Boolean(input.env[key])),
  };
}

/**
 * Физический путь без следования последнему отсутствующему хвосту:
 * ближайший существующий предок раскрывается realpath, остальные компоненты добавляются как есть.
 */
function physicalPath(value: string, fileSystem: ProfilesFileSystem): string {
  const resolved = path.resolve(value);
  const missing: string[] = [];
  let current = resolved;

  while (true) {
    try {
      return path.join(fileSystem.realpathSync(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || current === path.dirname(current)) {
        throw error;
      }

      missing.push(path.basename(current));
      current = path.dirname(current);
    }
  }
}

/**
 * Каталог профилей обязан быть физическим: движок сверяет canonical_file и запрещает
 * symlink-компоненты. Packaged передаёт детям realpath D, а явный путь с ссылкой или
 * лишними символами отклоняет с физической подсказкой, ничего не перенося.
 */
export function factoryProfilesRoot(input: {
  kind: RuntimeKind;
  rootDir: string;
  dataHome: string;
  env: Env;
  fileSystem?: ProfilesFileSystem;
}): string {
  if (input.kind === 'source') {
    return profilesDirFor({
      kind: input.kind,
      rootDir: input.rootDir,
      dataHome: input.dataHome,
      env: input.env,
    });
  }

  const fileSystem = input.fileSystem ?? nodeFileSystem;
  const explicit = input.env.FACTORY_PROFILES_DIR;
  const value = explicit || dataPath(fileSystem.realpathSync(input.dataHome), 'profiles');

  if (!path.isAbsolute(value)) {
    throw factoryConfigError('FACTORY_PROFILES_DIR должен быть абсолютным путём',
      'factory_profiles_not_physical');
  }

  const physical = physicalPath(value, fileSystem);
  let linked = false;

  try {
    linked = fileSystem.lstatSync(physical).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (physical !== value || linked) {
    const target = linked ? fileSystem.realpathSync(physical) : physical;

    throw factoryConfigError(`Каталог профилей фабрики ${value} не физический: движок запрещает `
      + `symlink-компоненты. Укажите FACTORY_PROFILES_DIR=${target}`, 'factory_profiles_not_physical');
  }

  return value;
}
