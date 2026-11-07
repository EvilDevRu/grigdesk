import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { dataPath } from '../../../shared/runtime/dataHome.ts';
import { profilesDirFor } from './runtimeLayout.ts';
import type { RuntimeKind } from './runtimePaths.ts';

export type FactoryEngineMode = 'source' | 'bundled' | 'external';

export interface FactoryRuntime {
  mode: FactoryEngineMode;
  home: string;
  bin: string;
  ignored: string[];
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
 * Выбирает движок фабрики: source прежний, packaged — движок поставки R/engine.
 * Старые FACTORY_HOME/GRIGDESK_FACTORY_BIN не возвращают packaged к checkout;
 * внешний движок включается только явным GRIGDESK_ENGINE_MODE=external с абсолютными путями.
 */
export function factoryRuntimePaths(input: {
  kind: RuntimeKind;
  root: string;
  env: Env;
}): FactoryRuntime {
  const mode = input.env.GRIGDESK_ENGINE_MODE ?? '';

  if (!ENGINE_MODES.has(mode)) {
    throw factoryConfigError('GRIGDESK_ENGINE_MODE: допустимо bundled или external',
      'factory_engine_mode_unsupported');
  }

  if (input.kind === 'source') {
    // Исходники сохраняют прежние переопределения независимо от режима.
    const home = input.env.FACTORY_HOME || path.join(input.root, 'engine');

    return {
      mode: 'source',
      home,
      bin: input.env.GRIGDESK_FACTORY_BIN || path.join(home, 'bin', 'factory'),
      ignored: [],
    };
  }

  if (mode === 'external') {
    const home = input.env.FACTORY_HOME ?? '';
    const bin = input.env.GRIGDESK_FACTORY_BIN || path.join(home, 'bin', 'factory');

    if (!path.isAbsolute(home) || !path.isAbsolute(bin)) {
      throw factoryConfigError('Внешний движок требует абсолютные FACTORY_HOME и GRIGDESK_FACTORY_BIN',
        'factory_engine_external_invalid');
    }

    return {
      mode: 'external',
      home,
      bin,
      ignored: [],
    };
  }

  const home = path.join(input.root, 'engine');

  return {
    mode: 'bundled',
    home,
    bin: path.join(home, 'bin', 'factory'),
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
