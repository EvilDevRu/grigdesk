import { readTextOrNull } from '../../shared/node/files.ts';

import { dataHome, dataPath, envFilePath } from '../../shared/runtime/dataHome.ts';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { parseEnv, promisify } from 'node:util';

import {
  desktopRuntimePath,
  effectivePort,
  effectiveValue,
  parseRuntimeDescriptor,
  stopGraceMs,
} from '../../shared/desktop/desktopRuntime.ts';
import type { EnvMap } from '../../shared/desktop/desktopRuntime.ts';
import { isNodeVersionSupported, MIN_NODE_VERSION } from '../../server/src/lib/nodeVersion.ts';
import { localOrigin } from './connection.ts';

export type RuntimeProblem = 'not_installed' | 'invalid' | 'root' | 'web' | 'node';

export interface ServerRuntime {
  root: string;
  node: string;
  port: number;
  origin: string;
  env: Record<string, string>;
  graceMs: number;
  logPath: string;
  uiReleasesDir: string;
}

export interface RuntimeDependencies {
  readText(path: string): Promise<string | null>;
  exists(path: string, kind: 'file' | 'dir' | 'exec'): Promise<boolean>;
  nodeVersion(node: string): Promise<string | null>;
}

const executeFile = promisify(execFile);

const PACKAGED_ENV_KEYS = new Set([
  'APPDIR',
  'APPIMAGE',
  'ARGV0',
  'OWD',
  'APPIMAGE_EXTRACT_AND_RUN',
  'CHROME_DESKTOP',
  'FC_FONTATIONS',
  'INVOCATION_ID',
  'JOURNAL_STREAM',
  'SYSTEMD_EXEC_PID',
  'MANAGERPID',
  'NOTIFY_SOCKET',
  'LISTEN_PID',
  'LISTEN_FDS',
  'LISTEN_FDNAMES',
  'CLAUDECODE',
  'COCKPIT_DESKTOP_DATA_DIR',
]);
const PACKAGED_PATH_KEYS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR'];

export const runtimeDependencies: RuntimeDependencies = {
  /**
   * Отсутствующий файл отличается от ошибки доступа или чтения.
   * Загрузчик сам переводит отказ в безопасную причину без содержимого настроек.
   */
  readText: readTextOrNull,
  /**
   * Проверяет вид объекта и доступ к исполняемому файлу до запуска.
   * Ошибка файловой системы закрывает проверку, не превращаясь в успешное наличие.
   */
  async exists(file, kind) {
    try {
      const info = await stat(file);

      if (kind === 'dir') {
        return info.isDirectory();
      }

      if (!info.isFile()) {
        return false;
      }

      if (kind === 'exec') {
        await access(file, constants.X_OK);
      }

      return true;
    } catch {
      return false;
    }
  },
  /**
   * Спрашивает версию именно у Node из описания установки с бюджетом пять секунд.
   * Отказ и зависание дают отсутствие версии для общей проверки совместимости.
   */
  async nodeVersion(node) {
    try {
      const result = await executeFile(node, ['-p', 'process.versions.node'], { timeout: 5000 });

      return result.stdout.trim();
    } catch {
      return null;
    }
  },
};

/**
 * Очищает объединённое окружение от упаковки, сохраняя приоритет родителя над файлом.
 * Сервер и VPN-ворота получают один PATH и маркер; исходные снимки не меняются.
 * Каталог пакета — APPDIR окружения и appDir главного процесса: распакованный AppRun
 * вычисляет APPDIR, но не экспортирует его, а пути пакета в PATH всё равно дописывает.
 */
export function buildServerEnv(input: {
  parent: EnvMap;
  dotenv: Record<string, string>;
  node: string;
  home: string;
  appDir?: string | null;
}): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(Object.entries({
    ...input.dotenv,
    ...input.parent,
  })
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  const appDirs = [env.APPDIR, input.appDir].filter((value): value is string => Boolean(value));

  for (const key of Object.keys(env)) {
    if (PACKAGED_ENV_KEYS.has(key) || key.startsWith('ELECTRON_')) {
      delete env[key];
    }
  }

  if (appDirs.length > 0) {
    for (const key of PACKAGED_PATH_KEYS) {
      const value = env[key];

      if (value === undefined) {
        continue;
      }

      const filtered = value.split(':')
        .filter((entry) => !appDirs.some((appDir) => entry === appDir || entry.startsWith(`${appDir}/`)))
        .join(':');

      if (filtered) {
        env[key] = filtered;
      } else {
        delete env[key];
      }
    }
  }

  const originalDesktop = env.ORIGINAL_XDG_CURRENT_DESKTOP;

  if (originalDesktop !== undefined) {
    env.XDG_CURRENT_DESKTOP = originalDesktop;
    delete env.ORIGINAL_XDG_CURRENT_DESKTOP;
  }

  const entries = [
    path.join(input.home, '.kimi-code/bin'),
    path.join(input.home, '.local/bin'),
    path.dirname(input.node),
    ...(env.PATH?.split(':') ?? []),
  ];

  env.PATH = [...new Set(entries.filter(Boolean))].join(':');
  env.COCKPIT_DESKTOP_CHILD = '1';

  return env;
}

/**
 * Проверяет описание установки через явные порты файлов и версии Node.
 * Проблема установки запрещает только свой запуск, подключение к внешнему серверу остаётся возможным.
 */
export async function loadServerRuntime(input: {
  env: EnvMap;
  home: string;
  deps: RuntimeDependencies;
  appDir?: string | null;
  bundledUi?: boolean;
}): Promise<{ runtime: ServerRuntime } | { problem: RuntimeProblem; message: string }> {
  const descriptorPath = desktopRuntimePath(input);
  let text: string | null;

  try {
    text = await input.deps.readText(descriptorPath);
  } catch {
    text = '';
  }

  if (text === null) {
    return {
      problem: 'not_installed',
      message: 'Сервер Кокпита не установлен для приложения: выполните cockpit desktop install.',
    };
  }

  const descriptor = parseRuntimeDescriptor(text);

  if (!descriptor) {
    return {
      problem: 'invalid',
      message: `Описание установки сервера повреждено: ${descriptorPath}. Выполните cockpit desktop install.`,
    };
  }

  const { root, node } = descriptor;
  const required: [string, 'file' | 'dir'][] = [
    ['server/src/app.ts', 'file'],
    ['server/node_modules', 'dir'],
    ['deploy/require-vpn.sh', 'file'],
  ];

  for (const [relative, kind] of required) {
    if (!await input.deps.exists(path.join(root, relative), kind)) {
      return {
        problem: 'root',
        message: `В каталоге Кокпита ${root} нет ${relative}.`,
      };
    }
  }

  const parent = descriptor.version === 2 ? { ...input.env, COCKPIT_HOME: descriptor.home } : input.env;
  let envPath: string;
  let selectedHome: string;

  try {
    selectedHome = dataHome({ env: parent, home: input.home });
    envPath = envFilePath({ env: parent, home: input.home });
  } catch (error) {
    return { problem: 'invalid', message: (error as Error).message };
  }

  let dotenv: Record<string, string>;

  try {
    const fileText = await input.deps.readText(envPath);

    dotenv = fileText === null ? {} : Object.fromEntries(Object.entries(parseEnv(fileText))
      .filter((entry): entry is [string, string] => entry[1] !== undefined));
  } catch {
    return {
      problem: 'invalid',
      message: `Не удалось прочитать настройки сервера: ${envPath}.`,
    };
  }

  for (const key of ['COCKPIT_HOME', 'COCKPIT_ENV_FILE']) {
    if (Object.hasOwn(dotenv, key)) {
      return { problem: 'invalid', message: `Ключ ${key} запрещён в файле настроек ${envPath}.` };
    }
  }

  const dist = effectiveValue(input.env, dotenv, 'COCKPIT_WEB_DIST') || path.join(root, 'web/dist');
  const index = path.join(dist, 'index.html');

  if (!input.bundledUi && !await input.deps.exists(index, 'file')) {
    return {
      problem: 'web',
      message: `Нет собранного интерфейса: ${index}.`,
    };
  }

  const version = await input.deps.exists(node, 'exec') ? await input.deps.nodeVersion(node) : null;

  if (!version || !isNodeVersionSupported(version)) {
    return {
      problem: 'node',
      message: `Node ${node} недоступен или старше ${MIN_NODE_VERSION.split('.').slice(0, 2).join('.')}`
        + ` (нужно ^${MIN_NODE_VERSION} || >=24.0.0).`,
    };
  }

  const port = effectivePort(input.env, dotenv);
  const origin = localOrigin(`http://127.0.0.1:${port}`);

  if (!origin) {
    return {
      problem: 'invalid',
      message: `Некорректный порт Кокпита: ${port}.`,
    };
  }

  return {
    runtime: {
      root,
      node,
      port,
      origin,
      env: buildServerEnv({
        parent,
        dotenv,
        node,
        home: input.home,
        appDir: input.appDir,
      }),
      graceMs: stopGraceMs(input.env, dotenv),
      logPath: effectiveValue(input.env, dotenv, 'COCKPIT_LOG')
        || dataPath(selectedHome, 'log'),
      uiReleasesDir: effectiveValue(input.env, dotenv, 'COCKPIT_UI_RELEASES_DIR')
        || dataPath(selectedHome, 'uiReleases'),
    },
  };
}
