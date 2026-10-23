import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { runtimeInstallationRoot, runtimeRoot } from '../server/src/lib/runtimePaths.ts';

import { isPortableBundle } from '../shared/node/bundleLayout.ts';

import { dataHome, dataPath, envFilePath } from '../shared/runtime/dataHome.ts';
import { desktopRuntimePath, parseRuntimeDescriptor } from '../shared/desktop/desktopRuntime.ts';
import { resolveRuntimeSettings } from '../shared/runtime/runtimeSettings.ts';
import type { Settings } from '../shared/runtime/runtimeSettings.ts';
import { HELP_TEXT, parseArgs } from './args.ts';
import type { CliArgs } from './args.ts';
import { readLinks, readRelay, relayCommand } from './relay.ts';
import { readServer, serverCommand, UNIT } from './server.ts';
import { collectStatus, printable, renderText, toJson } from './status.ts';
import { readText, realPath } from './system.ts';
import { openWindow } from './window.ts';
import { deviceCommand } from './device.ts';

export type { Settings } from '../shared/runtime/runtimeSettings.ts';

/**
 * Читает .env как данные без экспорта его содержимого в процесс CLI или окно.
 * Наличие ключа в окружении важнее файла, включая явно заданную пустую строку.
 */
export function readSettings(
  _root: string, env: NodeJS.ProcessEnv, envFileText: string | null, legacyTokenPath?: string,
): Settings {
  return resolveRuntimeSettings({
    env,
    file: envFileText === null ? {} : parseEnv(envFileText),
    home: env.HOME || os.homedir(),
    legacyTokenPath,
  });
}

/**
 * Принадлежность службе определяется только точным сегментом пути cgroup.
 * Несколько контроллеров v1 проверяются независимо, сходное имя не подходит.
 */
export function insideUnit(cgroupText: string, unit: string): boolean {
  return cgroupText.split('\n').some((line) => {
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);

    return first >= 0 && second >= 0 && line.slice(second + 1).split('/').includes(unit);
  });
}

/**
 * Переходный режим open: исправный runtime.json значит, что установлено новое окно, и
 * сервер оно поднимает само. Нет файла или он не разбирается — прежний путь через службу.
 */
export async function windowStartsServer(env: NodeJS.ProcessEnv): Promise<boolean> {
  const text = await readText(desktopRuntimePath({
    env,
    home: env.HOME || os.homedir(),
  }));

  return text !== null && parseRuntimeDescriptor(text) !== null;
}

/**
 * Аргументы и сторож проверяются до любых внешних команд и запросов состояния.
 * Ошибки пользователя дают код 2, ошибки действий — код 1 с очищенной причиной.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  let args: CliArgs;

  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(printable(error instanceof Error ? error.message : String(error)));

    return 2;
  }

  try {
    if (args.kind === 'help') {
      process.stdout.write(HELP_TEXT);

      return 0;
    }

    const root = await realPath(runtimeInstallationRoot());

    if (args.kind === 'version') {
      const version = await readText(path.join(runtimeRoot(), 'VERSION'));

      console.log(`GrigDesk ${version?.trim() ?? ''}`);

      return 0;
    }

    const guarded = args.kind === 'open' || args.kind === 'server' &&
      ['stop', 'restart'].includes(args.action ?? '');

    if (guarded && !args.force) {
      const cgroup = await readText(process.env.GRIGDESK_CLI_CGROUP_FILE || '/proc/self/cgroup');

      if (insideUnit(cgroup ?? '', UNIT)) {
        console.error('Команда прервёт ход агента или откроет окно из него. Используйте --force.');

        return 1;
      }
    }

    const input = { env: process.env, home: process.env.HOME || os.homedir() };
    const home = dataHome(input);
    // Переходное чтение до ручного переноса: в папке данных ещё нет токена или файла настроек,
    // а на старом месте — настоящий каталог или файл. Пустая папка не отрезает старые.
    const found = async (file: string) => await lstat(file).catch(() => null);
    const legacyToken = !await found(dataPath(home, 'cliToken'))
      && Boolean((await found(path.join(root, 'server/.state')))?.isDirectory());
    const legacyEnv = !process.env.GRIGDESK_ENV_FILE && !await found(dataPath(home, 'env'))
      && Boolean((await found(path.join(root, '.env')))?.isFile());
    const envPath = legacyEnv ? path.join(root, '.env') : envFilePath(input);
    const settings = readSettings(root, process.env, await readText(envPath),
      legacyToken ? path.join(root, 'server/.state/cli-token') : undefined);

    if (args.kind === 'device') {
      return await deviceCommand(args, settings);
    }

    if (args.kind === 'open') {
      const windowCode = await openWindow(root, settings, process.env);

      if (await isPortableBundle(root) || await windowStartsServer(process.env)) {
        return windowCode;
      }

      const serverCode = await serverCommand({
        ...args,
        kind: 'server',
        action: 'start',
      }, root, settings);

      return windowCode || serverCode;
    }

    if (args.kind === 'status' || args.action === 'status') {
      let snapshot;

      if (args.kind === 'status') {
        snapshot = await collectStatus(root, settings, process.env);
      } else if (args.kind === 'server') {
        snapshot = { server: await readServer(root, settings) };
      } else {
        const [relay, server] = await Promise.all([readRelay(root, settings), readServer(root, settings)]);

        relay.links = server.state === 'ready' ? await readLinks(settings) : null;
        snapshot = { relay };
      }

      const color = Boolean(process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb');

      process.stdout.write(args.json ? toJson(snapshot) : renderText(snapshot, { color }));

      return 0;
    }

    if (args.kind === 'server') {
      return await serverCommand(args, root, settings);
    }

    return await relayCommand(args, root, settings);
  } catch (error) {
    console.error(printable(error instanceof Error ? error.message : String(error)));

    return 1;
  }
}
