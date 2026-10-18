import { dataHome, dataPath } from './dataHome.ts';
import type { DataHomeEnv } from './dataHome.ts';
import { legacyRootProblem } from './legacyBrand.ts';

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

  const problem = legacyRootProblem(file, true);

  if (problem) {
    throw new Error(problem);
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
