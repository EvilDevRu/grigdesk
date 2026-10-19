import { createReadStream } from 'node:fs';
import { chmod, lstat, readdir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { sha256, sha256File } from '../../../shared/node/hash.ts';

export interface PackageFile {
  path: string;
  type: 'file' | 'symlink';
  mode: number;
  size: number;
  sha256: string;
  target?: string;
}

export interface AuditOptions {
  required: readonly string[];
  executables?: readonly string[];
  allowedSources?: readonly string[];
  sourceRoot?: string;
  forbiddenRoots?: readonly string[];
}

const FORBIDDEN = new Set(['.env', '.git', '.state', '.cache', '__pycache__']);
const DATA_DIRECTORIES = new Set(['chats', 'profiles']);
const WRAPPERS = ['shared/runtime/legacyBrand.ts', 'server/scripts/dataHomeCheck.mts'];

/**
 * Права поставки не зависят от umask и групп машины сборки.
 * Ссылки не разыменовываются, исполняемые файлы сохраняют только стандартный режим 0755.
 */
export async function normalizeStageModes(root: string): Promise<void> {
  const info = await lstat(root);

  if (info.isDirectory()) {
    await chmod(root, 0o755);

    for (const entry of await readdir(root)) {
      await normalizeStageModes(path.join(root, entry));
    }
  } else if (info.isFile()) {
    await chmod(root, info.mode & 0o111 ? 0o755 : 0o644);
  }
}

/**
 * Ищет пути машины в любых байтах, включая ELF и файлы внешних npm-пакетов.
 * Перекрытие блоков ловит строку на границе чтений без загрузки больших бинарников в память.
 */
async function containsBuildPath(file: string, roots: readonly Buffer[]): Promise<boolean> {
  if (roots.length === 0) {
    return false;
  }

  const overlap = Math.max(...roots.map((root) => root.length)) - 1;
  let tail = Buffer.alloc(0);

  for await (const chunk of createReadStream(file)) {
    const bytes = Buffer.concat([tail, chunk as Buffer]);

    if (roots.some((root) => bytes.includes(root))) {
      return true;
    }

    tail = overlap > 0 ? bytes.subarray(Math.max(0, bytes.length - overlap)) : Buffer.alloc(0);
  }

  return false;
}

/**
 * Состав собственных файлов проверяется отдельно от библиотек npm и Node.
 * Установленные библиотеки могут содержать TS и sourcemap как часть своего runtime.
 */
function assertPackagePath(relative: string, allowedSources: readonly string[]): void {
  const external = relative.startsWith('server/node_modules/') || relative.startsWith('runtime/node/');

  if (relative.split('/').some((part) => FORBIDDEN.has(part)
    || !external && DATA_DIRECTORIES.has(part))) {
    throw new Error(`Запрещён файл состава: ${relative}`);
  }

  if (external) {
    return;
  }

  if (relative.endsWith('.map')) {
    throw new Error(`Запрещён собственный sourcemap: ${relative}`);
  }

  const source = /\.[cm]?[jt]sx?$/.test(relative)
    && (relative.startsWith('server/src/') || relative.startsWith('server/scripts/')
      || relative.startsWith('shared/') || relative.startsWith('cli/'));

  if (source && !allowedSources.includes(relative)) {
    throw new Error(`Лишний собственный исходник: ${relative}`);
  }
}

/**
 * Снимает полный список файлов, хешей, прав и внутренних ссылок staging.
 * Наружная/битая ссылка и недостающий обязательный файл запрещают публикацию.
 */
export async function auditStage(root: string, options: AuditOptions): Promise<PackageFile[]> {
  const physical = await realpath(root);
  const files: PackageFile[] = [];
  const allowedSources = options.allowedSources ?? WRAPPERS;
  const forbiddenRoots = [...new Set([options.sourceRoot, ...options.forbiddenRoots ?? []])]
    .filter((root): root is string => Boolean(root)).map((root) => Buffer.from(root));

  /**
   * Обход не следует ссылкам: проверяется их физическая цель и хеш текста ссылки.
   * Поэтому циклическая или наружная ссылка не прячет файл вне списка manifest.
   */
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      const info = await lstat(file);

      if (info.isSymbolicLink()) {
        const target = await readlink(file);
        const canonical = await realpath(file).catch(() => '');

        if (!canonical.startsWith(`${physical}${path.sep}`) || path.isAbsolute(target)) {
          throw new Error(`Наружная или повреждённая ссылка: ${relative}`);
        }

        assertPackagePath(relative, allowedSources);
        files.push({
          path: relative,
          type: 'symlink',
          mode: info.mode & 0o777,
          size: Buffer.byteLength(target),
          sha256: sha256(Buffer.from(target)),
          target,
        });

        continue;
      }

      assertPackagePath(relative, allowedSources);

      if (info.isDirectory()) {
        await visit(file);
      } else if (info.isFile()) {
        if (await containsBuildPath(file, forbiddenRoots)) {
          throw new Error(`Абсолютный путь машины сборки в комплекте: ${relative}`);
        }

        files.push({
          path: relative,
          type: 'file',
          mode: info.mode & 0o777,
          size: info.size,
          sha256: await sha256File(file),
        });
      } else {
        throw new Error(`Запрещён нерегулярный файл: ${relative}`);
      }
    }
  }

  await visit(root);

  for (const relative of options.required) {
    if (!files.some((file) => file.path === relative)) {
      throw new Error(`Нет обязательного файла комплекта: ${relative}`);
    }
  }

  for (const relative of options.executables ?? []) {
    if (!((await stat(path.join(root, relative))).mode & 0o111)) {
      throw new Error(`Нет права исполнения: ${relative}`);
    }
  }

  return files;
}
