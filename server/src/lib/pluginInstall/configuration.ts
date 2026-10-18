import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import type { GrigDeskConfig } from '../../config.ts';
import { parseSemVer } from '../grigDeskRelease.ts';

export type PluginInstallConfiguration = Pick<GrigDeskConfig,
  'rootDir' | 'userPluginsDir' | 'userPluginsDataDir' | 'pluginInstallsStatePath'>;

/**
 * Boot проверяет пути и VERSION до создания owner lock и installer state.
 * Неверная конфигурация не должна выполнять filesystem эффекты подготовки.
 */
export async function readPluginInstallConfiguration(config: PluginInstallConfiguration): Promise<{
  pluginsDir: string;
  statePath: string;
  grigDeskVersion: string;
}> {
  const paths = [
    config.rootDir, config.userPluginsDir, config.userPluginsDataDir, config.pluginInstallsStatePath,
  ];

  if (paths.some((value) => typeof value !== 'string' || !path.isAbsolute(value))) {
    throw new TypeError('Пути installer должны быть абсолютными.');
  }

  const pluginsDir = path.resolve(config.userPluginsDir);
  const data = path.resolve(config.userPluginsDataDir);
  const statePath = path.resolve(config.pluginInstallsStatePath);
  const overlaps = data === pluginsDir || data.startsWith(pluginsDir + path.sep)
    || pluginsDir.startsWith(data + path.sep);

  if (overlaps || statePath === pluginsDir || statePath.startsWith(pluginsDir + path.sep)) {
    throw new TypeError('State и данные installer должны быть вне заменяемого дерева.');
  }

  for (const value of paths) {
    await assertConfiguredPath(value, value === config.pluginInstallsStatePath);
  }

  const versionPath = path.join(config.rootDir, 'VERSION');

  await assertConfiguredPath(versionPath, true);

  const handle = await open(versionPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let grigDeskVersion: string;

  try {
    const info = await handle.stat();

    if (!info.isFile() || info.size > 4096) {
      throw new TypeError('VERSION должен быть небольшим обычным файлом.');
    }

    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    grigDeskVersion = buffer.subarray(0, bytesRead).toString('utf8').trim();

    if (bytesRead > 4096 || !parseSemVer(grigDeskVersion)) {
      throw new TypeError('VERSION содержит некорректную версию GrigDesk.');
    }
  } finally {
    await handle.close();
  }

  return {
    pluginsDir,
    statePath,
    grigDeskVersion,
  };
}

/**
 * Проверка не создаёт отсутствующие roots и не следует по symlink ancestors.
 * State/VERSION допускают обычный файл лишь последним компонентом пути.
 */
async function assertConfiguredPath(value: string, file: boolean): Promise<void> {
  const absolute = path.resolve(value);
  const components = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;

  for (const [index, component] of components.entries()) {
    current = path.join(current, component);

    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    if (info && (info.isSymbolicLink() || (file && index === components.length - 1
      ? !info.isFile() : !info.isDirectory()))) {
      throw new TypeError('Configured path installer содержит ссылку или неподдерживаемый тип.');
    }
  }
}
