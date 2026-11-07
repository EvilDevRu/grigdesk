import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as sea from 'node:sea';

import { moduleUrl, nodeExecutable, runtimeRoot } from './runtimePaths.ts';
import { checkRuntime, PACKAGING_VERSION } from './releaseManifest.ts';
import type { RuntimeCheck, RuntimeCheckMode } from './releaseManifest.ts';

/**
 * Служебные команды SEA-входа.
 *
 * Разбор аргументов и печать отделены от сервера: справка, версия и лицензия не
 * должны импортировать app.ts, читать .env, создавать папку данных, брать lock
 * или поднимать HTTP. Сервер загружается только для режима запуска.
 */

export type SeaArgs =
  | { command: 'run' }
  | { command: 'help' }
  | { command: 'version'; json: boolean }
  | { command: 'license' }
  | { command: 'check-runtime' }
  | { command: 'check-startup' }
  | { command: 'error'; error: string };

export interface SeaCliPorts {
  readVersion(): string;
  readLicense(): string;
  loadServer(): Promise<unknown>;
  stdout(text: string): void;
  stderr(text: string): void;
  nodeVersion: string;
  platform: string;
  arch: string;
  checkRuntime?(mode?: RuntimeCheckMode): Promise<RuntimeCheck>;
}

export const HELP_TEXT = `GrigDesk — сервер GrigDesk.

Использование:
  grigdesk-server                    запустить сервер
  grigdesk-server --help             показать эту справку
  grigdesk-server --version          версия GrigDesk, Node и платформы
  grigdesk-server --version --json   те же поля в JSON
  grigdesk-server --license          лицензия встроенного Node
  grigdesk-server --check-runtime    проверить состав комплекта, JSON и код 0/1
  grigdesk-server --check-startup    быстрая проверка для запуска, JSON и код 0/1

Неизвестный, повторный или несовместимый аргумент — код 2 без запуска сервера.
`;

const SINGLE_COMMANDS = new Set(['--help', '--version', '--license', '--check-runtime', '--check-startup']);

/**
 * Разбирает argv до любых файловых и сетевых эффектов.
 * Допустимы только точные наборы; повтор и сочетание служебных флагов отвергаются.
 */
export function parseSeaArgs(argv: readonly string[]): SeaArgs {
  if (argv.length === 0) {
    return { command: 'run' };
  }

  const seen = new Set<string>();

  for (const arg of argv) {
    if (seen.has(arg)) {
      return { command: 'error', error: `Повторный аргумент: ${arg}` };
    }

    seen.add(arg);
  }

  if (argv.length === 1) {
    const [only] = argv;

    if (only === '--help') {
      return { command: 'help' };
    }

    if (only === '--version') {
      return { command: 'version', json: false };
    }

    if (only === '--license') {
      return { command: 'license' };
    }

    if (only === '--check-runtime') {
      return { command: 'check-runtime' };
    }

    if (only === '--check-startup') {
      return { command: 'check-startup' };
    }
  }

  if (argv.length === 2 && argv[0] === '--version' && argv[1] === '--json') {
    return { command: 'version', json: true };
  }

  if (seen.has('--json')) {
    return { command: 'error', error: 'Аргумент --json допустим только вместе с --version' };
  }

  if (argv.some((arg) => SINGLE_COMMANDS.has(arg))) {
    return { command: 'error', error: `Несовместимый набор аргументов: ${argv.join(' ')}` };
  }

  const extra = argv[0] ?? '';

  return {
    command: 'error',
    error: extra.startsWith('-') ? `Неизвестный аргумент: ${extra}` : `Лишний аргумент: ${extra}`,
  };
}

/**
 * Читает версию приложения из VERSION своего корня.
 * В исходниках это корень дерева, в комплекте — R; папка данных не нужна.
 */
function readAppVersion(): string {
  return readFileSync(fileURLToPath(moduleUrl('VERSION')), 'utf8').trim();
}

/**
 * Возвращает лицензию Node: встроенный asset в SEA или файл рядом с Node в исходниках.
 * Другие источники не подставляются, чтобы лицензия не зависела от машины.
 */
function readNodeLicense(): string {
  if (sea.isSea()) {
    return sea.getAsset('NODE-LICENSE', 'utf8');
  }

  return readFileSync(path.resolve(path.dirname(nodeExecutable()), '..', 'LICENSE'), 'utf8');
}

/**
 * Порты реального процесса для точки входа.
 * Литеральный import('../app.ts') остаётся здесь, чтобы esbuild включил сервер в бандл;
 * вызывается он только для режима запуска.
 */
export function defaultSeaCliPorts(): SeaCliPorts {
  return {
    readVersion: readAppVersion,
    readLicense: readNodeLicense,
    loadServer: () => import('../app.ts'),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    checkRuntime: (mode) => checkRuntime(runtimeRoot(), undefined, { mode }),
  };
}

/**
 * Выполняет служебную команду или запускает сервер и возвращает код выхода.
 * Ошибка загрузки сервера превращается в код 1 с причиной, а не в пустой успех.
 */
export async function runSeaCli(argv: readonly string[],
  ports: SeaCliPorts = defaultSeaCliPorts()): Promise<number> {
  const parsed = parseSeaArgs(argv);

  if (parsed.command === 'error') {
    ports.stderr(`${parsed.error}\n\n${HELP_TEXT}`);

    return 2;
  }

  if (parsed.command === 'help') {
    ports.stdout(HELP_TEXT);

    return 0;
  }

  if (parsed.command === 'version') {
    const version = ports.readVersion();

    if (parsed.json) {
      ports.stdout(`${JSON.stringify({
        version,
        node: ports.nodeVersion,
        platform: ports.platform,
        arch: ports.arch,
        packagingVersion: PACKAGING_VERSION,
      }, null, 2)}\n`);
    } else {
      ports.stdout(`GrigDesk ${version}\nNode ${ports.nodeVersion}\n`
        + `${ports.platform} ${ports.arch}\n`);
    }

    return 0;
  }

  if (parsed.command === 'license') {
    try {
      ports.stdout(ports.readLicense());
    } catch (error) {
      ports.stderr(`Лицензия Node недоступна: ${(error as Error).message}\n`);

      return 1;
    }

    return 0;
  }

  if (parsed.command === 'check-runtime' || parsed.command === 'check-startup') {
    const mode = parsed.command === 'check-startup' ? 'startup' : 'full';
    const result = await (ports.checkRuntime?.(mode) ?? checkRuntime(runtimeRoot(), undefined, { mode }));

    ports.stdout(`${JSON.stringify(result, null, 2)}\n`);

    return result.ok ? 0 : 1;
  }

  try {
    await ports.loadServer();
  } catch (error) {
    ports.stderr(`GrigDesk не запустился: ${(error as Error).message}\n`);

    return 1;
  }

  return 0;
}
