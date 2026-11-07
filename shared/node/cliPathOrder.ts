import path from 'node:path';

export interface UserCliDirectories {
  explicit: string[];
  defaults: string[];
  discovered: string[];
}

/**
 * Найденные каталоги передаются готовыми: ранний граф только упорядочивает PATH.
 * Поиск файлов и каталогов принадлежит отдельной подготовке запуска.
 */
export interface PackagedCliInput extends UserCliDirectories {
  installationBin: string;
  saved: readonly string[];
}

/**
 * Один синхронный порядок CLI применяется ко всем способам packaged-запуска.
 * Относительный или пустой элемент не открывает поиск команды в cwd задачи.
 */
export function userCliPath(input: {
  installationBin: string;
  bundledNode: string;
  explicit: readonly string[];
  saved: readonly string[];
  defaults: readonly string[];
  inherited: string;
  discovered: readonly string[];
}): string {
  const nodeDirectory = path.dirname(input.bundledNode);
  const entries = [input.installationBin, ...input.explicit, ...input.saved,
    ...input.defaults, ...input.inherited.split(':'), ...input.discovered];
  const selected = entries.filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.normalize(entry)).filter((entry) => entry !== nodeDirectory);

  return [...new Set([...selected, nodeDirectory])].join(':');
}
