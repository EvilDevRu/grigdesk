import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Каталог данных не пересекается с заменяемым деревом ни в одном направлении.
 * Все предки проверяются без следования по ссылкам до import доверенного кода.
 */
export async function preparePluginDataRoot(pluginsDir: string, dataRoot: string): Promise<string> {
  if (!path.isAbsolute(pluginsDir) || !path.isAbsolute(dataRoot)) {
    throw new TypeError('Каталоги плагинов и данных должны быть абсолютными.');
  }

  const plugins = path.resolve(pluginsDir);
  const data = path.resolve(dataRoot);
  const overlaps = data === plugins || data.startsWith(plugins + path.sep)
    || plugins.startsWith(data + path.sep);

  if (overlaps) {
    throw new TypeError('Каталог данных пересекается с заменяемым деревом плагинов.');
  }

  await assertDirectories(plugins, false);
  await assertDirectories(data, true);

  if (await realpath(data) !== data) {
    throw new TypeError('Каталог данных изменил canonical path.');
  }

  return data;
}

/**
 * Собственная папка id создаётся с 0700 до выполнения server.js.
 * Повторная проверка предков обнаруживает замену пути между загрузками.
 */
export async function preparePluginDataDir(dataRoot: string, id: string): Promise<string> {
  const directory = path.join(dataRoot, id);

  await assertDirectories(directory, true);

  return directory;
}

/**
 * Единственный отсутствующий компонент создаётся после проверки его родителей.
 * Существующие файлы и ссылки отвергаются вместо mkdir с последующим import.
 */
async function assertDirectories(absolute: string, create: boolean): Promise<void> {
  let current = path.parse(absolute).root;

  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);

    let info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    if (!info && create) {
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }

    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      throw new TypeError('Путь данных или плагинов содержит ссылку либо обычный файл.');
    }
  }
}
