import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { checkRuntime } from '../../src/lib/releaseManifest.ts';

const execute = promisify(execFile);

/**
 * Архив хранит стандартные права staging и числового владельца 0/0.
 * Пользователь распаковывает комплект без зависимости от uid машины сборки.
 */
export async function createReleaseArchive(directory: string, target: string): Promise<void> {
  await execute('tar', ['--owner=0', '--group=0', '--numeric-owner', '--sort=name',
    '-cJf', target, '-C', path.dirname(directory), path.basename(directory)], {
    env: { PATH: '/usr/bin:/bin', XZ_OPT: '-T1 -1' },
    timeout: 120000,
  });
}

export interface BuildArgs {
  outDir: string;
  cacheDir: string;
}

/**
 * Разбирает точные флаги до записи файлов; текущая установка не является целью.
 * Пути разрешаются от cwd, повторные флаги и cache внутри выходного каталога запрещены.
 */
export function parseBuildArgs(argv: readonly string[], cwd: string,
  sourceRoot: string): BuildArgs | { error: string } {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (!flag || !['--out-dir', '--cache-dir'].includes(flag) || values.has(flag)
      || !value || value.startsWith('--')) {
      return { error: `Некорректный или повторный аргумент сборки: ${flag}` };
    }

    values.set(flag, path.resolve(cwd, value));
  }

  const outDir = values.get('--out-dir');
  const cacheDir = values.get('--cache-dir') ?? path.join(sourceRoot, 'server/.cache');

  if (!outDir || outDir === sourceRoot || sourceRoot.startsWith(outDir + path.sep)
    || outDir === cacheDir || cacheDir.startsWith(outDir + path.sep)) {
    return { error: 'Нужен отдельный --out-dir; cache должен находиться за его пределами' };
  }

  return { outDir, cacheDir };
}

export interface PublishInput {
  outDir: string;
  name: string;
  prepare(directory: string): Promise<{ contentId: string }>;
  smoke(directory: string): Promise<void>;
  archive(directory: string, target: string): Promise<void>;
}

/**
 * Публикует проверенную версию и архив; любой отказ сохраняет прежний архив.
 * Все промежуточные файлы созданы на том же разделе; архив заменяется последним rename.
 */
export async function publishRelease(input: PublishInput): Promise<{
  directory: string;
  archive: string;
  contentId: string;
}> {
  if (!/^[a-zA-Z0-9._-]+$/.test(input.name) || input.name.startsWith('.')) {
    throw new Error('Некорректное имя комплекта');
  }

  await mkdir(input.outDir, { recursive: true });

  const scratch = await mkdtemp(path.join(input.outDir, `.${input.name}-`));
  const stage = path.join(scratch, input.name);
  const archive = path.join(input.outDir, `${input.name}.tar.xz`);
  const temporaryArchive = path.join(input.outDir, `.${input.name}-${randomUUID()}.tar.xz`);
  let published: string | undefined;

  try {
    await mkdir(stage);

    const { contentId } = await input.prepare(stage);

    if (!/^[a-f0-9]{64}$/.test(contentId)) {
      throw new Error('Некорректный идентификатор содержимого');
    }

    await input.smoke(stage);

    const basename = `${input.name}-${contentId.slice(0, 16)}`;
    const ready = path.join(scratch, basename);
    const directory = path.join(input.outDir, basename);

    await rename(stage, ready);
    await input.archive(ready, temporaryArchive);

    const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    if (existing && !existing.isDirectory()) {
      throw new Error(`Каталог версии повреждён: ${directory}`);
    }

    const previous = existing ? await readFile(path.join(directory, 'release.json'), 'utf8') : null;

    if (previous !== null) {
      const priorManifest = JSON.parse(previous);

      if (priorManifest.contentId !== contentId) {
        throw new Error(`Коллизия каталога версии: ${directory}`);
      }

      if (!(await checkRuntime(directory, priorManifest.runtime)).ok) {
        throw new Error(`Каталог версии повреждён: ${directory}`);
      }
    } else {
      await rename(ready, directory);
      published = directory;
    }

    await rename(temporaryArchive, archive);
    published = undefined;

    return {
      directory,
      archive,
      contentId,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await rm(temporaryArchive, { force: true });

    if (published) {
      await rm(published, { recursive: true, force: true });
    }
  }
}
