import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import reviewed from './npmReviewedHooks.json' with { type: 'json' };

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
 * Неизвестный hook может писать вне prefix, поэтому не получает разрешение автоматически.
 * Проверенные profiles сравниваются по exact bytes и командам, а не только имени пакета.
 */
export async function assertReviewedNpmHooks(graph: NpmGraphPackage[]): Promise<void> {
  for (const entry of graph) {
    if (Object.keys(entry.scripts).length === 0 && !entry.bindingGyp) {
      continue;
    }

    const profile = reviewed.find((item) => item.name === entry.name
      && item.reviewedVersion === entry.version);

    if (!profile || Object.keys(profile.lifecycle).length !== Object.keys(entry.scripts).length
      || Object.entries(profile.lifecycle).some(([key, command]) => entry.scripts[key] !== command)) {
      throw failure('installer_strategy_unverified');
    }

    for (const [relative, expected] of Object.entries(profile.files)) {
      const file = path.join(entry.directory, relative);
      const stat = await fs.lstat(file).catch(() => null);

      if (!stat?.isFile() || stat.size > 8 * 1024 * 1024) {
        throw failure('installer_strategy_unverified');
      }

      const actual = createHash('sha256').update(await fs.readFile(file)).digest('hex');

      if (actual !== expected) {
        throw failure('installer_strategy_unverified');
      }
    }
  }
}
