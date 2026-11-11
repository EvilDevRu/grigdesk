import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

interface ArtifactRemovalOptions {
  root: string;
  directory: string;
  rootStat: Stats;
  stat: Stats;
  signal?: AbortSignal;
}

function sameDirectory(stat: Stats, expected: Stats): boolean {
  return stat.isDirectory() && stat.ino === expected.ino && stat.dev === expected.dev;
}

/**
 * Каждый структурный предок открывается от уже закреплённого fd без перехода по symlink.
 * Подмена исходного пути после открытия не перенаправляет последующее удаление наружу.
 */
async function openParent(options: ArtifactRemovalOptions, handles: FileHandle[]): Promise<FileHandle> {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let parent = await fs.open(options.root, flags);

  handles.push(parent);

  if (!sameDirectory(await parent.stat(), options.rootStat)) {
    throw Object.assign(new Error('Корень уборки заменён'), { code: 'ENOENT' });
  }

  const segments = path.relative(options.root, options.directory).split(path.sep);

  if (segments.some((segment) => !segment || segment === '..')) {
    throw new Error('Удаление требует дочерний каталог выбранного корня');
  }

  for (const segment of segments.slice(0, -1)) {
    options.signal?.throwIfAborted();
    parent = await fs.open(`/proc/self/fd/${parent.fd}/${segment}`, flags);
    handles.push(parent);
  }

  return parent;
}

/**
 * Корень и родитель открыты до захвата candidate lock и живут до его release.
 * Один fd закрепляет и sidecar lock, и quarantine, поэтому подмена предка не меняет ни один эффект.
 */
export async function openArtifactDirectory(options: ArtifactRemovalOptions) {
  const handles: FileHandle[] = [];
  let parent: FileHandle;

  try {
    parent = await openParent(options, handles);
  } catch (error) {
    for (const handle of handles.reverse()) {
      await handle.close();
    }

    throw error;
  }

  const source = `/proc/self/fd/${parent.fd}/${path.basename(options.directory)}`;

  return {
    path: source,
    /**
     * Atomic rename отделяет leaf от публичного имени; inode сверяется уже после переноса.
     * Чужая замена не удаляется, а ошибка удаления по возможности возвращает остатки назад.
     */
    async remove(): Promise<void> {
      const quarantine = `${source}.cleanup-${randomBytes(16).toString('hex')}`;

      if (!sameDirectory(await fs.lstat(source), options.stat)) {
        throw Object.assign(new Error('Каталог уборки заменён'), { code: 'ENOENT' });
      }

      options.signal?.throwIfAborted();
      await fs.rename(source, quarantine);

      try {
        if (!sameDirectory(await fs.lstat(quarantine), options.stat)) {
          throw Object.assign(new Error('Перенесённый каталог заменён'), { code: 'ENOENT' });
        }

        await fs.rm(quarantine, { recursive: true });
      } catch (error) {
        // Неполное удаление оставляет читаемые остатки под прежним именем, если оно свободно.
        // При внешней замене имени случайный quarantine сохраняется для повторной явной уборки.
        if (!await fs.lstat(source).catch(() => null)) {
          await fs.rename(quarantine, source).catch(() => {});
        }

        throw error;
      }
    },
    /**
     * Вызывающий сначала освобождает lock, использующий этот же fd в своём пути.
     * Повторное закрытие не обходит список дескрипторов второй раз.
     */
    async close(): Promise<void> {
      for (const handle of handles.splice(0).reverse()) {
        await handle.close();
      }
    },
  };
}
