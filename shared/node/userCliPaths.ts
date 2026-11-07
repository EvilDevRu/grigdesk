import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { dataPath } from '../runtime/dataHome.ts';
import type { UserCliDirectories } from './cliPathOrder.ts';

export { userCliPath } from './cliPathOrder.ts';
export type { UserCliDirectories, PackagedCliInput } from './cliPathOrder.ts';

export interface UserCliFileSystem {
  readdir(directory: string): Promise<string[]>;
  stat(file: string): Promise<{ isDirectory(): boolean }>;
}

const NODE_VERSION = /^v(\d+)\.(\d+)\.(\d+)$/u;

const nodeFileSystem: UserCliFileSystem = {
  readdir: (directory) => readdir(directory),
  stat: (file) => stat(file),
};

/**
 * Список каталогов из строки PATH-формата: пустые и относительные элементы отбрасываются,
 * абсолютные нормализуются без обращения к файловой системе.
 */
function absoluteDirectories(value: string | undefined): string[] {
  return (value ?? '').split(':')
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.normalize(entry));
}

/**
 * Необязательный каталог участвует только как существующий каталог.
 * Любая ошибка доступа или отсутствие означает «пропустить», а не отказ запуска.
 */
async function optionalDirectory(fileSystem: UserCliFileSystem, directory: string): Promise<boolean> {
  try {
    return (await fileSystem.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Явный каталог пользователя сохраняется даже отсутствующим: это его настройка PATH.
 * Недоступный из-за прав каталог — именованный отказ, а не молча потерянная команда.
 */
async function checkExplicitDirectory(fileSystem: UserCliFileSystem, directory: string): Promise<void> {
  try {
    await fileSystem.stat(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'EACCES' || code === 'EPERM') {
      throw Object.assign(new Error(`Каталог GRIGDESK_CLI_PATH недоступен: ${directory}`), {
        code: 'cli_path_inaccessible',
      });
    }
  }
}

/**
 * Версии nvm читаются одним уровнем versions/node без shell rc, alias и npm -g.
 * Порядок — numeric semver по убыванию; нестандартные имена и не-каталоги пропускаются.
 */
async function nvmNodeDirectories(input: {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  fileSystem: UserCliFileSystem;
}): Promise<string[]> {
  const nvmRoot = input.env.NVM_DIR && path.isAbsolute(input.env.NVM_DIR)
    ? input.env.NVM_DIR
    : path.join(input.home, '.nvm');
  const versionsDirectory = path.join(nvmRoot, 'versions/node');
  let names: string[];

  try {
    names = await input.fileSystem.readdir(versionsDirectory);
  } catch {
    return [];
  }

  const versions = names.flatMap((name) => {
    const match = NODE_VERSION.exec(name);

    return match ? [{ name, parts: match.slice(1).map(Number) }] : [];
  });

  versions.sort((left, right) => {
    const index = left.parts.findIndex((part, position) => part !== right.parts[position]);

    return index < 0 ? 0 : (right.parts[index] ?? 0) - (left.parts[index] ?? 0);
  });

  const directories: string[] = [];

  for (const version of versions) {
    const directory = path.join(versionsDirectory, version.name, 'bin');

    if (await optionalDirectory(input.fileSystem, directory)) {
      directories.push(directory);
    }
  }

  return directories;
}

/**
 * Готовит пользовательские каталоги CLI один раз на запуск packaged-сервера.
 * Явный GRIGDESK_CLI_PATH, существующие умолчания и nvm идут в userCliPath без записи файлов.
 */
export async function discoverUserCliDirectories(input: {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  dataHome: string;
  fileSystem?: UserCliFileSystem;
}): Promise<UserCliDirectories> {
  const fileSystem = input.fileSystem ?? nodeFileSystem;
  const explicit = [...new Set(absoluteDirectories(input.env.GRIGDESK_CLI_PATH))];

  for (const directory of explicit) {
    await checkExplicitDirectory(fileSystem, directory);
  }

  const defaults: string[] = [];

  for (const directory of [
    path.join(input.home, '.kimi-code/bin'),
    path.join(input.home, '.local/bin'),
    path.join(dataPath(input.dataHome, 'state'), 'npm-global/bin'),
  ]) {
    if (await optionalDirectory(fileSystem, directory)) {
      defaults.push(directory);
    }
  }

  return {
    explicit,
    defaults,
    discovered: await nvmNodeDirectories({
      env: input.env,
      home: input.home,
      fileSystem,
    }),
  };
}
