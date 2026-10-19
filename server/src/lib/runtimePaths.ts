import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runtimeBuildContext } from './runtimeBuildContext.ts';
import type { RuntimeBuildContext } from './runtimeBuildContext.ts';

/**
 * Единый контракт путей сервера.
 *
 * Исходники, SEA и упакованный helper получают один и тот же набор функций, но
 * разные корни. Режим задаёт код сборки через runtimeBuildContext; переменная
 * окружения не может незаметно переключить packaged-сборку на исходники.
 */

export type RuntimeMode = RuntimeBuildContext['mode'];
export type RuntimeKind = 'source' | 'packaged';

export interface RuntimePaths {
  mode: RuntimeMode;
  kind: RuntimeKind;
  root: string;
  node: string;
  execPath: string;
  helperDirectory: string;
}

export interface HelperEntry {
  id: string;
  entry: string;
  description: string;
}

export interface HelperCatalog {
  schema: number;
  helpers: HelperEntry[];
}

export interface HelperCommand {
  command: string;
  args: string[];
}

const HELPER_ID = /^[a-z0-9][a-z0-9-]*$/u;
let cachedPaths: RuntimePaths | undefined;

/**
 * Вычисляет физический R из пути SEA-бинарника.
 * Символическая ссылка на запускалку не меняет корень комплекта.
 */
export function packagedRootFromExecPath(execPath: string): string {
  if (!path.isAbsolute(execPath)) {
    throw new Error(`SEA: ожидался абсолютный execPath, получено «${execPath}»`);
  }

  const physical = realpathSync(execPath);

  return path.dirname(path.dirname(physical));
}

/**
 * Вычисляет R упакованного helper-а по его фактическому .mjs URL.
 * Helper лежит в R/server/runtime/helpers, поэтому поднимаемся на четыре уровня.
 */
export function helperRootFromUrl(helperUrl: string): string {
  const physical = realpathSync(fileURLToPath(helperUrl));

  return path.dirname(path.dirname(path.dirname(path.dirname(physical))));
}

/**
 * Строит контракт путей из явного контекста сборки.
 * Функция не читает .env, не создаёт каталогов и не запускает процессов.
 */
export function createRuntimePaths(context: RuntimeBuildContext): RuntimePaths {
  if (context.mode === 'source') {
    if (!path.isAbsolute(context.root)) {
      throw new Error(`Исходный корень должен быть абсолютным: «${context.root}»`);
    }

    return {
      mode: context.mode,
      kind: 'source',
      root: context.root,
      node: context.execPath,
      execPath: context.execPath,
      helperDirectory: path.join(context.root, 'server/runtime/helpers'),
    };
  }

  const root = context.mode === 'sea'
    ? packagedRootFromExecPath(context.execPath)
    : helperRootFromUrl(context.helperUrl);

  return {
    mode: context.mode,
    kind: 'packaged',
    root,
    node: path.join(root, 'runtime/node/bin/node'),
    execPath: context.mode === 'sea'
      ? realpathSync(context.execPath)
      : fileURLToPath(context.helperUrl),
    helperDirectory: path.join(root, 'server/runtime/helpers'),
  };
}

/**
 * Возвращает путь вложенного Node комплекта и отказывает, если его нет.
 * В source-режиме это Node текущего процесса; поиск в PATH запрещён.
 */
export function nodeExecutableFor(paths: RuntimePaths): string {
  if (paths.kind === 'source') {
    return paths.node;
  }

  if (!existsSync(paths.node)) {
    throw new Error(`Повреждён комплект: нет вложенного Node по пути ${paths.node}`);
  }

  return paths.node;
}

/**
 * Превращает относительный путь модуля в file URL внутри своего корня.
 * Абсолютный путь и выход за корень отвергаются с исходным значением.
 */
export function moduleUrlFor(paths: RuntimePaths, relativePath: string): URL {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`moduleUrl: нужен относительный путь, получено «${relativePath}»`);
  }

  const absolute = path.resolve(paths.root, relativePath);
  const prefix = paths.root.endsWith(path.sep) ? paths.root : `${paths.root}${path.sep}`;

  if (absolute !== paths.root && !absolute.startsWith(prefix)) {
    throw new Error(`moduleUrl: путь «${relativePath}» выходит за корень ${paths.root}`);
  }

  return pathToFileURL(absolute);
}

/**
 * Проверяет каталог helper-ов и возвращает разобранный каталог.
 * Ошибки называют файл и конкретное нарушение схемы.
 */
export function readHelperCatalog(file: string): HelperCatalog {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'ENOENT') {
      throw new Error(`Нет каталога helper-ов: ${file}`);
    }

    throw new Error(`Каталог helper-ов не читается: ${file}: ${(error as Error).message}`);
  }

  const record = parsed as Partial<HelperCatalog> | null;

  if (!record || record.schema !== 1 || !Array.isArray(record.helpers) || record.helpers.length === 0) {
    throw new Error(`Некорректный каталог helper-ов: ${file}`);
  }

  const seen = new Set<string>();

  for (const helper of record.helpers) {
    if (!helper || typeof helper.id !== 'string' || !HELPER_ID.test(helper.id)) {
      throw new Error(`Некорректный id helper-а в ${file}: ${String(helper?.id)}`);
    }

    if (seen.has(helper.id)) {
      throw new Error(`Повтор id helper-а в ${file}: ${helper.id}`);
    }

    if (typeof helper.entry !== 'string' || path.isAbsolute(helper.entry)
      || helper.entry.startsWith('../') || helper.entry === '') {
      throw new Error(`Некорректный entry helper-а ${helper.id} в ${file}`);
    }

    seen.add(helper.id);
  }

  return {
    schema: 1,
    helpers: record.helpers,
  };
}

/**
 * Собирает команду helper-а по каталогу и режиму путей.
 * В source запускается исходный вход, в комплекте — собранный .mjs вложенным Node.
 */
export function helperCommandFor(paths: RuntimePaths, catalog: HelperCatalog,
  id: string, args: readonly string[]): HelperCommand {
  const helper = catalog.helpers.find((entry) => entry.id === id);

  if (!helper) {
    throw new Error(`Неизвестный helper: ${id}`);
  }

  const command = nodeExecutableFor(paths);
  const entry = paths.kind === 'source'
    ? path.resolve(paths.root, helper.entry)
    : path.join(paths.helperDirectory, `${id}.mjs`);

  return {
    command,
    args: [entry, ...args],
  };
}

/**
 * Загружает каталог helper-ов из ожидаемого места своего режима.
 * Чтение ленивое: импорт модуля не трогает файловую систему.
 */
function loadHelperCatalog(paths: RuntimePaths): HelperCatalog {
  const file = paths.kind === 'source'
    ? path.join(paths.root, 'server/build/helpers.json')
    : path.join(paths.helperDirectory, 'helpers.json');

  return readHelperCatalog(file);
}

/**
 * Возвращает контракт путей текущего процесса; вычисление кэшируется.
 * Контекст приходит из runtimeBuildContext, который сборщик подменяет.
 */
function currentPaths(): RuntimePaths {
  cachedPaths ??= createRuntimePaths(runtimeBuildContext());

  return cachedPaths;
}

/**
 * Возвращает вид текущего процесса: source или packaged.
 * Режим задаёт контекст сборки, а не переменная окружения.
 */
export function runtimeKind(): RuntimeKind {
  return currentPaths().kind;
}

/**
 * Возвращает корень текущего дерева или комплекта.
 * Для SEA это физический каталог R, вычисленный от execPath.
 */
export function runtimeRoot(): string {
  return currentPaths().root;
}

/**
 * Возвращает Node для дочерних helper-ов текущего режима.
 * В комплекте отсутствие вложенного Node — отказ, а не поиск в PATH.
 */
export function nodeExecutable(): string {
  return nodeExecutableFor(currentPaths());
}

/**
 * Возвращает file URL модуля по прежнему относительному пути.
 * В комплекте путь ведёт в R, в исходниках — в корень дерева.
 */
export function moduleUrl(relativePath: string): URL {
  return moduleUrlFor(currentPaths(), relativePath);
}

/**
 * Возвращает каталог модуля по его прежнему относительному пути.
 * Нужен для замен import.meta.dirname, у которых нет прямого URL-аналога.
 */
export function moduleDirname(relativePath: string): string {
  return path.dirname(fileURLToPath(moduleUrlFor(currentPaths(), relativePath)));
}

/**
 * Возвращает абсолютный путь модуля по его прежнему относительному пути.
 * Нужен для замен import.meta.filename в собственном коде.
 */
export function moduleFilename(relativePath: string): string {
  return fileURLToPath(moduleUrlFor(currentPaths(), relativePath));
}

/**
 * Собирает команду helper-а по текущему каталогу и режиму путей.
 * Неизвестный id отвергается до запуска процесса.
 */
export function helperCommand(id: string, args: readonly string[]): HelperCommand {
  const paths = currentPaths();

  return helperCommandFor(paths, loadHelperCatalog(paths), id, args);
}
