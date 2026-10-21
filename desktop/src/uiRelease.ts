import { desktopText } from './locale.ts';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256 } from '../../shared/node/hash.ts';

import { UI_RELEASE_ID, UI_RELEASE_VERSION } from '../../shared/runtime/uiRelease.ts';

interface ReleaseFile {
  path: string;
  size: number;
  sha256: string;
}

export interface UiRelease {
  version: 1;
  id: string;
  files: ReleaseFile[];
}

function safePath(value: string): boolean {
  return value.length < 240 && value.split('/').every((part) =>
    /^[\w.-]+$/.test(part) && part !== '.' && part !== '..');
}

/**
 * Обходит только обычные файлы и каталоги: ссылки не попадают в доверенный пакет.
 * Сортировка и хеш содержимого делают версию независимой от времени сборки и Git SHA.
 */
async function inventory(root: string, relative = ''): Promise<ReleaseFile[]> {
  const files: ReleaseFile[] = [];
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;

    if (name === 'release.json') {
      continue;
    }
    if (!safePath(name)) {
      throw new Error(desktopText('desktop.uiInvalidResource'));
    }
    if (entry.isDirectory()) {
      files.push(...await inventory(root, name));
    } else if (entry.isFile()) {
      const content = await readFile(path.join(root, name));

      files.push({
        path: name,
        size: content.length,
        sha256: sha256(content),
      });
    } else {
      throw new Error(desktopText('desktop.uiSpecialFile'));
    }
  }

  return files;
}

/**
 * Проверяет схему до использования путей и сверяет идентификатор всего списка.
 * Повторённые имена, служебный manifest и отсутствие index.html означают повреждение.
 */
function parseRelease(text: string): UiRelease {
  const value = JSON.parse(text) as UiRelease;

  if (value?.version !== UI_RELEASE_VERSION || !UI_RELEASE_ID.test(value.id)
    || !Array.isArray(value.files) || value.files.length > 10000 || !value.files.length) {
    throw new Error(desktopText('desktop.uiInvalidDescription'));
  }

  const names = new Set<string>();
  const files = value.files.map((file) => {
    if (typeof file?.path !== 'string' || !safePath(file.path) || file.path === 'release.json'
      || names.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0
      || file.size > 256 * 1024 * 1024 || !UI_RELEASE_ID.test(file.sha256)) {
      throw new Error(desktopText('desktop.uiInvalidResourceList'));
    }

    names.add(file.path);

    return {
      path: file.path,
      size: file.size,
      sha256: file.sha256,
    };
  });

  if (!names.has('index.html') || sha256(JSON.stringify(files)) !== value.id) {
    throw new Error(desktopText('desktop.uiVersionMismatch'));
  }

  return {
    version: 1,
    id: value.id,
    files,
  };
}

/**
 * Запечатывает уже готовый web-каталог; приложение публикует только такие пакеты.
 * Manifest исключён из собственного хеша и записывается после проверки всего списка.
 */
export async function sealUiRelease(directory: string): Promise<UiRelease> {
  const files = await inventory(directory);
  const release = parseRelease(JSON.stringify({
    version: 1,
    id: sha256(JSON.stringify(files)),
    files,
  }));

  await writeFile(path.join(directory, 'release.json'), JSON.stringify(release));

  return release;
}

/**
 * Чтение пакета проверяет каждый байт и отсутствие добавленных файлов или ссылок.
 * Повреждение существующего релиза не исправляется поверх работающего окна.
 */
export async function verifyUiRelease(directory: string): Promise<UiRelease> {
  const info = await lstat(directory);

  if (!info.isDirectory()) {
    throw new Error(desktopText('desktop.uiNotDirectory'));
  }

  const manifest = path.join(directory, 'release.json');

  if (!(await lstat(manifest)).isFile()) {
    throw new Error(desktopText('desktop.uiNotFile'));
  }

  const release = parseRelease(await readFile(manifest, 'utf8'));
  const files = await inventory(directory);

  if (JSON.stringify(files) !== JSON.stringify(release.files)) {
    throw new Error(desktopText('desktop.uiDamaged'));
  }

  return release;
}

/**
 * Копирует пакет в собственный временный каталог и публикует одним rename.
 * Старые версии сохраняются, а конкурентный запуск принимает только проверенного победителя.
 */
export async function publishUiRelease(source: string, releases: string): Promise<UiRelease> {
  const release = await verifyUiRelease(source);

  await mkdir(releases, { recursive: true, mode: 0o700 });

  if (!(await lstat(releases)).isDirectory()) {
    throw new Error(desktopText('desktop.uiReleasesNotDirectory'));
  }

  const target = path.join(releases, release.id);

  try {
    await lstat(target);

    const installed = await verifyUiRelease(target);

    if (installed.id !== release.id) {
      throw new Error(desktopText('desktop.uiOtherVersion'));
    }

    return installed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const staging = await mkdtemp(path.join(releases, '.pending-'));

  try {
    for (const file of release.files) {
      const destination = path.join(staging, file.path);

      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(source, file.path), destination);
    }

    await writeFile(path.join(staging, 'release.json'), JSON.stringify(release));
    await verifyUiRelease(staging);

    try {
      await rename(staging, target);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }
    }

    const installed = await verifyUiRelease(target);

    if (installed.id !== release.id) {
      throw new Error(desktopText('desktop.uiOtherPublishedVersion'));
    }

    return installed;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
