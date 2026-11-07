import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ApplicationLauncherState } from '../../shared/desktop/applicationLauncher.ts';
import { desktopCommand } from './desktopEntry.ts';

export interface ApplicationLauncher {
  read(): Promise<ApplicationLauncherState>;
  setAutostart(enabled: boolean): Promise<ApplicationLauncherState>;
  setShortcut(enabled: boolean): Promise<ApplicationLauncherState>;
}

interface LauncherOptions {
  executablePath: string;
  arguments?: string[];
  home: string;
  env: NodeJS.ProcessEnv;
  trustShortcut?(file: string): Promise<void>;
}

/**
 * Отсутствующий файл означает выключенную настройку; ошибки доступа не скрываются.
 * Это позволяет показать отказ чтения вместо ложного состояния «выключено».
 */
async function readEntry(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }

    throw error;
  }
}

/**
 * Готовый ярлык публикуется переименованием, чтобы рабочий стол не прочитал половину Exec.
 * Символическая ссылка в целевом имени заменяется, её содержимое не перезаписывается.
 */
async function writeEntry(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;

  await fs.mkdir(path.dirname(file), { recursive: true });

  try {
    await fs.writeFile(temporary, content, { mode: 0o755, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Каталог рабочего стола читается как данные, без source и подстановки команд.
 * Явный HOME отключает рабочий стол; меню приложений остаётся доступно независимо от него.
 */
async function desktopDirectory(config: string, home: string): Promise<string | null> {
  const settings = await readEntry(path.join(config, 'user-dirs.dirs'));
  const match = /^XDG_DESKTOP_DIR="((?:\\.|[^"\\])*)"\s*$/mu.exec(settings);
  const directory = match
    ? match[1]!.replace(/^\$HOME(?=\/|$)/u, home).replace(/\\([\\"$`])/gu, '$1')
    : path.join(home, 'Desktop');

  if (!path.isAbsolute(directory) || path.resolve(directory) === path.resolve(home)) {
    return null;
  }

  const info = await fs.stat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  return info?.isDirectory() ? directory : null;
}

/**
 * Linux-оболочка создаёт ярлыки на собственный физический бинарник, без серверного checkout.
 * Автозапуск окна и ярлык меню независимы; все изменения сериализованы в одном native-порту.
 */
export function createApplicationLauncher(options: LauncherOptions): ApplicationLauncher {
  const config = options.env.XDG_CONFIG_HOME;
  const data = options.env.XDG_DATA_HOME;
  const configHome = config && path.isAbsolute(config) ? config : path.join(options.home, '.config');
  const dataHome = data && path.isAbsolute(data) ? data : path.join(options.home, '.local/share');
  const autostartFile = path.join(configHome, 'autostart/grigdesk-app.desktop');
  const menuFile = path.join(dataHome, 'applications/grigdesk.desktop');
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * Путь фиксирует main при старте; запись не принимает пути и параметры от страницы.
   * APPIMAGE уже выбран вызывающим вместо временного файла в точке монтирования.
   */
  async function entry(): Promise<string> {
    const executable = await fs.realpath(options.executablePath);
    const args = [executable, ...(options.arguments ?? [])];

    if (!path.isAbsolute(executable) || args.some((value) => /[\r\n\0]/u.test(value))) {
      throw new Error('Некорректный путь приложения для ярлыка');
    }

    return [
      '[Desktop Entry]',
      'Type=Application',
      'Name=GrigDesk',
      `Exec=${desktopCommand(executable, options.arguments)}`,
      'Icon=grigdesk',
      'StartupWMClass=grigdesk',
      'Terminal=false',
      'Categories=Development;',
      '',
    ].join('\n');
  }

  /**
   * Состояние перечитывает реальные файлы, поэтому ручное удаление видно при новом открытии.
   * Hidden=true учитывается как отключение автозапуска в окружении рабочего стола.
   */
  async function read(): Promise<ApplicationLauncherState> {
    const desktop = await desktopDirectory(configHome, options.home);
    const [autostart, menu, shortcut] = await Promise.all([
      readEntry(autostartFile),
      readEntry(menuFile),
      desktop ? readEntry(path.join(desktop, 'grigdesk.desktop')) : '',
    ]);

    return {
      executablePath: await fs.realpath(options.executablePath),
      autostart: Boolean(autostart) && !/^Hidden=true\s*$/mu.test(autostart),
      shortcut: {
        desktop: Boolean(shortcut),
        menu: Boolean(menu),
      },
    };
  }

  /**
   * Быстрые повторные действия не могут поменять порядок файловых эффектов.
   * После отказа очередь остаётся пригодна для следующего явного действия человека.
   */
  function change(action: () => Promise<void>): Promise<ApplicationLauncherState> {
    const result = queue.catch(() => {}).then(async () => {
      await action();

      return read();
    });

    queue = result;

    return result;
  }

  return {
    read,
    setAutostart: (enabled) => change(async () => {
      if (enabled) {
        await writeEntry(autostartFile, await entry());
      } else {
        await fs.rm(autostartFile, { force: true });
      }
    }),
    setShortcut: (enabled) => change(async () => {
      const desktop = await desktopDirectory(configHome, options.home);
      const files = [menuFile, ...(desktop ? [path.join(desktop, 'grigdesk.desktop')] : [])];

      if (enabled) {
        const content = await entry();

        for (const file of files) {
          await writeEntry(file, content);
        }

        if (desktop) {
          await options.trustShortcut?.(path.join(desktop, 'grigdesk.desktop')).catch(() => {});
        }
      } else {
        for (const file of files) {
          await fs.rm(file, { force: true });
        }
      }
    }),
  };
}
