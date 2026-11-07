import { readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Генератор таблиц реестров для SEA-сборки.
 *
 * Обходит каталоги по тем же правилам, что исходные registryTable.ts и
 * engineDirectory.ts, и выпускает модули с литеральными импортами: esbuild
 * включает адаптеры в CJS-бандл, а ядро не получает список провайдеров вручную.
 */

export interface RegistryEntry {
  name: string;
  file: string;
}

export interface RegistryTables {
  executorTable: string;
  engineTable: string;
}

const EXECUTOR_EXTENSIONS = ['.js', '.ts'];
const NOT_ADAPTERS = new Set(['index', 'registryTable']);

/**
 * Перечисляет файлы исполнителей по нынешним правилам.
 * Пара .js/.ts с одним именем — прежняя ошибка «объявлен дважды», а не выбор одного.
 */
export function executorEntries(dir: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  const seen = new Set<string>();

  for (const file of readdirSync(dir).sort()) {
    if (file.startsWith('_')) {
      continue;
    }

    const extension = EXECUTOR_EXTENSIONS.find((suffix) => file.endsWith(suffix));

    if (!extension) {
      continue;
    }

    const name = file.slice(0, -extension.length);

    if (NOT_ADAPTERS.has(name)) {
      continue;
    }

    if (seen.has(name)) {
      throw new Error(`Исполнитель ${name} объявлен дважды: убери лишний файл в ${dir}`);
    }

    seen.add(name);
    entries.push({
      name,
      file: path.join(dir, file),
    });
  }

  return entries;
}

/**
 * Перечисляет движки БД по расширениям реестра.
 * Порядок — имя файла, как у прежнего чтения каталога.
 */
export function engineEntries(dir: string): RegistryEntry[] {
  return readdirSync(dir)
    .filter((name) => /\.(?:m?[jt]s)$/u.test(name))
    .sort()
    .map((name) => ({
      name,
      file: path.join(dir, name),
    }));
}

/**
 * Строит относительный import-спецификатор от выходного модуля к адаптеру.
 * Абсолютные пути checkout в сгенерированный исходник не попадают.
 */
function relativeSpecifier(outputFile: string, targetFile: string): string {
  const relative = path.relative(path.dirname(outputFile), targetFile).split(path.sep).join('/');

  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Выпускает модуль таблицы исполнителей с ленивыми литеральными импортами.
 * Имя файла остаётся в записи для диагностики дублей и ошибок загрузки.
 */
export function renderExecutorTable(entries: readonly RegistryEntry[], outputFile: string): string {
  const loads = entries.map((entry) => [
    '    {',
    `      name: ${JSON.stringify(entry.name)},`,
    `      file: ${JSON.stringify(path.basename(entry.file))},`,
    `      load: () => import(${JSON.stringify(relativeSpecifier(outputFile, entry.file))}),`,
    '    },',
  ].join('\n')).join('\n');

  return `// Сгенерировано server/scripts/sea/registries.mts. Не редактировать вручную.
export interface ExecutorModule {
  default?: unknown;
}

export interface ExecutorLoader {
  name: string;
  file: string;
  load: () => Promise<ExecutorModule>;
}

/**
 * Ленивые загрузчики исполнителей в порядке имён файлов.
 * Литеральные import позволяют esbuild включить каждый адаптер в бандл.
 */
export function executorLoaders(): ExecutorLoader[] {
  return [
${loads}
  ];
}
`;
}

/**
 * Выпускает модуль таблицы движков БД с ленивыми литеральными импортами.
 * Явный dir в createEngineRegistry продолжает идти через engineDirectory.ts.
 */
export function renderEngineTable(entries: readonly RegistryEntry[], outputFile: string): string {
  const loads = entries.map((entry) => [
    '    {',
    `      name: ${JSON.stringify(entry.name)},`,
    `      load: () => import(${JSON.stringify(relativeSpecifier(outputFile, entry.file))}),`,
    '    },',
  ].join('\n')).join('\n');

  return `// Сгенерировано server/scripts/sea/registries.mts. Не редактировать вручную.
import type { DbEngineLoader } from './engineDirectory.ts';

/**
 * Ленивые загрузчики движков БД в порядке имён файлов.
 * Литеральные import включают каждый движок в SEA-бандл.
 */
export async function dbEngineLoaders(): Promise<DbEngineLoader[]> {
  return [
${loads}
  ];
}
`;
}

/**
 * Генерирует обе таблицы рядом с их будущими модулями.
 * Ошибка дубля исполнителей возникает до записи любого из файлов.
 */
export async function writeRegistryTables(input: {
  executorsDir: string;
  enginesDir: string;
}): Promise<RegistryTables> {
  const executorTable = path.join(input.executorsDir, 'registryTable.ts');
  const engineTable = path.join(path.dirname(input.enginesDir), 'engineTable.ts');
  const executorSource = renderExecutorTable(executorEntries(input.executorsDir), executorTable);
  const engineSource = renderEngineTable(engineEntries(input.enginesDir), engineTable);

  await writeFile(executorTable, executorSource);
  await writeFile(engineTable, engineSource);

  return {
    executorTable,
    engineTable,
  };
}
