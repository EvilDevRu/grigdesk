import { chmod, copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

export interface ResourceManifest {
  schema: number;
  entries: Array<{
    source: string;
    target: string;
    kind: 'file' | 'dir';
  }>;
}

const FORBIDDEN = new Set(['.env', '.git', '.state', '.cache', 'chats', 'profiles', '__pycache__']);

/**
 * Проверяет относительный путь ресурса до обращения к файловой системе.
 * Секреты и состояние не могут попасть в комплект даже через ошибку allowlist.
 */
function resourcePath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.split('/').some((part) => (
    part === '..' || part === '.' || FORBIDDEN.has(part)
  ))) {
    throw new Error(`Запрещён путь ресурса: ${relative}`);
  }

  return path.join(root, relative);
}

/**
 * Копирует дерево ресурса без следования ссылкам и без кэшей Python.
 * Права обычных файлов сохраняются; нерегулярный файл останавливает staging.
 */
async function copyAsset(source: string, target: string): Promise<void> {
  const info = await lstat(source);

  if (info.isSymbolicLink()) {
    throw new Error(`Ссылка недопустима в исходном ресурсе: ${source}`);
  }

  if (info.isDirectory()) {
    await mkdir(target, { recursive: true, mode: info.mode & 0o777 });

    for (const name of (await readdir(source)).sort()) {
      if (name === '__pycache__' || name.endsWith('.pyc')) {
        continue;
      }

      if (FORBIDDEN.has(name)) {
        throw new Error(`Запрещён ресурс: ${path.join(source, name)}`);
      }

      await copyAsset(path.join(source, name), path.join(target, name));
    }

    return;
  }

  if (!info.isFile()) {
    throw new Error(`Ресурс не является обычным файлом: ${source}`);
  }

  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  await chmod(target, info.mode & 0o777);
}

/**
 * Копирует только явные записи allowlist в новый staging.
 * Пропажа источника и несовпадение вида ресурса остаются отказом сборки.
 */
export async function copyResources(sourceRoot: string, stageRoot: string,
  manifest: ResourceManifest): Promise<void> {
  if (manifest.schema !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error('Некорректный allowlist ресурсов');
  }

  for (const entry of manifest.entries) {
    const source = resourcePath(sourceRoot, entry.source);
    const target = resourcePath(stageRoot, entry.target);
    const info = await lstat(source);

    if ((entry.kind !== 'file' && entry.kind !== 'dir')
      || (entry.kind === 'file' ? !info.isFile() : !info.isDirectory())) {
      throw new Error(`Неверный вид ресурса ${entry.source}`);
    }

    await copyAsset(source, target);
  }
}
