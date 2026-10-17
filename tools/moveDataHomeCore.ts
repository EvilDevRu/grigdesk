import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { sha256 } from '../shared/node/hash.ts';
import { errorText } from '../shared/lib/errors.ts';

import { windowAppPath } from '../cli/window.ts';
import { ACTIVE_UPDATE_STATUSES } from '../shared/runtime/cockpitUpdateContracts.ts';
import { dataHome, dataPath } from '../shared/runtime/dataHome.ts';
import { previewEnvFile, updateEnvFile } from '../server/src/lib/envFile.ts';

export interface MoveContext {
  codeRoot: string;
  home: string;
  userHome: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface SafetyGuard {
  testing: boolean;
  tempDir: string;
  repositoryRoot: string;
}

export interface MoveCheck {
  id: string;
  ok: boolean;
  message: string;
}

export interface MoveDeps {
  fs: typeof fs;
  checkRuntime: (context: MoveContext, sources: readonly string[]) => Promise<MoveCheck[]>;
  updateEnv: typeof updateEnvFile;
  checkpoint?: (name: string) => Promise<void>;
}

export interface MoveReport {
  code: number;
  messages: string[];
}

export interface MovePlan extends MoveReport {
  steps: string[];
  conditions: MoveCheck[];
  warnings: string[];
}

interface MoveEntry {
  key: string;
  source: string;
  target: string;
  placeholder?: string;
  original: boolean;
  mode: number;
  stub?: { bytes: string; mode: number };
}

interface MoveJournal {
  version: 1;
  codeRoot: string;
  home: string;
  userHome: string;
  completed: boolean;
  entries: MoveEntry[];
  done: string[];
  pending?: string;
  envBefore?: { hash: string; mode: number };
  envAfter?: { hash: string; mode: number };
  addedEnvKeys: string[];
}

interface Inspection {
  plan: MovePlan;
  journal: MoveJournal | null;
  entries: MoveEntry[];
}

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const active = new Set<string>(ACTIVE_UPDATE_STATUSES);
const stepNames = [
  'Подготовить папку и журнал',
  'Перенести состояние сервера и вложенные данные',
  'Сохранить исходный файл настроек и перенести его',
  'Перенести каталоги с отслеживаемыми заглушками',
  'Перенести ключи телефона',
  'Переписать пути файла настроек',
  'Переписать известные JSON',
  'Влить следы запуска',
  'Создать ссылки совместимости',
  'Завершить журнал',
];

/**
 * Проверяет границу по сегментам, чтобы /tmp-other не считался временной папкой.
 * Результат не зависит от файловой системы и пригоден до первого обращения к данным.
 */
export function inside(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));

  return relative === '' || (!relative.startsWith('../') && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Защищает живые данные от ошибочно настроенного теста до любых операций с файлами.
 * Настоящий корень допускается здесь только как аргумент чистой проверки отказа.
 */
export function assertSafeContext(context: MoveContext, guard: SafetyGuard): void {
  if (!guard.testing) {
    return;
  }

  const paths = [context.codeRoot, context.home, context.userHome];

  if (paths.some((value) => !path.isAbsolute(value) || !inside(guard.tempDir, value))
    || path.resolve(context.codeRoot) === path.resolve(guard.repositoryRoot)) {
    throw new Error('Тест переноса допускает только временную раскладку, отдельно от репозитория.');
  }
}

/**
 * Каждая публичная операция проверяет настоящее окружение тестового процесса.
 * Подмена зависимостей не может отключить защиту до первого обращения к файлам.
 */
function guardContext(context: MoveContext): void {
  assertSafeContext(context, {
    testing: process.env.NODE_TEST_CONTEXT !== undefined,
    tempDir: os.tmpdir(),
    repositoryRoot,
  });
  dataHome({ env: { COCKPIT_HOME: context.home }, home: context.userHome });
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Отсутствие пути — штатная ветка продолжения после переноса.
 * Ошибки доступа и ввода-вывода не превращаются в разрешение перезаписать имя.
 */
async function lstat(file: string, deps: MoveDeps): Promise<Stats | null> {
  try {
    return await deps.fs.lstat(file);
  } catch (error) {
    if (missing(error)) {
      return null;
    }

    throw error;
  }
}

/**
 * Читает только существующий обычный файл; ссылки не расширяют область операции.
 * Отсутствующий файл возвращает null, прочие отказы сохраняют причину.
 */
async function bytes(file: string, deps: MoveDeps): Promise<Buffer | null> {
  const stat = await lstat(file, deps);

  if (!stat) {
    return null;
  }

  if (!stat.isFile()) {
    throw new Error(`Ожидался обычный файл: ${file}`);
  }

  return deps.fs.readFile(file);
}

/**
 * Общая раскладка задаёт также обратное отображение для новых данных после переноса.
 * Вложенные источники перечислены отдельно, чтобы возвращать их раньше всего state.
 */
function mapping(context: MoveContext): MoveEntry[] {
  const rows: Array<[string, string, string, string?]> = [
    ['state', 'server/.state', 'state'],
    ['pluginData', '.state/plugins', 'state/plugins'],
    ['uiReleases', '.state/ui-releases', 'state/ui-releases'],
    ['mobileApk', '.state/mobile', 'state/mobile-apk'],
    ['env', '.env', '.env'],
    ...['chats', 'telegram', 'github', '3d', 'agents'].map((name): [string, string, string, string] =>
      [name, name, name, '.gitignore']),
    ['plugins', 'plugins', 'plugins', 'README.md'],
  ];
  const entries = rows.map(([key, source, target, placeholder]) => ({
    key,
    source: path.join(context.codeRoot, source),
    target: path.join(context.home, target),
    placeholder,
    original: false,
    mode: 0o700,
  }));

  entries.push({
    key: 'mobile',
    source: path.join(context.userHome, '.config/cockpit/mobile'),
    target: path.join(context.home, 'mobile'),
    placeholder: undefined,
    original: false,
    mode: 0o700,
  });

  return entries;
}

/**
 * Проверяет лексические границы до данных и канонические границы по существующим предкам.
 * Ссылка в пути не позволяет переносу выйти за временную фикстуру или попасть в дерево кода.
 */
async function checkPlacement(context: MoveContext, deps: MoveDeps): Promise<void> {
  const { codeRoot, home, userHome } = context;

  if (inside(codeRoot, home) || inside(home, codeRoot) || path.resolve(home) === path.resolve(userHome)) {
    throw new Error('Папка данных не должна совпадать с HOME или пересекаться с корнем кода.');
  }

  const parent = await deps.fs.realpath(path.dirname(home));
  const realHome = await lstat(home, deps)
    ? await deps.fs.realpath(home) : path.join(parent, path.basename(home));
  const realCode = await deps.fs.realpath(codeRoot);
  const realUser = await deps.fs.realpath(userHome);

  assertSafeContext({
    ...context,
    codeRoot: realCode,
    home: realHome,
    userHome: realUser,
  }, {
    testing: process.env.NODE_TEST_CONTEXT !== undefined,
    tempDir: os.tmpdir(),
    repositoryRoot,
  });

  if (inside(realCode, realHome) || inside(realHome, realCode) || realHome === realUser) {
    throw new Error('Каноническая папка данных пересекается с HOME или деревом кода.');
  }

  for (const entry of mapping(context)) {
    if (inside(entry.source, home) || inside(home, entry.source)) {
      throw new Error(`Папка пересекается с источником: ${entry.source}`);
    }
  }
}

/**
 * Принимает журнал только своей раскладки: повреждённый или чужой журнал не исполняется.
 * Пути сверяются с заново вычисленным отображением до использования записанных метаданных.
 */
async function readJournal(context: MoveContext, deps: MoveDeps): Promise<MoveJournal | null> {
  const content = await bytes(dataPath(context.home, 'moveJournal'), deps);

  if (!content) {
    return null;
  }

  const journal = JSON.parse(content.toString('utf8')) as MoveJournal;
  const expected = mapping(context);

  if (journal.version !== 1 || journal.codeRoot !== context.codeRoot || journal.home !== context.home
    || journal.userHome !== context.userHome || !Array.isArray(journal.entries)
    || journal.entries.length !== expected.length || !Array.isArray(journal.done)
    || !Array.isArray(journal.addedEnvKeys)) {
    throw new Error('Журнал переноса повреждён или принадлежит другой раскладке.');
  }

  for (const [index, entry] of journal.entries.entries()) {
    const target = expected[index];

    if (!target || entry.key !== target.key || entry.source !== target.source
      || entry.target !== target.target
      || entry.placeholder !== target.placeholder) {
      throw new Error('Пути журнала не соответствуют раскладке.');
    }
  }

  return journal;
}

/**
 * Запоминает исходные права и отслеживаемые заглушки до первой записи.
 * Каталог только с заглушкой не является данными и остаётся на месте.
 */
async function inspectEntries(context: MoveContext, deps: MoveDeps): Promise<MoveEntry[]> {
  const entries = mapping(context);

  for (const entry of entries) {
    const stat = await lstat(entry.source, deps);

    if (!stat) {
      continue;
    }

    if (stat.isSymbolicLink() || (entry.key === 'env' ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Источник имеет неподдержанный тип: ${entry.source}`);
    }

    entry.original = true;
    entry.mode = stat.mode & 0o777;

    if (entry.placeholder) {
      const names = await deps.fs.readdir(entry.source);
      const stubPath = path.join(entry.source, entry.placeholder);
      const stub = await bytes(stubPath, deps);

      entry.original = names.some((name) => name !== entry.placeholder);

      if (stub) {
        entry.stub = {
          bytes: stub.toString('base64'),
          mode: (await deps.fs.stat(stubPath)).mode & 0o777,
        };
      }
    }
  }

  return entries;
}

/**
 * Данные, снова появившиеся в коде после завершённого переноса: обычные файлы и непустые
 * каталоги, а не ссылки совместимости и не отслеживаемые заглушки. Команда их только называет.
 */
async function leftovers(context: MoveContext, deps: MoveDeps): Promise<string[]> {
  const found: string[] = [];

  for (const entry of mapping(context)) {
    const stat = await lstat(entry.source, deps);

    if (!stat || stat.isSymbolicLink()) {
      continue;
    }

    if (!stat.isDirectory()
      || (await deps.fs.readdir(entry.source)).some((name) => name !== entry.placeholder)) {
      found.push(entry.source);
    }
  }

  return found;
}

/**
 * Итог для завершённого журнала: перенос повторно не запускается, остатки называются.
 * Без этого сторож сервера советовал бы --apply, а --apply отвечал бы «нечего делать».
 */
async function completedReport(context: MoveContext, deps: MoveDeps): Promise<MoveReport> {
  const found = await leftovers(context, deps);

  if (!found.length) {
    return { code: 0, messages: ['Перенос завершён, нечего делать.'] };
  }

  return {
    code: 1,
    messages: [`Перенос уже завершён, но в коде снова есть данные: ${found.join(', ')}. `
      + `Перенесите их вручную в ${context.home} или удалите.`],
  };
}

/**
 * Проверяет следы запуска рекурсивно, без следования ссылкам.
 * Произвольные файлы допускаются только внутри версий интерфейса и APK.
 */
async function checkTraces(directory: string, deps: MoveDeps, relative = ''): Promise<void> {
  if (!await lstat(directory, deps)) {
    return;
  }

  for (const name of await deps.fs.readdir(directory)) {
    const file = path.join(directory, name);
    const key = relative ? `${relative}/${name}` : name;
    const stat = await deps.fs.lstat(file);

    if (key === '.move-lock') {
      continue;
    }

    if (stat.isSymbolicLink()) {
      throw new Error(`Посторонняя ссылка в папке: ${key}`);
    }

    if (stat.isDirectory()) {
      await checkTraces(file, deps, key);
    } else if (!/^state\/(?:cockpit-server\.log[^/]*|ui-releases\/.+|mobile-apk\/.+)$/.test(key)) {
      throw new Error(`Посторонний файл в папке: ${key}`);
    }
  }
}

/**
 * Значение упоминает путь, только если за ним идёт граница сегмента: `<код>/chats-old`
 * не упоминание `<код>/chats`. Нужна для ключей, где путь стоит внутри команды.
 */
function mentions(value: string, location: string): boolean {
  let index = value.indexOf(location);

  while (index >= 0) {
    const next = value[index + location.length];

    if (next === undefined || !/[\w.-]/.test(next)) {
      return true;
    }

    index = value.indexOf(location, index + 1);
  }

  return false;
}

/**
 * Переписывает только целое абсолютное значение с границей сегмента.
 * Вложенный источник выигрывает у общего state, чтобы обратный перенос был однозначным.
 */
function rewrite(value: string, entries: MoveEntry[], reverse: boolean): string {
  const pairs = entries.map((entry) => reverse
    ? [entry.target, entry.source] as const : [entry.source, entry.target] as const)
    .sort((left, right) => right[0].length - left[0].length);

  for (const [source, target] of pairs) {
    if (value === source || value.startsWith(source + '/')) {
      return target + value.slice(source.length);
    }
  }

  return value;
}

/**
 * Планирует правку настроек без записи; дубли изменяемого ключа означают отказ.
 * Для встроенных в команды путей возвращаются только имена ключей, без значений.
 */
function envChanges(content: Buffer | null, context: MoveContext, entries: MoveEntry[], reverse: boolean,
  journal: MoveJournal | null): { changes: Record<string, string | null>; notices: string[] } {
  const text = content?.toString('utf8') ?? '';
  const values = parseEnv(text) as Record<string, string>;
  const changes: Record<string, string | null> = {};
  const notices: string[] = [];
  const counts = new Map<string, number>();

  for (const line of text.split('\n')) {
    const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];

    if (name) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  for (const key of ['COCKPIT_HOME', 'COCKPIT_ENV_FILE']) {
    if (Object.hasOwn(values, key)) {
      throw new Error(`Ключ ${key} запрещён в файле настроек.`);
    }
  }

  for (const [key, value] of Object.entries(values)) {
    const next = rewrite(value, entries, reverse);

    if (next !== value) {
      if ((counts.get(key) ?? 0) > 1) {
        throw new Error(`Повторён ключ пути: ${key}`);
      }

      changes[key] = next;
    } else if (entries.some((entry) => mentions(value, reverse ? entry.target : entry.source))) {
      notices.push(`Встроенный путь оставлен без изменения: ${key}`);
    }
  }

  const compatibility = {
    COCKPIT_UI_RELEASES_DIR: dataPath(context.home, 'uiReleases'),
    COCKPIT_LOG: dataPath(context.home, 'log'),
  };

  for (const [key, value] of Object.entries(compatibility)) {
    if (!reverse && !Object.hasOwn(values, key)) {
      changes[key] = value;
    } else if (reverse && journal?.addedEnvKeys.includes(key) && values[key] === value) {
      changes[key] = null;
    }
  }

  previewEnvFile(content, changes);

  return { changes, notices };
}

/**
 * Находит только известные JSON, остальные файлы состояния остаются побайтно прежними.
 * Ссылки на месте известных файлов отвергаются общим читателем.
 */
async function jsonFiles(state: string, deps: MoveDeps): Promise<string[]> {
  const files = ['prefs.json', 'showcase-browser/browser.json'].map((name) => path.join(state, name));
  const sandboxes = path.join(state, 'sandboxes');

  if (await lstat(sandboxes, deps)) {
    for (const name of await deps.fs.readdir(sandboxes)) {
      if (name.endsWith('.json')) {
        files.push(path.join(sandboxes, name));
      }
    }
  }

  return files;
}

/**
 * Меняет строковые значения JSON, сохраняя форматирование и посторонние байты.
 * Сначала валидирует документ; имена полей не переписываются.
 */
function rewriteJson(content: Buffer, entries: MoveEntry[], reverse: boolean): {
  text: string;
  count: number;
} {
  const text = content.toString('utf8');

  try {
    JSON.parse(text);
  } catch {
    throw new Error('Документ JSON не разбирается.');
  }

  let count = 0;
  const next = text.replace(/"(?:\\.|[^"\\])*"/g, (token: string, offset: number) => {
    if (text.slice(offset + token.length).trimStart().startsWith(':')) {
      return token;
    }

    const value = JSON.parse(token) as string;
    const replaced = rewrite(value, entries, reverse);

    if (replaced === value) {
      return token;
    }

    count += 1;

    return JSON.stringify(replaced);
  });

  return { text: next, count };
}

/**
 * Выводит предупреждения о ссылках, не разыменовывая их содержимое.
 * Относительные ссылки внутри своего источника сохраняют назначение после rename.
 */
async function linkWarnings(entries: MoveEntry[], deps: MoveDeps): Promise<string[]> {
  const warnings: string[] = [];

  for (const entry of entries.filter((item) => item.original && item.key !== 'env')) {
    /**
     * Обходит только настоящий каталог текущего источника.
     * Символические ссылки учитываются как листья и не открываются.
     */
    const visit = async (directory: string): Promise<void> => {
      let names: string[];

      try {
        names = await deps.fs.readdir(directory);
      } catch (error) {
        if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw error;
        }

        warnings.push(`Каталог не прочитан, ссылки в нём не проверены: ${directory}`);

        return;
      }

      for (const name of names) {
        const file = path.join(directory, name);
        const stat = await deps.fs.lstat(file);

        if (stat.isSymbolicLink()) {
          const target = await deps.fs.readlink(file);
          const absolute = path.resolve(path.dirname(file), target);

          if ((!path.isAbsolute(target) && !inside(entry.source, absolute))
            || (path.isAbsolute(target) && entries.some((item) => inside(item.source, target)))) {
            warnings.push(`Ссылка может повиснуть: ${file}`);
          }
        } else if (stat.isDirectory()) {
          await visit(file);
        }
      }
    };

    await visit(entry.source);
  }

  return warnings;
}

/**
 * Собирает все отказы до первой записи; продолжение использует журнал и фактические пути.
 * Обратный перенос проверяет те же внешние условия на новой стороне раскладки.
 */
async function inspect(context: MoveContext, deps: MoveDeps, reverse = false): Promise<Inspection> {
  const conditions: MoveCheck[] = [];
  const warnings: string[] = [];
  let journal: MoveJournal | null = null;
  let entries = mapping(context);

  /**
   * Каждое условие сохраняет самостоятельный результат для сухого плана.
   * Исключение проверки становится отказом, остальные условия остаются видимыми.
   */
  const check = async (id: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
      conditions.push({
        id,
        ok: true,
        message: `${id}: да`,
      });
    } catch (error) {
      conditions.push({
        id,
        ok: false,
        message: `${id}: нет — ${errorText(error)}`,
      });
    }
  };

  await check('размещение', () => checkPlacement(context, deps));

  if (conditions.every((item) => item.ok)) {
    await check('журнал', async () => {
      journal = await readJournal(context, deps);
      entries = journal?.entries ?? await inspectEntries(context, deps);
    });
  }

  if (conditions.every((item) => item.ok)) {
    const sources = entries.flatMap((entry) => [entry.source, entry.target]);
    const runtime = await deps.checkRuntime(context, sources);

    conditions.push(...runtime.filter((item) => item.id !== 'factory'));
    warnings.push(...runtime.filter((item) => item.id === 'factory' && !item.ok).map((item) => item.message));

    await check('установка плагинов', async () => {
      const directory = path.join(reverse ? context.home : context.codeRoot,
        'plugins/.cockpit-install/transactions');

      if (await lstat(directory, deps) && (await deps.fs.readdir(directory)).length) {
        throw new Error('Есть незавершённые транзакции.');
      }
    });
    await check('публикация DeepSeek', async () => {
      if (await lstat(path.join(context.codeRoot, 'server/runtime/deepseek/publish-pending.json'), deps)) {
        throw new Error('Публикация не завершена.');
      }
    });
    await check('обновление', async () => {
      for (const state of [path.join(context.codeRoot, 'server/.state'), dataPath(context.home, 'state')]) {
        const filename = path.join(state, 'cockpit-update.json');

        if (await lstat(filename + '.job-lock', deps)) {
          throw new Error('Есть блокировка задания обновления.');
        }

        const content = await bytes(filename, deps);
        let job: { status?: string; workerPid?: unknown } | undefined;

        try {
          job = content ? JSON.parse(content.toString('utf8')).job : undefined;
        } catch {
          throw new Error(`Файл не разбирается как JSON: ${filename}`);
        }

        const workerPid = Number(job?.workerPid);
        // restarting без замка и без живого воркера значит: новый сервер не стартовал до переноса.
        // Задание подтвердит сервер после переноса; иначе сервер и перенос ждали бы друг друга.
        const stalled = job?.status === 'restarting' && !(workerPid > 0 && alive(workerPid));

        if (job?.status && active.has(job.status) && !stalled) {
          throw new Error('Обновление активно.');
        }
      }
    });
    await check('один диск', async () => {
      // stat идёт по ссылке: если папка — ссылка на другой диск, сравнивается настоящее место.
      const device = (await deps.fs.stat(await lstat(context.home, deps)
        ? context.home : path.dirname(context.home))).dev;

      for (const entry of entries) {
        const file = await lstat(entry.source, deps) ? entry.source : entry.target;

        if (await lstat(file, deps) && (await deps.fs.stat(file)).dev !== device) {
          throw new Error(`Другой диск: ${file}`);
        }
      }
    });
    await check('назначение', async () => {
      if (!journal && !reverse) {
        const leftover = path.join(context.codeRoot, 'server/.state/env.before-move');

        if (await lstat(leftover, deps)) {
          throw new Error(`Остался файл прошлого возврата ${leftover}: сверьте его с .env и удалите.`);
        }

        await checkTraces(context.home, deps);

        const state = entries.find((entry) => entry.key === 'state');

        const nested = entries.filter((item) => item.original
          && item.target.startsWith(context.home + '/state/'));

        for (const entry of nested) {
          if (state?.original
            && await lstat(path.join(state.source, path.relative(state.target, entry.target)), deps)) {
            throw new Error(`Назначение уже есть внутри старого state: ${entry.key}`);
          }
        }
      }
    });
    await check('сухая правка', async () => {
      const oldEnv = path.join(context.codeRoot, '.env');
      const targetEnv = dataPath(context.home, 'env');
      const env = reverse || await lstat(targetEnv, deps) ? targetEnv : oldEnv;
      const stat = await lstat(env, deps);
      const foreign = typeof process.getuid === 'function' && stat !== null && stat.uid !== process.getuid();

      // Общий писатель откажет на тех же условиях, но уже после переезда state: проверяем до него.
      if (stat && (stat.nlink > 1 || stat.size > 1024 * 1024 || foreign)) {
        throw new Error(`${env}: у файла настроек есть жёсткие ссылки, он больше 1 МиБ или чужой.`);
      }

      envChanges(await bytes(env, deps), context, entries, reverse, journal);

      for (const state of [path.join(context.codeRoot, 'server/.state'), dataPath(context.home, 'state')]) {
        if ((await lstat(state, deps))?.isSymbolicLink()) {
          continue;
        }

        for (const file of await jsonFiles(state, deps)) {
          const content = await bytes(file, deps);

          try {
            if (content) {
              rewriteJson(content, entries, reverse);
            }
          } catch {
            throw new Error(`Файл не разбирается как JSON: ${file}`);
          }
        }
      }
    });

    if (!journal) {
      warnings.push(...await linkWarnings(entries, deps));
    }
  }

  const code = conditions.every((item) => item.ok) ? 0 : 1;

  return {
    journal,
    entries,
    plan: {
      code,
      messages: conditions.map((item) => item.message),
      steps: entries.some((entry) => entry.original) ? [...stepNames,
        ...entries.filter((entry) => entry.original)
          .map((entry) => `Перенести ${entry.source} → ${entry.target}`)] : [],
      conditions,
      warnings,
    },
  };
}

/**
 * Возвращает только план и результаты условий без создания папки, замка или журнала.
 * Исключение защиты не скрывается обычным отказом условий.
 */
export async function planMove(context: MoveContext, deps: MoveDeps): Promise<MovePlan> {
  guardContext(context);

  try {
    await checkPlacement(context, deps);

    if ((await readJournal(context, deps))?.completed) {
      return {
        ...await completedReport(context, deps),
        steps: [],
        conditions: [],
        warnings: [],
      };
    }

    return (await inspect(context, deps)).plan;
  } catch (error) {
    return {
      code: 1,
      messages: [errorText(error)],
      steps: [],
      conditions: [],
      warnings: [],
    };
  }
}

/**
 * Синхронизирует запись каталога после изменения имени.
 * Ошибка fsync останавливает шаг: журнал не должен обещать недолговечную запись.
 */
async function syncDir(directory: string, deps: MoveDeps): Promise<void> {
  const handle = await deps.fs.open(directory, 'r');

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Атомарно пишет файл рядом с целью, сохраняя права и синхронизируя каталог.
 * Первое имя журнала создаётся через link с EEXIST вместо перезаписи чужого файла.
 */
async function atomicFile(file: string, content: string | Buffer, mode: number, deps: MoveDeps,
  exclusive = false): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await deps.fs.open(temporary, 'wx', mode);

  try {
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
  } catch (error) {
    await deps.fs.unlink(temporary).catch(() => undefined);

    throw error;
  } finally {
    await handle.close();
  }

  try {
    if (exclusive) {
      await deps.fs.link(temporary, file);
      await deps.fs.unlink(temporary);
    } else {
      await deps.fs.rename(temporary, file);
    }

    await syncDir(path.dirname(file), deps);
  } finally {
    await deps.fs.unlink(temporary).catch((error) => {
      if (!missing(error)) {
        throw error;
      }
    });
  }
}

/**
 * Сохраняет состояние до и после каждого шага одним атомарным документом.
 * Фактический rename всё равно перепроверяется при повторе незавершённого шага.
 */
async function saveJournal(journal: MoveJournal, deps: MoveDeps, exclusive = false): Promise<void> {
  await atomicFile(dataPath(journal.home, 'moveJournal'), JSON.stringify(journal, null, 2) + '\n',
    0o600, deps, exclusive);
}

/**
 * Читает идентичность процесса для защиты от повторного использования PID.
 * Отсутствующий /proc не означает, что процесс мёртв: это решает kill(pid, 0).
 */
async function starttime(pid: number): Promise<string | null> {
  try {
    const content = await fs.readFile(`/proc/${pid}/stat`, 'utf8');

    return content.slice(content.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Проверяет PID без сигнала; EPERM означает существующий процесс.
 * Нечисловой или неположительный PID никогда не передаётся системному вызову.
 */
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Создаёт замок с O_EXCL и перехватывает только доказанно мёртвую запись.
 * Сравнение после rename не даёт незаметно сорвать замок нового владельца.
 */
async function takeLock(context: MoveContext, deps: MoveDeps): Promise<() => Promise<void>> {
  const file = dataPath(context.home, 'moveLock');
  const identity = JSON.stringify({ pid: process.pid, starttime: await starttime(process.pid) });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await deps.fs.open(file, 'wx', 0o600);

      try {
        await handle.writeFile(identity);
        await handle.sync();
      } finally {
        await handle.close();
      }

      return async () => {
        if ((await bytes(file, deps))?.toString('utf8') === identity) {
          await deps.fs.unlink(file);
          await syncDir(context.home, deps);
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    const previous = await bytes(file, deps);
    let owner: { pid: number; starttime: string | null } | null = null;

    try {
      owner = JSON.parse(previous?.toString('utf8') ?? 'null');
    } catch {
      // Нечитаемый JSON сравнивается побайтно перед перехватом как мёртвый замок.
    }

    if (owner && alive(owner.pid)) {
      const current = await starttime(owner.pid);

      if (current === null || current === owner.starttime) {
        throw new Error(`Перенос уже выполняется, pid ${owner.pid}.`);
      }
    }

    const stale = `${file}.stale-${randomUUID()}`;

    await deps.fs.rename(file, stale);

    if (!(await bytes(stale, deps))?.equals(previous ?? Buffer.alloc(0))) {
      await deps.fs.link(stale, file).catch(() => undefined);

      throw new Error('Владелец замка изменился во время перехвата.');
    }

    await deps.fs.unlink(stale);
  }

  throw new Error('Не удалось взять блокировку переноса.');
}

/**
 * Переименовывает каталог только в свободное имя и сбрасывает оба родителя.
 * После фактического rename тест может оборвать шаг до записи его завершения.
 */
async function renameEntry(entry: MoveEntry, deps: MoveDeps): Promise<void> {
  const source = await lstat(entry.source, deps);
  const target = await lstat(entry.target, deps);

  if (!source || source.isSymbolicLink()) {
    return;
  }

  if (target) {
    if (entry.placeholder
      && (await deps.fs.readdir(entry.source)).every((name) => name === entry.placeholder)) {
      return;
    }

    throw new Error(`Назначение занято: ${entry.target}`);
  }

  await deps.fs.mkdir(path.dirname(entry.target), { recursive: true, mode: 0o700 });
  await deps.fs.rename(entry.source, entry.target);
  await syncDir(path.dirname(entry.source), deps);
  await syncDir(path.dirname(entry.target), deps);
  await deps.checkpoint?.(`rename:${entry.key}`);
}

/**
 * Возвращает отслеживаемую заглушку в код после переноса каталога.
 * Две жёсткие ссылки после прерывания распознаются по inode и сводятся к одному имени.
 */
async function restoreStub(entry: MoveEntry, deps: MoveDeps): Promise<void> {
  if (!entry.placeholder) {
    return;
  }

  await deps.fs.mkdir(entry.source, { recursive: true, mode: entry.mode });
  await deps.fs.chmod(entry.source, entry.mode);

  const source = path.join(entry.target, entry.placeholder);
  const target = path.join(entry.source, entry.placeholder);
  const old = await lstat(source, deps);
  const existing = await lstat(target, deps);

  if (old && !existing) {
    await deps.fs.link(source, target);
    await syncDir(entry.source, deps);
    await deps.fs.unlink(source);
    await syncDir(entry.target, deps);
  } else if (old && existing && old.ino === existing.ino && old.dev === existing.dev) {
    await deps.fs.unlink(source);
  } else if (!existing && entry.stub) {
    await atomicFile(target, Buffer.from(entry.stub.bytes, 'base64'), entry.stub.mode, deps, true);
  }
}

/**
 * Переносит файл настроек через link/unlink, не заменяя занятое назначение.
 * Копия исходных байтов создаётся только один раз с COPYFILE_EXCL.
 */
async function moveEnv(journal: MoveJournal, deps: MoveDeps): Promise<void> {
  const entry = journal.entries.find((item) => item.key === 'env')!;

  if (!entry.original) {
    return;
  }

  const backup = path.join(journal.home, 'state/env.before-move');
  const old = await lstat(entry.source, deps);
  const existing = await lstat(entry.target, deps);

  if (!await lstat(backup, deps)) {
    await deps.fs.copyFile(old && !old.isSymbolicLink() ? entry.source : entry.target, backup,
      constants.COPYFILE_EXCL);
    await deps.fs.chmod(backup, 0o600);

    const handle = await deps.fs.open(backup, 'r');

    await handle.sync();
    await handle.close();
    await syncDir(path.dirname(backup), deps);
  }

  if (journal.envBefore && sha256((await bytes(backup, deps))!) !== journal.envBefore.hash) {
    throw new Error('Исходная копия файла настроек повреждена; перенос остановлен.');
  }

  if (old && !old.isSymbolicLink()) {
    if (!existing) {
      await deps.fs.link(entry.source, entry.target);
      await syncDir(journal.home, deps);
    } else if (old.ino !== existing.ino || old.dev !== existing.dev) {
      throw new Error('Назначение файла настроек занято.');
    }

    await deps.fs.unlink(entry.source);
    await syncDir(journal.codeRoot, deps);
  }

  await deps.fs.chmod(entry.target, 0o600);
}

/**
 * Переписывает известные JSON атомарно с сохранением прав и пробелов документа.
 * Список замен выдаёт только имя файла и число, без значений настроек.
 */
async function updateJson(state: string, entries: MoveEntry[], reverse: boolean, deps: MoveDeps,
  messages: string[]): Promise<void> {
  for (const file of await jsonFiles(state, deps)) {
    const content = await bytes(file, deps);

    if (!content) {
      continue;
    }

    let result: ReturnType<typeof rewriteJson>;

    try {
      result = rewriteJson(content, entries, reverse);
    } catch {
      throw new Error(`Файл не разбирается как JSON: ${file}`);
    }

    if (result.count) {
      await atomicFile(file, result.text, (await deps.fs.stat(file)).mode & 0o777, deps);
      messages.push(`JSON ${path.relative(state, file)}: замен ${result.count}`);
    }
  }
}

/**
 * Подбирает свободное имя для следов запуска, не перезаписывая другой журнал или APK.
 * Суффикс предсказуем для человека, но проверяется заново на каждом повторе шага.
 */
async function freeName(file: string, deps: MoveDeps): Promise<string> {
  let selected = file;
  let index = 0;

  while (await lstat(selected, deps)) {
    index += 1;
    selected = `${file}.${index}`;
  }

  return selected;
}

/**
 * Вливает только разрешённые следы запуска, которые были вынесены до переноса state.
 * Одинаковый идентификатор интерфейса означает дубль; журналы и APK сохраняются отдельно.
 */
async function mergeTraces(context: MoveContext, deps: MoveDeps): Promise<void> {
  const pre = path.join(context.home, '.pre-move');

  if (!await lstat(pre, deps)) {
    return;
  }

  const oldState = path.join(pre, 'state');

  if (await lstat(oldState, deps)) {
    for (const name of await deps.fs.readdir(oldState)) {
      const source = path.join(oldState, name);

      if (name.startsWith('cockpit-server.log')) {
        const target = await freeName(dataPath(context.home, 'log') + '.pre-move', deps);

        await deps.fs.rename(source, target);
        await syncDir(oldState, deps);
        await syncDir(path.dirname(target), deps);
      } else if (name === 'ui-releases' || name === 'mobile-apk') {
        const destination = path.join(context.home, 'state', name);

        await deps.fs.mkdir(destination, { recursive: true, mode: 0o700 });

        for (const item of await deps.fs.readdir(source)) {
          let target = path.join(destination, item);
          const incoming = path.join(source, item);

          if (await lstat(target, deps)) {
            if (name === 'ui-releases') {
              await deps.fs.rm(incoming, { recursive: true });
              continue;
            }

            target = await freeName(target + '.pre-move', deps);
          }

          await deps.fs.rename(incoming, target);
          await syncDir(destination, deps);
          await syncDir(source, deps);
        }
      }
    }
  }

  await deps.fs.rm(pre, { recursive: true });
  await syncDir(context.home, deps);
}

/**
 * Выполняет один журналируемый шаг, не повторяя уже подтверждённый эффект.
 * Незавершённый шаг обязан сам сходиться по lstat источника и назначения.
 */
async function step(journal: MoveJournal, name: string, deps: MoveDeps,
  action: () => Promise<void>): Promise<void> {
  if (journal.done.includes(name)) {
    return;
  }

  journal.pending = name;
  await saveJournal(journal, deps);
  await action();
  journal.done.push(name);
  delete journal.pending;
  await saveJournal(journal, deps);
}

/**
 * Исполняет перенос только после всех проверок и под единственным замком.
 * При сбое оставляет журнал и фактические данные для повторного apply или back.
 */
export async function applyMove(context: MoveContext, deps: MoveDeps): Promise<MoveReport> {
  guardContext(context);

  let unlock: (() => Promise<void>) | undefined;
  const messages: string[] = [];

  try {
    await checkPlacement(context, deps);

    const previous = await readJournal(context, deps);

    if (previous?.completed) {
      return await completedReport(context, deps);
    }

    const inspected = await inspect(context, deps);

    if (inspected.plan.code) {
      return inspected.plan;
    }

    await deps.fs.mkdir(context.home, { recursive: true, mode: 0o700 });

    if (!inspected.entries.some((entry) => entry.original) && !inspected.journal) {
      await deps.fs.chmod(context.home, 0o700);

      return { code: 0, messages: ['Нечего переносить; папка подготовлена.'] };
    }

    unlock = await takeLock(context, deps);
    await deps.fs.chmod(context.home, 0o700);

    const journal: MoveJournal = inspected.journal ?? {
      version: 1,
      codeRoot: context.codeRoot,
      home: context.home,
      userHome: context.userHome,
      completed: false,
      entries: inspected.entries,
      done: [],
      addedEnvKeys: [],
    };

    if (!inspected.journal) {
      const originalEnv = await bytes(path.join(context.codeRoot, '.env'), deps);

      if (originalEnv) {
        journal.envBefore = {
          hash: sha256(originalEnv),
          mode: (await deps.fs.stat(path.join(context.codeRoot, '.env'))).mode & 0o777,
        };
      }

      const planned = envChanges(originalEnv, context, journal.entries, false, journal);
      const values = parseEnv(originalEnv?.toString('utf8') ?? '');

      journal.addedEnvKeys = Object.keys(planned.changes).filter((key) => !Object.hasOwn(values, key));
      await saveJournal(journal, deps, true);
    }

    await step(journal, 'traces', deps, async () => {
      const pre = path.join(context.home, '.pre-move');

      for (const name of await deps.fs.readdir(context.home)) {
        if (['.move-journal.json', '.move-lock', '.pre-move'].includes(name)) {
          continue;
        }

        await deps.fs.mkdir(pre, { recursive: true, mode: 0o700 });
        await deps.fs.rename(path.join(context.home, name), path.join(pre, name));
        await syncDir(pre, deps);
        await syncDir(context.home, deps);
      }
    });

    const state = journal.entries.find((entry) => entry.key === 'state')!;

    for (const entry of journal.entries.filter((item) => ['state', 'pluginData', 'uiReleases', 'mobileApk']
      .includes(item.key))) {
      await step(journal, entry.key, deps, async () => {
        if (entry.original) {
          await renameEntry(entry, deps);
        }

        await deps.fs.mkdir(state.target, { recursive: true, mode: 0o700 });
        await deps.fs.chmod(state.target, 0o700);
      });
    }

    await step(journal, 'env', deps, () => moveEnv(journal, deps));

    for (const entry of journal.entries.filter((item) => item.placeholder && item.original)) {
      await step(journal, entry.key, deps, async () => {
        await renameEntry(entry, deps);
        await restoreStub(entry, deps);
      });
    }

    const mobile = journal.entries.find((entry) => entry.key === 'mobile')!;

    await step(journal, 'mobile', deps, async () => {
      if (mobile.original) {
        await renameEntry(mobile, deps);
      }
    });
    await step(journal, 'env-paths', deps, async () => {
      const file = dataPath(context.home, 'env');
      const content = await bytes(file, deps);
      const planned = envChanges(content, context, journal.entries, false, journal);

      const updated = await deps.updateEnv(file, planned.changes);

      messages.push(...updated.changed.map((key) => `Настройка переписана: ${key}`), ...planned.notices);
      journal.envAfter = { hash: sha256((await bytes(file, deps))!), mode: 0o600 };
    });
    await step(journal, 'json', deps, () => updateJson(state.target, journal.entries, false, deps, messages));
    await step(journal, 'merge-traces', deps, () => mergeTraces(context, deps));
    await step(journal, 'links', deps, async () => {
      for (const entry of journal.entries.filter((item) => item.key === 'env' || item.key === 'state')) {
        if (!await lstat(entry.target, deps)) {
          continue;
        }

        const existing = await lstat(entry.source, deps);

        if (!existing) {
          await deps.fs.symlink(entry.target, entry.source);
          await syncDir(path.dirname(entry.source), deps);
        } else if (!existing.isSymbolicLink() || await deps.fs.readlink(entry.source) !== entry.target) {
          throw new Error(`Место ссылки занято: ${entry.source}`);
        }
      }
    });
    journal.completed = true;
    await saveJournal(journal, deps);
    messages.push(...stepNames.map((name) => `${name}: готово`));
    messages.push('Перенос завершён.');

    return { code: 0, messages };
  } catch (error) {
    return { code: 1, messages: [...messages, errorText(error)] };
  } finally {
    await unlock?.();
  }
}

/**
 * Проверяет все старые места до первого обратного rename.
 * Разрешены только свои ссылки, заглушки и два имени одного файла после прерванного link.
 */
async function checkBackSlots(entries: MoveEntry[], deps: MoveDeps): Promise<void> {
  for (const entry of entries) {
    const target = await lstat(entry.target, deps);
    const source = await lstat(entry.source, deps);

    if (!target || !source) {
      continue;
    }

    if (source.isSymbolicLink() && await deps.fs.readlink(entry.source) === entry.target
      && ['state', 'env'].includes(entry.key)) {
      continue;
    }

    if (entry.placeholder && source.isDirectory()
      && (await deps.fs.readdir(entry.source)).every((name) => name === entry.placeholder)) {
      continue;
    }

    if (entry.key === 'env' && source.isFile() && source.ino === target.ino && source.dev === target.dev) {
      continue;
    }

    throw new Error(`Старое место занято: ${entry.source}`);
  }
}

/**
 * Возвращает исходные байты настроек только если после переноса их не изменяли.
 * Иначе сохраняет новые ключи, обращает пути и оставляет исходную копию человеку.
 */
async function backEnv(journal: MoveJournal, context: MoveContext, deps: MoveDeps,
  messages: string[]): Promise<void> {
  const file = dataPath(context.home, 'env');
  const current = await bytes(file, deps);

  if (!current) {
    return;
  }

  const backupFile = path.join(context.home, 'state/env.before-move');
  const backup = await bytes(backupFile, deps);
  const mode = (await deps.fs.stat(file)).mode & 0o777;
  let unchanged = Boolean(journal.envAfter && sha256(current) === journal.envAfter.hash
    && mode === journal.envAfter.mode);

  if (unchanged && !journal.envBefore) {
    await deps.fs.unlink(file);

    return;
  }

  if (backup && !journal.envAfter) {
    const forward = envChanges(backup, context, journal.entries, false, journal);
    const expected = previewEnvFile(backup, forward.changes).text;

    unchanged = mode === 0o600 && (current.equals(backup) || current.equals(Buffer.from(expected)));
  }

  if (backup && journal.envBefore && sha256(backup) !== journal.envBefore.hash) {
    throw new Error('Исходная копия файла настроек изменилась.');
  }

  if (unchanged && backup && journal.envBefore) {
    await atomicFile(file, backup, journal.envBefore.mode, deps);
    await deps.fs.unlink(backupFile);
  } else {
    const planned = envChanges(current, context, journal.entries, true, journal);

    await deps.updateEnv(file, planned.changes);

    if (backup) {
      messages.push('Исходная копия оставлена: server/.state/env.before-move');
    }
  }
}

/**
 * Возвращает один каталог, сохраняя отслеживаемую заглушку поверх созданной хранилищем.
 * Отсутствующее назначение означает уже выполненный шаг или отсутствовавший источник.
 */
async function returnEntry(entry: MoveEntry, deps: MoveDeps): Promise<void> {
  if (!await lstat(entry.target, deps)) {
    return;
  }

  let stub = entry.stub;

  if (entry.placeholder && await lstat(entry.source, deps)) {
    const file = path.join(entry.source, entry.placeholder);
    const content = await bytes(file, deps);

    if (content) {
      stub = {
        bytes: content.toString('base64'),
        mode: (await deps.fs.stat(file)).mode & 0o777,
      };
      await deps.fs.unlink(file);
    }

    await deps.fs.rmdir(entry.source);
  }

  await deps.fs.mkdir(path.dirname(entry.source), { recursive: true, mode: 0o700 });
  await deps.fs.rename(entry.target, entry.source);
  await syncDir(path.dirname(entry.target), deps);
  await syncDir(path.dirname(entry.source), deps);

  if (entry.original) {
    await deps.fs.chmod(entry.source, entry.mode);
  }

  if (entry.placeholder && stub) {
    await atomicFile(path.join(entry.source, entry.placeholder), Buffer.from(stub.bytes, 'base64'),
      stub.mode, deps);
  }
}

/**
 * Возвращает всю раскладку, включая данные, появившиеся уже после переноса.
 * Прерванный apply восстанавливается по существованию путей, без доверия только списку done.
 */
export async function backMove(context: MoveContext, deps: MoveDeps): Promise<MoveReport> {
  guardContext(context);

  let unlock: (() => Promise<void>) | undefined;
  const messages: string[] = [];

  try {
    const inspected = await inspect(context, deps, true);

    if (inspected.plan.code) {
      return inspected.plan;
    }

    const journal = inspected.journal;

    if (!journal) {
      return { code: 1, messages: ['Нет журнала переноса для возврата.'] };
    }

    await checkBackSlots(journal.entries, deps);
    unlock = await takeLock(context, deps);

    for (const entry of journal.entries.filter((item) => ['env', 'state'].includes(item.key))) {
      if ((await lstat(entry.source, deps))?.isSymbolicLink()) {
        await deps.fs.unlink(entry.source);
        await syncDir(path.dirname(entry.source), deps);
      }
    }

    await backEnv(journal, context, deps, messages);
    await updateJson(dataPath(context.home, 'state'), journal.entries, true, deps, messages);

    for (const entry of journal.entries.filter((item) => item.placeholder || item.key === 'mobile')) {
      await returnEntry(entry, deps);
    }

    for (const entry of journal.entries.filter((item) => ['pluginData', 'uiReleases', 'mobileApk']
      .includes(item.key))) {
      await returnEntry(entry, deps);
    }

    const envEntry = journal.entries.find((entry) => entry.key === 'env')!;

    if (await lstat(envEntry.target, deps)) {
      if (await lstat(envEntry.source, deps)) {
        await deps.fs.unlink(envEntry.target);
      } else {
        await deps.fs.link(envEntry.target, envEntry.source);
        await syncDir(context.codeRoot, deps);
        await deps.fs.unlink(envEntry.target);
      }
    }

    const state = journal.entries.find((entry) => entry.key === 'state')!;

    if (!state.original && await lstat(state.target, deps) && !(await deps.fs.readdir(state.target)).length) {
      await deps.fs.rmdir(state.target);
    } else {
      await returnEntry(state, deps);
    }

    const pre = path.join(context.home, '.pre-move');

    if (await lstat(pre, deps)) {
      for (const name of await deps.fs.readdir(pre)) {
        await deps.fs.rename(path.join(pre, name), path.join(context.home, name));
      }

      await deps.fs.rmdir(pre);
    }

    await deps.fs.unlink(dataPath(context.home, 'moveJournal'));
    await unlock();
    unlock = undefined;

    if (!(await deps.fs.readdir(context.home)).length) {
      await deps.fs.rmdir(context.home);
    }

    messages.push('Данные возвращены на прежние места.');

    return { code: 0, messages };
  } catch (error) {
    return { code: 1, messages: [...messages, errorText(error)] };
  } finally {
    await unlock?.();
  }
}

/**
 * Убирает только проверенные ссылки завершённого переноса.
 * Старый юнит, активная фабрика, старые JSON или чужое имя запрещают любую запись.
 */
export async function dropLinks(context: MoveContext, deps: MoveDeps): Promise<MoveReport> {
  guardContext(context);

  let unlock: (() => Promise<void>) | undefined;

  try {
    await checkPlacement(context, deps);

    const journal = await readJournal(context, deps);

    if (!journal?.completed) {
      throw new Error('Для уборки ссылок нужен завершённый журнал переноса.');
    }

    const unitPath = path.join(context.userHome, '.config/systemd/user/cockpit-server.service');
    const unit = await bytes(unitPath, deps);

    if (unit?.toString('utf8').includes(`EnvironmentFile=-${path.resolve(context.codeRoot)}/.env`)) {
      throw new Error('Установленный юнит ещё читает старый файл настроек: '
        + 'выполните deploy/install.sh --unit-only.');
    }

    // Старая сборка окна читает .env и пишет журнал через ссылки: без них она заново создала бы
    // <код>/server/.state, и сервер встал бы сторожем. Новая установка кладёт рядом метку.
    const app = windowAppPath({ ...context.env, HOME: context.userHome });

    if (await lstat(app, deps) && !await lstat(path.join(path.dirname(app), 'data-home'), deps)) {
      throw new Error('Установлена старая сборка окна: соберите и поставьте новую '
        + '(npm --prefix desktop run dist, затем cockpit desktop install).');
    }

    const settings = envChanges(await bytes(dataPath(context.home, 'env'), deps), context,
      journal.entries, false, journal);
    const stale = Object.keys(settings.changes)
      .filter((key) => !['COCKPIT_UI_RELEASES_DIR', 'COCKPIT_LOG'].includes(key));

    if (stale.length || settings.notices.length) {
      throw new Error(`В файле настроек остались старые пути: ${[...stale, ...settings.notices].join('; ')}`);
    }

    const runtime = await deps.checkRuntime(context, []);
    const factory = runtime.find((item) => item.id === 'factory' && !item.ok);

    if (factory) {
      throw new Error(factory.message);
    }

    for (const file of await jsonFiles(dataPath(context.home, 'state'), deps)) {
      const content = await bytes(file, deps);

      let count = 0;

      try {
        count = content ? rewriteJson(content, journal.entries, false).count : 0;
      } catch {
        throw new Error(`Файл не разбирается как JSON: ${file}`);
      }

      if (count) {
        throw new Error(`Известный JSON содержит старые пути: ${file}`);
      }
    }

    const links = journal.entries.filter((entry) => ['env', 'state'].includes(entry.key));

    for (const entry of links) {
      const stat = await lstat(entry.source, deps);

      if (stat && (!stat.isSymbolicLink() || await deps.fs.readlink(entry.source) !== entry.target)) {
        throw new Error(`На месте ссылки чужой файл или ссылка: ${entry.source}`);
      }
    }

    unlock = await takeLock(context, deps);

    for (const entry of links) {
      if (await lstat(entry.source, deps)) {
        await deps.fs.unlink(entry.source);
        await syncDir(path.dirname(entry.source), deps);
      }
    }

    return { code: 0, messages: ['Ссылки совместимости удалены.'] };
  } catch (error) {
    return { code: 1, messages: [errorText(error)] };
  } finally {
    await unlock?.();
  }
}
