import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { probeGrigDesk } from '../shared/runtime/grigDeskReadiness.ts';
import { readEnvFile } from '../server/src/lib/envFile.ts';
import { inside } from './brandMoveFiles.ts';
import { LEGACY } from '../shared/runtime/legacyBrand.ts';
import type { BrandCheck, BrandContext, BrandDeps } from './brandMoveCore.ts';

const execute = promisify(execFile);
const busyStates = new Set(['active', 'activating', 'reloading', 'deactivating']);

interface ProcessInfo {
  pid: number;
  name: string;
  cwd: string;
  args: string[];
  paths: string[];
  unchecked: boolean;
}

const deniedCodes = new Set(['EACCES', 'EPERM']);

/**
 * Исчезновение процесса во время обхода штатно; отказ доступа сохраняется как ошибка.
 * Ссылки читаются только в /proc, содержимое пользовательских файлов не открывается.
 */
async function procLink(file: string): Promise<string> {
  try {
    return (await fs.readlink(file)).replace(/ \(deleted\)$/, '');
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return '';
    }

    throw error;
  }
}

/**
 * Собирает закрытые части процесса: cwd, exe, открытые и отображённые файлы.
 * Процесс без признака dumpable (ssh-agent, менеджер паролей, служебные процессы сессии)
 * закрывает их даже от владельца; такой процесс помечается непроверенным, а не роняет обход.
 */
async function privatePaths(directory: string, info: ProcessInfo): Promise<void> {
  // Отказ доступа означает закрытый процесс: он помечается непроверенным, обход идёт дальше.
  // Любая другая ошибка — настоящая поломка чтения /proc и прерывает план.
  const guarded = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      if (!deniedCodes.has((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }

      info.unchecked = true;
    }
  };

  await guarded(async () => {
    info.cwd = await procLink(`${directory}/cwd`);
    info.paths.push(info.cwd, await procLink(`${directory}/exe`));
  });
  await guarded(async () => {
    for (const fd of await fs.readdir(`${directory}/fd`)) {
      info.paths.push(await procLink(`${directory}/fd/${fd}`));
    }
  });
  await guarded(async () => {
    const maps = await fs.readFile(`${directory}/maps`, 'utf8');

    for (const line of maps.split('\n')) {
      const file = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line)?.[1];

      if (file) {
        info.paths.push(file.replace(/ \(deleted\)$/, ''));
      }
    }
  });
}

/**
 * Собирает только процессы того же пользователя и исключает саму команду.
 * Аргументы и имя читаются всегда; cwd, exe, fd и maps — если процесс их не закрыл.
 */
async function processes(): Promise<ProcessInfo[]> {
  const result: ProcessInfo[] = [];

  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) {
      continue;
    }

    const directory = `/proc/${name}`;

    try {
      if ((await fs.stat(directory)).uid !== process.getuid?.()) {
        continue;
      }

      const args = (await fs.readFile(`${directory}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      const info: ProcessInfo = {
        pid: Number(name),
        name: (await fs.readFile(`${directory}/comm`, 'utf8')).trim(),
        cwd: '',
        args,
        paths: args.filter((arg) => arg.startsWith('/')),
        unchecked: false,
      };

      await privatePaths(directory, info);
      result.push(info);
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new Error(`Не удалось проверить процесс ${name}.`);
      }
    }
  }

  return result;
}

/**
 * Сервер этой копии узнаётся по аргументу, который вместе с cwd даёт путь к server/src/app.
 * Так находятся и `node src/app.ts` из `<код>/server` (bin/grigdesk-ctl run|dev, npm start).
 */
function serverProcess(item: ProcessInfo, codeRoot: string): boolean {
  return item.args.some((arg) => {
    const full = path.isAbsolute(arg) || !item.cwd ? arg : path.resolve(item.cwd, arg);

    return /\/server\/src\/app\.(?:ts|js)$/.test(full) && inside(codeRoot, full);
  });
}

/**
 * Отличает отсутствующий systemctl от недоступной шины: второе запрещает перенос.
 * Активные переходные состояния службы тоже считаются занятыми.
 */
async function unitCheck(unit: string, env: NodeJS.ProcessEnv): Promise<BrandCheck> {
  const factory = unit === 'factory-t*';
  const args = factory
    ? ['--user', 'list-units', unit, '--state=active', '--no-legend', '--plain']
    : ['--user', 'is-active', unit];
  let stdout = '';

  try {
    stdout = (await execute('systemctl', args, { env, timeout: 5000 })).stdout.trim();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };

    if (failure.code === 'ENOENT') {
      return {
        id: factory ? 'factory' : unit,
        ok: true,
        message: 'systemd недоступен',
      };
    }

    stdout = failure.stdout?.trim() ?? '';

    // is-active для activating и deactivating выходит с кодом 3: это занятость, не сбой шины.
    if (busyStates.has(stdout)) {
      return {
        id: factory ? 'factory' : unit,
        ok: false,
        message: `${unit}: ${stdout}`,
      };
    }

    if (!['inactive', 'failed', 'unknown'].includes(stdout)) {
      return {
        id: factory ? 'factory' : unit,
        ok: false,
        message: 'Нет связи с пользовательской шиной systemd.',
      };
    }
  }

  const ok = factory ? !stdout || stdout === 'inactive' : !busyStates.has(stdout);

  return {
    id: factory ? 'factory' : unit,
    ok,
    message: factory ? (ok ? 'Активных factory-t* нет.' : 'Активны factory-t*: у них старые пути.')
      : `${unit}: ${ok ? 'не активен' : 'активен'}`,
  };
}

/**
 * Собирает настоящие проверки только после защиты ядра и аргументов точки входа.
 * Все настройки процессов получены из явно переданного окружения команды.
 */
async function checkRuntime(context: BrandContext): Promise<BrandCheck[]> {
  const home = path.join(context.userHome, '.grigdesk');
  const sources = [home];
  const env = { ...context.env, HOME: context.userHome };
  let settings: Record<string, string> = {};

  for (const filename of [path.join(home, '.env')]) {
    try {
      settings = await readEnvFile(filename);

      if (Object.keys(settings).length) {
        break;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'ошибка';

      throw new Error(`Не удалось прочитать файл настроек: ${code}`);
    }
  }

  const port = Number(context.env.GRIGDESK_PORT ?? settings.GRIGDESK_PORT
    ?? settings[`${LEGACY.envPrefix}PORT`]) || 8140;
  const probe = await probeGrigDesk(`http://127.0.0.1:${port}`);
  const result: BrandCheck[] = [{
    id: 'server',
    ok: probe === 'refused',
    message: probe === 'refused' ? 'Сервер не отвечает: да' : 'Порт не закрыт: нет',
  }];

  for (const unit of [LEGACY.serverUnit, 'grigdesk-server.service', 'grigdesk-update-worker',
    `${LEGACY.configDir}-update-worker`, 'factory-t*']) {
    result.push(await unitCheck(unit, env));
  }


  try {
    const running = await processes();
    const server = running.filter((item) => serverProcess(item, context.codeRoot));
    const holders = running.filter((item) => item.paths.some((file) => file.startsWith('/')
      && sources.some((source) => inside(source, file))));
    const unchecked = running.filter((item) => item.unchecked);

    result.push({
      id: 'server-process',
      ok: !server.length,
      message: server.length ? `Есть процессы сервера: ${server.map((item) => item.pid).join(', ')}`
        : 'Процессов сервера нет.',
    }, {
      id: 'holders',
      ok: !holders.length,
      message: holders.length
        ? `Данные открыты: ${holders.map((item) => `${item.pid} ${item.name}`).join(', ')}`
        : 'Процессы не держат данные.',
    });

    if (unchecked.length) {
      result.push({
        id: 'unchecked',
        ok: true,
        message: 'Закрыты от проверки, проверены только аргументы: '
          + unchecked.map((item) => `${item.pid} ${item.name}`).join(', '),
      });
    }
  } catch (error) {
    result.push({
      id: 'processes',
      ok: false,
      message: (error as Error).message,
    });
  }

  return result;
}

/**
 * Конструирование зависимостей не читает данные и не запускает команды.
 * Это позволяет точке входа сначала полностью проверить право на запуск.
 */
export function brandRuntimeDeps(): BrandDeps {
  return {
    fs: nodeFs,
    checkRuntime,
  };
}
