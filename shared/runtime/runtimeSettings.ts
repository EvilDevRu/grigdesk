import { dataHome, dataPath } from './dataHome.ts';
import type { DataHomeEnv } from './dataHome.ts';

export interface RuntimeSettingsInput {
  env: DataHomeEnv;
  file: DataHomeEnv;
  home: string;
  legacyTokenPath?: string;
}

export interface Settings {
  port: number;
  origin: string;
  windowKeyPath: string | null;
  relayProject: string | null;
  cliTokenPath: string;
}

const FORBIDDEN_FILE_KEYS = ['COCKPIT_HOME', 'COCKPIT_ENV_FILE'] as const;

/**
 * Разрешает уже разобранные настройки без чтения файлов и окружения процесса.
 * Явное наличие ключа в окружении важнее файла, даже когда значение пустое.
 */
export function resolveRuntimeSettings(input: RuntimeSettingsInput): Settings {
  const { env, file, home, legacyTokenPath } = input;

  for (const key of FORBIDDEN_FILE_KEYS) {
    if (Object.hasOwn(file, key)) {
      throw new Error(`Ключ ${key} запрещён в файле настроек.`);
    }
  }

  const value = (key: string) => Object.hasOwn(env, key) ? env[key] : file[key];
  const port = Number(value('COCKPIT_PORT')) || 8140;

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    windowKeyPath: value('COCKPIT_WINDOW_KEY_PATH') || null,
    relayProject: value('COCKPIT_RELAY_PROJECT') || null,
    cliTokenPath: value('COCKPIT_CLI_TOKEN_PATH') || legacyTokenPath
      || dataPath(dataHome({
        env,
        home,
      }), 'cliToken'),
  };
}
