import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { canonicalJson } from '../lib/canonicalJson.ts';
import { parseProductVersion } from '../runtime/productReleaseVersion.ts';
import { syncDirectory } from './files.ts';
import { decodeInstallationReceipt } from './bundleLayout.ts';
import type { InstallationReceipt } from './bundleLayout.ts';

export { readInstallationSync } from './bundleLayout.ts';
export type { InstallationReceipt } from './bundleLayout.ts';

export interface InstalledPointer {
  format: 1;
  installationId: string;
  desktop: string | null;
  server: string | null;
}

/**
 * Каждый управляемый путь раскрывается по сегментам без символических ссылок.
 * Приватные каталоги установки принадлежат uid процесса и не доступны для чужой записи.
 */
export async function assertInstallationPath(root: string, relative = ''): Promise<string> {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root === '/') {
    throw new Error('installation_root_invalid');
  }

  if (relative && relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('installation_path_invalid');
  }

  const parts = root.split('/').filter(Boolean);
  let current = '/';

  for (const part of parts) {
    current = path.join(current, part);

    const stat = await fs.lstat(current);

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('installation_path_invalid');
    }
  }

  for (const part of ['', ...relative.split('/').filter(Boolean)]) {
    current = part ? path.join(current, part) : root;

    const stat = await fs.lstat(current);

    if (stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0) {
      throw new Error('installation_owner_invalid');
    }
  }

  return current;
}

/**
 * Открытый fd связывает проверку прав и чтение приватного JSON одним inode.
 * Отсутствие обрабатывает вызывающая сторона; повреждение никогда не означает пустое состояние.
 */
export async function readInstallationJson(root: string, relative: string): Promise<unknown> {
  const file = await assertInstallationPath(root, relative);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0
      || stat.size > 1024 * 1024) {
      throw new Error('installation_state_invalid');
    }

    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

/**
 * Journal и pointer получают одинаковую durable-публикацию на своей файловой системе.
 * Уникальный temporary не пересекается с параллельным writer, rename предшествует fsync каталога.
 */
export async function writeInstallationJson(root: string, relative: string, value: unknown): Promise<void> {
  const directory = path.posix.dirname(relative);

  await assertInstallationPath(root, directory === '.' ? '' : directory);

  const file = path.join(root, relative);
  const temporary = `${file}.tmp-${randomUUID()}`;
  const handle = await fs.open(temporary, 'wx', 0o600);

  try {
    await handle.writeFile(`${canonicalJson(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Асинхронные consumers читают receipt через защищённый fd и общий декодер.
 * Та же форма используется синхронным bootstrap без ослабления прав установки.
 */
export async function readInstallation(root: string): Promise<InstallationReceipt> {
  return decodeInstallationReceipt(
    await readInstallationJson(root, 'installation.json') as InstallationReceipt, root,
  );
}

/**
 * Одна запись содержит обе части local-пары, поэтому половинного switch нет.
 * Каждый компонент указывает только на разрешённый каталог поколений этой установки.
 */
export async function readInstalledPointer(receipt: InstallationReceipt): Promise<InstalledPointer> {
  const value = await readInstallationJson(receipt.root, 'current.json') as InstalledPointer;

  if (!value || value.format !== 1 || value.installationId !== receipt.installationId
    || Object.keys(value).sort().join(',') !== 'desktop,format,installationId,server') {
    throw new Error('installation_pointer_invalid');
  }

  for (const component of ['desktop', 'server'] as const) {
    const relative = value[component];

    if (relative === null) {
      if (receipt.mode === 'local' || receipt.mode === component.replace('desktop', 'remote')) {
        throw new Error('installation_component_missing');
      }

      continue;
    }

    const parts = relative.split('/');

    if (parts.length !== 3 || parts[0] !== 'generations' || !parseProductVersion(parts[1])
      || parts[2] !== component) {
      throw new Error('installation_pointer_invalid');
    }

    await assertInstallationPath(receipt.root, relative);
  }


  return value;
}
