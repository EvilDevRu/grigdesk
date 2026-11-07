import path from 'node:path';
import { parseEnv } from 'node:util';

import { HOST_ENV_SUFFIXES, LEGACY, LEGACY_DATA_PATHS } from '../shared/runtime/legacyBrand.ts';
import { renameEnvKeys, rewriteEnvValues } from '../server/src/lib/envFile.ts';
import type { BrandContext, BrandDeps } from './brandMoveCore.ts';
import { assertPlainPath, bytesFingerprint, fingerprint, linkFingerprint, stat } from './brandMoveFiles.ts';
import { rewriteJson, rewritePath } from './rewriteJson.ts';

export interface BrandOperation {
  id: string;
  kind: 'rename' | 'write' | 'link';
  source: string;
  target: string;
  before: string;
  after: string;
  mode: number;
  backup: string;
  next: string;
  oldLink?: string;
  newLink?: string;
}

export interface PendingOperation extends BrandOperation { content?: string }

export const BRAND_ACTIONS = [
  'Переименовать внутренние пути и ротированные журналы.',
  'Переименовать ключи хоста и пути в .env, сохранить копию до изменений.',
  'Переписать префиксы путей в известных JSON с копиями до изменений.',
  'Перенаправить наши ссылки дерева кода в новую папку данных.',
  'Переименовать каталог конфигурации приложения.',
];

/**
 * Перенос работает с раскладкой, заранее подготовленной владельцем.
 * Переменные окружения не могут направить его в произвольную папку данных.
 */
export function brandHome(context: BrandContext): string {
  return path.join(context.userHome, '.grigdesk');
}

/**
 * Два моста дерева кода имеют фиксированные цели внутри папки данных.
 * Общий список используется при плане переноса и при отдельной уборке ссылок.
 */
export function codeLinks(context: BrandContext): Array<[string, string]> {
  return [
    [path.join(context.codeRoot, '.env'), '.env'],
    [path.join(context.codeRoot, 'server/.state'), 'state'],
  ];
}

/**
 * Список содержит только существующие имена, которые можно перенести без слияния.
 * Ротированные журналы получают тот же новый префикс, что основной журнал.
 */
function renamePairs(context: BrandContext, deps: BrandDeps): Array<[string, string]> {
  const home = brandHome(context);
  const pairs: Array<[string, string]> = LEGACY_DATA_PATHS.map(([oldName, newName]) =>
    [path.join(home, oldName), path.join(home, newName)]);
  const [oldLog, newLog] = LEGACY_DATA_PATHS[0];

  for (const name of deps.fs.readdirSync(path.join(home, 'state'))) {
    if (name.startsWith(path.basename(oldLog) + '.')) {
      const suffix = name.slice(path.basename(oldLog).length);

      pairs.push([path.join(home, 'state', name), path.join(home, newLog + suffix)]);
    }
  }

  pairs.push([
    path.join(context.userHome, '.config', LEGACY.configDir),
    path.join(context.userHome, '.config/grigdesk'),
  ]);

  return pairs;
}

/**
 * Известные JSON допускают замену значений, но не имён полей и не текста плагина.
 * Вложенные каталоги проверяются до обхода, чтобы не выйти по пользовательской ссылке.
 */
function jsonPaths(home: string, deps: BrandDeps): string[] {
  const files = ['state/prefs.json', 'state/showcase-browser/browser.json'];
  const directory = path.join(home, 'state/sandboxes');

  assertPlainPath(home, directory, deps.fs);

  if (stat(directory, deps.fs)) {
    for (const name of deps.fs.readdirSync(directory)) {
      if (name.endsWith('.json')) {
        files.push(`state/sandboxes/${name}`);
      }
    }
  }

  return files.map((file) => path.join(home, file));
}

/**
 * Ищет старые абсолютные пути в плагинах без публикации содержимого и без правки.
 * Чтение блоками сохраняет ограниченный расход памяти даже для большого файла.
 */
function pluginMentions(home: string, oldHome: string, deps: BrandDeps): string[] {
  const result: string[] = [];
  const needle = Buffer.from(oldHome + '/');

  // Рекурсивный обход пропускает все ссылки, даже ведущие внутрь плагина.
  // В отчёт попадает лишь имя совпавшего файла, содержимое остаётся закрытым.
  const visit = (file: string): void => {
    const info = stat(file, deps.fs);

    if (info?.isDirectory()) {
      for (const name of deps.fs.readdirSync(file)) {
        visit(path.join(file, name));
      }
    } else if (info?.isFile()) {
      const fd = deps.fs.openSync(file, 'r');
      const buffer = Buffer.alloc(65536);
      let tail: Buffer = Buffer.alloc(0);

      try {
        for (;;) {
          const count = deps.fs.readSync(fd, buffer);

          if (!count) {
            break;
          }

          const chunk = Buffer.concat([tail, buffer.subarray(0, count)]);

          if (chunk.includes(needle)) {
            result.push(`Плагин требует ручной проверки: ${path.relative(home, file)}`);
            break;
          }

          tail = Buffer.from(chunk.subarray(Math.max(0, chunk.length - needle.length + 1)));
        }
      } finally {
        deps.fs.closeSync(fd);
      }
    }
  };
  const plugins = path.join(home, 'plugins');

  assertPlainPath(home, plugins, deps.fs);

  if (stat(plugins, deps.fs)) {
    for (const name of deps.fs.readdirSync(plugins)) {
      if (!name.startsWith('.')) {
        visit(path.join(plugins, name));
      }
    }
  }

  return result;
}

/**
 * Строит полный план до первой записи; любой конфликт отменяет все пять групп.
 * Тексты изменяемых файлов живут только в памяти и в защищённых копиях, не в журнале.
 */
export function buildOperations(context: BrandContext, deps: BrandDeps): {
  operations: PendingOperation[];
  kept: string[];
} {
  const { fs } = deps;
  const home = brandHome(context);
  const oldHome = path.join(context.userHome, LEGACY.dataHomeDir);
  const operations: PendingOperation[] = [];
  const kept = pluginMentions(home, oldHome, deps);
  const add = (item: Omit<PendingOperation, 'id' | 'backup' | 'next'>): void => {
    const id = String(operations.length + 1).padStart(3, '0');
    const backup = path.join(home, 'state/brand-move-backup',
      item.source === path.join(home, '.env') ? '.env' : id + '.before');

    operations.push({
      ...item,
      id,
      backup,
      next: `${backup}.after`,
    });
  };

  for (const [source, target] of renamePairs(context, deps)) {
    assertPlainPath(context.userHome, source, fs);
    assertPlainPath(context.userHome, target, fs);

    if (!stat(source, fs)) {
      continue;
    }

    if (stat(target, fs)) {
      throw new Error(`Цель уже существует: ${target}`);
    }

    const before = fingerprint(source, fs)!;

    add({
      kind: 'rename',
      source,
      target,
      before,
      after: before,
      mode: stat(source, fs)!.mode & 0o777,
    });
  }

  // Конфигурация — последняя группа, хотя проверяется до остальных изменений.
  const config = operations.pop();
  const configOperation = config?.source === path.join(context.userHome, '.config', LEGACY.configDir)
    ? config : undefined;

  if (config && !configOperation) {
    operations.push(config);
  }

  // Неизменившиеся байты не создают действие и не переписываются повторно.
  // Режим доступа берётся у исходного файла до формирования журнала.
  const write = (source: string, content: string): void => {
    const info = stat(source, fs)!;
    const before = fingerprint(source, fs)!;
    const mode = info.mode & 0o777;
    const after = bytesFingerprint(content, mode);

    if (before !== after) {
      add({
        kind: 'write',
        source,
        target: source,
        before,
        after,
        mode,
        content,
      });
    }
  };
  const envFile = path.join(home, '.env');

  assertPlainPath(home, envFile, fs);

  if (stat(envFile, fs)) {
    const names = Object.fromEntries(HOST_ENV_SUFFIXES.map((suffix) =>
      [`${LEGACY.envPrefix}${suffix}`, `GRIGDESK_${suffix}`]));
    const renamed = renameEnvKeys(fs.readFileSync(envFile), names);
    const mappings = [
      ...LEGACY_DATA_PATHS.map(([source, target]) => ({
        source: path.join(home, source), target: path.join(home, target),
      })),
    ];
    const rewritten = rewriteEnvValues(Buffer.from(renamed), (value) => {
      const next = rewritePath(value, [{ source: oldHome, target: home }], false);

      return rewritePath(next, mappings, false);
    }, {
      GRIGDESK_LOG: path.join(home, 'state/grigdesk-server.log'),
      GRIGDESK_UI_RELEASES_DIR: path.join(home, 'state/ui-releases'),
    });

    for (const key of Object.keys(parseEnv(rewritten))) {
      if (key.startsWith(LEGACY.envPrefix)) {
        kept.push(`Ключ оставлен без изменений: ${key}`);
      }
    }

    write(envFile, rewritten);
  }

  for (const file of jsonPaths(home, deps)) {
    assertPlainPath(home, file, fs);

    if (stat(file, fs)) {
      let text: string;

      try {
        text = rewriteJson(fs.readFileSync(file), [{ source: oldHome, target: home }], false).text;
      } catch {
        throw new Error(`Документ JSON не разбирается: ${file}`);
      }

      write(file, text);
    }
  }

  for (const [source, relative] of codeLinks(context)) {
    assertPlainPath(context.codeRoot, path.dirname(source), fs);

    if (!stat(source, fs)?.isSymbolicLink()) {
      continue;
    }

    const oldLink = fs.readlinkSync(source);
    const newLink = path.join(home, relative);

    if (path.resolve(path.dirname(source), oldLink) === path.join(oldHome, relative)) {
      add({
        kind: 'link',
        source,
        target: source,
        before: fingerprint(source, fs)!,
        after: linkFingerprint(newLink),
        mode: 0o777,
        oldLink,
        newLink,
      });
    }
  }

  if (configOperation) {
    const { id, backup, next, ...item } = configOperation;

    add(item);
  }

  return { operations, kept };
}
