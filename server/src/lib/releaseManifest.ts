import { createHash } from 'node:crypto';
import { chmod, lstat, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256File } from '../../../shared/node/hash.ts';
import type { PackageFile } from '../../scripts/sea/stage.mts';

export const PACKAGING_VERSION = 1;

export interface ReleaseRuntime {
  node: string;
  platform: string;
  arch: string;
  abi: string;
}

export interface ReleaseManifest {
  schema: 1;
  version: string;
  packagingVersion: number;
  runtime: ReleaseRuntime;
  files: PackageFile[];
  contentId: string;
}

export interface RuntimeCheck {
  ok: boolean;
  errors: string[];
  warnings?: string[];
  contentId?: string;
}

export type RuntimeCheckMode = 'full' | 'startup';

const STARTUP_HASHES = new Set(['server/grigdesk-server', 'runtime/node/bin/node']);

/**
 * Хеширует байты файла либо каноническое представление manifest без собственного id.
 */
function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Записывает manifest после окончательного хеширования бинарников и ресурсов.
 * Manifest исключён из списка файлов, а contentId хеширует остальные канонические поля.
 */
export async function writeReleaseManifest(root: string, input: {
  version: string;
  runtime: ReleaseRuntime;
  files: PackageFile[];
}): Promise<ReleaseManifest> {
  const core = {
    schema: 1 as const,
    version: input.version,
    packagingVersion: PACKAGING_VERSION,
    runtime: input.runtime,
    files: input.files,
  };
  const manifest = { ...core, contentId: digest(JSON.stringify(core)) };

  await writeFile(path.join(root, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
  await chmod(path.join(root, 'release.json'), 0o644);

  return manifest;
}

/**
 * Запрещает обход корня и абсолютные пути до чтения файла из manifest.
 */
function safePath(relative: string): boolean {
  return typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative)
    && !relative.split('/').some((part) => !part || part === '.' || part === '..')
    && !relative.includes('\\') && relative !== 'release.json';
}

/**
 * Проверяет состав своего R без boot, сети, helper-ов и пользовательских данных.
 * Пути проверяются до чтения; startup пропускает хеши библиотек, full сверяет все байты.
 */
export async function checkRuntime(root: string, runtime: ReleaseRuntime = {
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  abi: process.versions.modules,
}, options: { mode?: RuntimeCheckMode } = {}): Promise<RuntimeCheck> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const physical = await realpath(root);
    const bytes = await readFile(path.join(physical, 'release.json'), 'utf8');
    const manifest = JSON.parse(bytes) as ReleaseManifest;
    const { contentId, ...core } = manifest;

    if (manifest.schema !== 1 || manifest.packagingVersion !== PACKAGING_VERSION
      || typeof manifest.version !== 'string' || !Array.isArray(manifest.files)
      || contentId !== digest(JSON.stringify(core))) {
      throw new Error('Повреждён release.json или неподдерживаемая версия упаковки');
    }

    for (const key of ['node', 'platform', 'arch', 'abi'] as const) {
      if (manifest.runtime?.[key] !== runtime[key]) {
        errors.push(`Runtime ${key}: ожидалось ${manifest.runtime?.[key]}, получено ${runtime[key]}`);
      }
    }

    const expected = new Set<string>();

    for (const entry of manifest.files) {
      if (!safePath(entry.path) || expected.has(entry.path)
        || !['file', 'symlink'].includes(entry.type) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new Error(`Некорректная запись состава: ${entry.path}`);
      }

      expected.add(entry.path);

      try {
        const file = path.join(physical, entry.path);
        const canonical = await realpath(file);

        if (!canonical.startsWith(physical + path.sep)) {
          throw new Error('цель за пределами комплекта');
        }

        const info = await lstat(file);
        const link = info.isSymbolicLink() ? await readlink(file) : null;

        if (entry.type === 'symlink' ? !info.isSymbolicLink() : !info.isFile()) {
          throw new Error('изменён тип файла');
        }

        const size = link === null ? info.size : Buffer.byteLength(link);
        const checkHash = options.mode !== 'startup' || STARTUP_HASHES.has(entry.path) || link !== null;
        const hash = checkHash ? link === null ? await sha256File(file) : digest(link) : entry.sha256;

        if ((info.mode & 0o111) !== (entry.mode & 0o111) || size !== entry.size
          || hash !== entry.sha256
          || link !== null && (link !== entry.target || path.isAbsolute(link))) {
          throw new Error('изменены байты, права или ссылка');
        }
      } catch (error) {
        errors.push(`${entry.path}: ${(error as Error).message}`);
      }
    }

    /**
     * Обнаруживает добавленные файлы, не следуя ссылкам в каталогах комплекта.
     * Ожидаемые ссылки проверены отдельно, добавления диагностируются без отказа запуска.
     */
    async function visit(directory: string): Promise<void> {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name);
        const relative = path.relative(physical, file).split(path.sep).join('/');

        if (item.isDirectory()) {
          if (item.name === '__pycache__') {
            continue;
          }

          await visit(file);
        } else if (relative !== 'release.json' && !expected.has(relative)) {
          warnings.push(`Лишний файл: ${relative}`);
        }
      }
    }

    await visit(physical);

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      contentId,
    };
  } catch (error) {
    return {
      ok: false,
      errors: [...errors, (error as Error).message],
      warnings,
    };
  }
}
