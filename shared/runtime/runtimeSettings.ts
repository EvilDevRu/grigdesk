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

/**
 * Разрешает уже разобранные настройки без чтения файлов и окружения процесса.
 * Явное наличие ключа в окружении важнее файла, даже когда значение пустое.
 */
export function resolveRuntimeSettings(input: RuntimeSettingsInput): Settings {
  const { env, file, home, legacyTokenPath } = input;

  // Файл настроек не переназначает корни данных: эти ключи читаются только из окружения.
  for (const reserved of ['GRIGDESK_HOME', 'GRIGDESK_ENV_FILE']) {
    if (Object.hasOwn(file, reserved)) {
      throw new Error(`Ключ ${reserved} запрещён в файле настроек.`);
    }
  }

  const value = (key: string) => Object.hasOwn(env, key) ? env[key] : file[key];
  const port = Number(value('GRIGDESK_PORT')) || 8140;

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    windowKeyPath: value('GRIGDESK_WINDOW_KEY_PATH') || null,
    relayProject: value('GRIGDESK_RELAY_PROJECT') || null,
    cliTokenPath: value('GRIGDESK_CLI_TOKEN_PATH') || legacyTokenPath
      || dataPath(dataHome({
        env,
        home,
      }), 'cliToken'),
  };
}
