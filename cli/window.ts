import os from 'node:os';
import path from 'node:path';

import { isPortableBundle } from '../shared/node/bundleLayout.ts';

import type { Settings } from './commands.ts';
import { printable } from './status.ts';
import { executable, pidAlive, readLink, spawnDetached } from './system.ts';

export type WindowStateName = 'open' | 'closed' | 'not_installed' | 'unknown';

/**
 * Путь установленного окна совпадает с общим shell-хелпером установки: собранный AppImage
 * лежит в bin/ копии под именем grigdesk-app, рядом с остальными программами.
 */
export function windowAppPath(root: string): string {
  if (isPortableBundle(root)) {
    return path.join(root, 'GrigDesk');
  }

  return path.join(root, 'bin/grigdesk-app');
}

/**
 * Явный профиль допускается только абсолютным путём, как в приложении Electron.
 * Остальные случаи используют каталог конфигурации приложения GrigDesk.
 */
export function windowDataDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.GRIGDESK_DESKTOP_DATA_DIR;

  if (explicit && path.isAbsolute(explicit)) {
    return explicit;
  }

  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'), 'GrigDesk');
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
 * Иначе наличие исполняемого окна в bin/ отличает закрытое окно от отсутствия установки.
 */
export async function readWindow(root: string, env: NodeJS.ProcessEnv): Promise<WindowStateName> {
  const target = await readLink(path.join(windowDataDir(env), 'SingletonLock'));
  const lock = target ? parseLockTarget(target) : null;

  if (lock && lock.host === os.hostname() && pidAlive(lock.pid)) {
    return 'open';
  }

  return await executable(windowAppPath(root)) ? 'closed' : 'not_installed';
}

/**
 * Открывает установленное окно, не дожидаясь сети или состояния systemd.
 * Из .env передаётся только путь ключа; прочее окружение остаётся окружением CLI.
 */
export async function openWindow(root: string, settings: Settings, env: NodeJS.ProcessEnv): Promise<number> {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    console.error('Нет графического сеанса');

    return 1;
  }

  const app = windowAppPath(root);

  if (!await executable(app)) {
    console.error('Окно GrigDesk не установлено: grigdesk-ctl desktop install');

    return 1;
  }

  const childEnv = { ...env };

  if (settings.windowKeyPath) {
    childEnv.GRIGDESK_WINDOW_KEY_PATH = settings.windowKeyPath;
  }

  try {
    const args = await isPortableBundle(root) ? [] : [`--grigdesk-url=${settings.origin}/`];

    await spawnDetached(app, args, childEnv);
    console.log('Окно открывается');

    return 0;
  } catch (error) {
    console.error(printable(error instanceof Error ? error.message : String(error)));

    return 1;
  }
}
