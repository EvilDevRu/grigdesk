import { lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';

import { installError } from './errors.ts';
import { safeGitConfigDigest } from './gitMetadata.ts';

export interface PackageEntry {
  relative: string;
  info: Stats;
}

export interface PackageTreeOptions {
  maxFiles?: number;
  maxBytes?: number;
  generatedDirs?: string[];
}

/**
 * Корень и каждый предок проверяются lstat, до чтения каких-либо файлов пакета.
 * Ссылки не получают возможности перенаправить чтение на другой каталог.
 */
export async function assertRealPackageRoot(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;

  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);

    const info = await lstat(current);

    if (info.isSymbolicLink()) {
      throw installError('symlink_forbidden');
    }

    if (!info.isDirectory()) {
      throw installError('package_unsupported');
    }
  }
}

/**
 * Обход проверяет весь пакет без следования по ссылкам и без чтения спецфайлов.
 * Набор проверенных записей используется последующими ограничениями и digest.
 */
export async function readPackageTree(
  directory: string,
  options: PackageTreeOptions = {},
): Promise<PackageEntry[]> {
  await assertRealPackageRoot(directory);

  const entries: PackageEntry[] = [];
  const pending = [''];
  let files = 0;
  let bytes = 0;
  const generated = (options.generatedDirs ?? []).map((dir) => path.posix.join(dir, 'node_modules'));

  while (pending.length > 0) {
    const parent = pending.pop() ?? '';

    for (const entry of await readdir(path.join(directory, parent), { withFileTypes: true })) {
      const relative = path.posix.join(parent, entry.name);
      const info = await lstat(path.join(directory, relative));
      const inGenerated = generated.some((dir) => relative === dir || relative.startsWith(`${dir}/`));

      if (info.isSymbolicLink()) {
        if (!inGenerated) {
          throw installError('symlink_forbidden', relative);
        }

        await assertInternalPackageLink(directory, relative);
        entries.push({ relative, info });

        continue;
      }

      if (!info.isFile() && !info.isDirectory()) {
        throw installError('package_unsupported', relative);
      }

      if (entry.name === '.gitmodules') {
        throw installError('submodules_forbidden', relative);
      }

      if (['.npmrc', 'npm-shrinkwrap.json'].includes(entry.name)
        || entry.name === 'node_modules' && !inGenerated) {
        throw installError('package_unsupported', relative);
      }

      if (entry.name === '.git') {
        if (relative !== '.git' || !info.isDirectory() || !await safeGitConfigDigest(directory)) {
          throw installError('package_unsupported', relative);
        }

        continue;
      }

      entries.push({ relative, info });

      if (info.isFile()) {
        files += 1;
        bytes += info.size;
      }

      if (files > (options.maxFiles ?? Infinity) || bytes > (options.maxBytes ?? Infinity)) {
        throw installError('package_too_large');
      }

      if (info.isDirectory()) {
        pending.push(relative);
      }
    }
  }

  return entries;
}

/**
 * Каждый компонент конечной цели разрешается без чтения внешних путей.
 * Абсолютные links, выход из пакета, циклы и dangling links отвергаются.
 */
async function assertInternalPackageLink(directory: string, relative: string): Promise<void> {
  const root = path.resolve(directory);
  let candidate = path.join(root, relative);

  for (let hops = 0; hops < 40; hops += 1) {
    if (!candidate.startsWith(`${root}${path.sep}`)) {
      throw installError('symlink_forbidden', relative);
    }

    const components = path.relative(root, candidate).split(path.sep);
    let current = root;
    let redirected = false;

    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index] ?? '');

      const info = await lstat(current).catch(() => null);

      if (!info) {
        throw installError('symlink_forbidden', relative);
      }

      if (info.isSymbolicLink()) {
        const target = await readlink(current);

        if (path.isAbsolute(target)) {
          throw installError('symlink_forbidden', relative);
        }

        candidate = path.resolve(path.dirname(current), target, ...components.slice(index + 1));
        redirected = true;

        break;
      }
    }

    if (!redirected) {
      return;
    }
  }

  throw installError('symlink_forbidden', relative);
}
