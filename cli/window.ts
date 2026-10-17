import os from 'node:os';
import path from 'node:path';

import type { Settings } from './commands.ts';
import { printable } from './status.ts';
import { executable, pidAlive, readLink, spawnDetached } from './system.ts';

export type WindowStateName = 'open' | 'closed' | 'not_installed' | 'unknown';

/**
 * Путь установленного AppImage совпадает с общим shell-хелпером установки.
 * Пустой XDG_DATA_HOME выбирает стандартный каталог домашней папки.
 */
export function windowAppPath(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || os.homedir();

  return path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'),
    'cockpit/desktop/cockpit-desktop.AppImage');
}

/**
 * Явный профиль допускается только абсолютным путём, как в приложении Electron.
 * Остальные случаи используют каталог конфигурации приложения «Кокпит».
 */
export function windowDataDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.COCKPIT_DESKTOP_DATA_DIR;

  if (explicit && path.isAbsolute(explicit)) {
    return explicit;
  }

  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'), 'Кокпит');
}

/**
 * SingletonLock содержит имя хоста и PID, разделённые последним дефисом.
 * Проверка числа исключает нулевой, дробный и небезопасный PID до обращения к процессу.
 */
export function parseLockTarget(target: string): { host: string; pid: number } | null {
  const separator = target.lastIndexOf('-');
  const host = target.slice(0, separator);
  const number = target.slice(separator + 1);
  const pid = Number(number);

  if (separator < 1 || !/^\d+$/.test(number) || !Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }

  return {
    host,
    pid,
  };
}

/**
 * Живой локальный SingletonLock подтверждает открытое окно даже без установленного файла.
 * Иначе наличие исполняемого AppImage отличает закрытое окно от отсутствия установки.
 */
export async function readWindow(env: NodeJS.ProcessEnv): Promise<WindowStateName> {
  const target = await readLink(path.join(windowDataDir(env), 'SingletonLock'));
  const lock = target ? parseLockTarget(target) : null;

  if (lock && lock.host === os.hostname() && pidAlive(lock.pid)) {
    return 'open';
  }

  return await executable(windowAppPath(env)) ? 'closed' : 'not_installed';
}

/**
 * Открывает установленное окно, не дожидаясь сети или состояния systemd.
 * Из .env передаётся только путь ключа; прочее окружение остаётся окружением CLI.
 */
export async function openWindow(settings: Settings, env: NodeJS.ProcessEnv): Promise<number> {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    console.error('Нет графического сеанса');

    return 1;
  }

  const app = windowAppPath(env);

  if (!await executable(app)) {
    console.error('Окно Кокпита не установлено: cockpit desktop install');

    return 1;
  }

  const childEnv = { ...env };

  if (settings.windowKeyPath) {
    childEnv.COCKPIT_WINDOW_KEY_PATH = settings.windowKeyPath;
  }

  try {
    await spawnDetached(app, [`--cockpit-url=${settings.origin}/`], childEnv);
    console.log('Окно открывается');

    return 0;
  } catch (error) {
    console.error(printable(error instanceof Error ? error.message : String(error)));

    return 1;
  }
}
