import { promises as fs } from 'node:fs';
import path from 'node:path';

import { sha256File } from '../../../../shared/node/hash.ts';
import reviewed from './npmReviewedHooks.json' with { type: 'json' };

type ReviewedNpmHookProfile = (typeof reviewed)[number];

export interface NpmGraphPackage {
  directory: string;
  relative: string;
  name: string;
  version: string;
  scripts: Record<string, string>;
  bindingGyp: boolean;
}

// Registry tarball dependencies выполняют только install/uninstall-хуки; prepare/prepublish
// принадлежат упаковке публикации и у зависимостей из registry не запускаются.
const HOOKS = ['preinstall', 'install', 'postinstall', 'preuninstall', 'uninstall', 'postuninstall'];

/**
 * Ошибка не содержит тела package.json или окружения npm.
 * Код позволяет интерфейсу отличить неизвестный hook от повреждённого графа.
 */
function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * Inspection не выполняет scripts: граф читается из подготовленного npm-prefix.
 * Обход ограничен настоящими node_modules; ссылки и слишком большой граф запрещены.
 */
export async function inspectNpmGraph(packageRoot: string): Promise<NpmGraphPackage[]> {
  const root = await fs.realpath(packageRoot);
  const graph: NpmGraphPackage[] = [];

  /**
   * Обход идёт только по настоящим node_modules и не следует ссылкам.
   * Предел графа закрывает установку вместо неограниченного чтения.
   */
  async function visit(directory: string): Promise<void> {
    const stat = await fs.lstat(directory);

    if (!stat.isDirectory() || stat.isSymbolicLink() || graph.length >= 2048) {
      throw failure('npm_graph_invalid');
    }

    const manifestPath = path.join(directory, 'package.json');
    const manifestStat = await fs.lstat(manifestPath);

    if (!manifestStat.isFile() || manifestStat.size > 1024 * 1024) {
      throw failure('npm_graph_invalid');
    }

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw failure('npm_graph_invalid');
    }

    const scripts: Record<string, string> = {};

    for (const hook of HOOKS) {
      if (manifest.scripts?.[hook] !== undefined) {
        if (typeof manifest.scripts[hook] !== 'string') {
          throw failure('npm_graph_invalid');
        }

        scripts[hook] = manifest.scripts[hook];
      }
    }

    graph.push({
      directory,
      relative: path.relative(root, directory),
      name: manifest.name,
      version: manifest.version,
      scripts,
      bindingGyp: await fs.lstat(path.join(directory, 'binding.gyp')).then(() => true, () => false),
    });

    const modules = path.join(directory, 'node_modules');
    const modulesStat = await fs.lstat(modules).catch(() => null);

    if (!modulesStat) {
      return;
    }
    if (!modulesStat.isDirectory() || modulesStat.isSymbolicLink()) {
      throw failure('npm_graph_invalid');
    }

    for (const entry of (await fs.readdir(modules)).sort()) {
      if (entry === '.bin' || entry.startsWith('.')) {
        continue;
      }

      const child = path.join(modules, entry);

      if (entry.startsWith('@')) {
        const scopeStat = await fs.lstat(child);

        if (!scopeStat.isDirectory() || scopeStat.isSymbolicLink()) {
          throw failure('npm_graph_invalid');
        }

        for (const scoped of (await fs.readdir(child)).sort()) {
          await visit(path.join(child, scoped));
        }
      } else {
        await visit(child);
      }
    }
  }

  try {
    await visit(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'npm_graph_invalid') {
      throw error;
    }

    throw failure('npm_graph_invalid');
  }

  return graph;
}

/**
 * Совпадение команд не заменяет проверку всех файлов, включая вложенные модули и native build.
 * Повреждение или отсутствие файла закрывает профиль, позволяя проверить следующий вариант.
 */
async function matchesReviewedNpmHooks(entry: NpmGraphPackage,
  profile: ReviewedNpmHookProfile): Promise<boolean> {
  if (Object.keys(profile.lifecycle).length !== Object.keys(entry.scripts).length
    || Object.entries(profile.lifecycle).some(([key, command]) => entry.scripts[key] !== command)
    || entry.bindingGyp !== Object.hasOwn(profile.files, 'binding.gyp')) {
    return false;
  }

  for (const [relative, expected] of Object.entries(profile.files)) {
    const file = path.join(entry.directory, relative);
    const stat = await fs.lstat(file).catch(() => null);

    if (!stat?.isFile() || stat.size > 8 * 1024 * 1024) {
      return false;
    }

    const actual = await sha256File(file).catch(() => null);

    if (actual !== expected) {
      return false;
    }
  }

  return true;
}

/**
 * При переносе допуска между версиями каталоги хуков должны содержать только проверенные файлы.
 * Корень пакета не считается каталогом хуков: CLI и прочие ресурсы вправе меняться отдельно.
 */
async function hasReviewedHookLayout(entry: NpmGraphPackage,
  profile: ReviewedNpmHookProfile): Promise<boolean> {
  const files = new Set(Object.keys(profile.files));
  const directories = new Set<string>();

  for (const file of files) {
    let directory = path.dirname(file);

    while (directory !== '.') {
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }

  for (const directory of directories) {
    const absolute = path.join(entry.directory, directory);
    const stat = await fs.lstat(absolute).catch(() => null);

    if (!stat?.isDirectory()) {
      return false;
    }

    const children = await fs.readdir(absolute, { withFileTypes: true }).catch(() => null);

    if (!children) {
      return false;
    }

    for (const child of children) {
      const relative = path.join(directory, child.name);

      if (!(child.isFile() && files.has(relative))
        && !(child.isDirectory() && directories.has(relative))) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Точная версия имеет приоритет; её повреждённые хуки не прикрываются другим профилем.
 * Новая версия допускается только по командам, всем байтам и составу каталогов хуков того же пакета.
 */
export async function assertReviewedNpmHooks(graph: NpmGraphPackage[]): Promise<void> {
  for (const entry of graph) {
    if (Object.keys(entry.scripts).length === 0 && !entry.bindingGyp) {
      continue;
    }

    const exact = reviewed.find((item) => item.name === entry.name
      && item.reviewedVersion === entry.version);

    if (exact) {
      if (!await matchesReviewedNpmHooks(entry, exact)) {
        throw failure('installer_strategy_unverified');
      }

      continue;
    }

    let accepted = false;

    for (const profile of reviewed.filter((item) => item.name === entry.name)) {
      if (await matchesReviewedNpmHooks(entry, profile) && await hasReviewedHookLayout(entry, profile)) {
        accepted = true;
        break;
      }
    }

    if (!accepted) {
      throw failure('installer_strategy_unverified');
    }
  }
}
