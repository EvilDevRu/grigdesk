import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { canonicalJson } from '../lib/canonicalJson.ts';
import { compareProductVersions, parseProductVersion } from '../runtime/productReleaseVersion.ts';
import { syncDirectory } from './files.ts';
import { decodeInstallationReceipt } from './bundleLayout.ts';
import { acquireInstallLock } from './binaryInstall.ts';
import { sha256 } from './hash.ts';
import type { InstallationReceipt } from './bundleLayout.ts';

export { readInstallationSync } from './bundleLayout.ts';
export type { InstallationReceipt } from './bundleLayout.ts';

export interface InstalledPointer {
  format: 1 | 2;
  installationId: string;
  desktop: string | null;
  server: string | null;
  control?: string;
  floor?: string;
}

export interface InstallationFileProof {
  mode: number;
  size: number;
  sha256: string;
}

/**
 * Квитанция согласованной публикации фиксирует те же bytes и окончательные права,
 * которые получит inode до появления имени файла.
 */
export function installationFileProof(text: string | Buffer, mode: number): InstallationFileProof {
  return {
    mode,
    size: Buffer.byteLength(text),
    sha256: sha256(text),
  };
}

/**
 * Проверяет только обычный принадлежащий uid файл, используя один fd.
 * Возврат возможен лишь когда тот же inode всё ещё доступен по имени.
 */
async function inspectInstallationFile(file: string, expected: {
  mode: number;
  limit: number;
  proof?: InstallationFileProof;
}): Promise<Buffer | null> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== expected.mode
      || stat.size > expected.limit || expected.proof && stat.size !== expected.proof.size) {
      throw new Error('installation_incomplete_conflict');
    }

    let bytes: Buffer | null = null;

    if (expected.proof) {
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(Math.min(stat.size || 1, 1024 * 1024));
      let offset = 0;

      while (offset < stat.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset),
          offset);

        if (!bytesRead) {
          throw new Error('installation_incomplete_conflict');
        }

        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }

      if (hash.digest('hex') !== expected.proof.sha256) {
        throw new Error('installation_incomplete_conflict');
      }
    } else {
      bytes = Buffer.alloc(stat.size);

      const { bytesRead } = await handle.read(bytes, 0, stat.size, 0);

      if (bytesRead !== stat.size) {
        throw new Error('installation_incomplete_conflict');
      }
    }

    const named = await fs.lstat(file).catch(() => {
      throw new Error('installation_incomplete_conflict');
    });

    if (!named.isFile() || stat.dev !== named.dev || stat.ino !== named.ino || stat.size !== named.size
      || stat.uid !== named.uid || stat.mode !== named.mode || stat.mtimeMs !== named.mtimeMs) {
      throw new Error('installation_incomplete_conflict');
    }

    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Intent и proof читаются как ограниченный приватный JSON. Только ENOENT
 * означает отсутствие записи, а повреждённый или чужой файл блокирует повтор.
 */
export async function readInstallPublication(file: string): Promise<unknown | null> {
  const bytes = await inspectInstallationFile(file, { mode: 0o600, limit: 1024 * 1024 })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

  if (!bytes) {
    return null;
  }

  const text = bytes.toString('utf8');
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('installation_incomplete_conflict');
  }

  if (value === null || text !== canonicalJson(value) + '\n') {
    throw new Error('installation_incomplete_conflict');
  }

  return value;
}

/**
 * Повтор допускает только совпадающий файл исходной публикации.
 * SHA считается по открытому inode, включая закрытый от записи helper.
 */
export async function verifyInstallPublication(file: string, proof: InstallationFileProof) {
  await inspectInstallationFile(file, {
    mode: proof.mode,
    limit: proof.size,
    proof,
  });
}

/**
 * Публикует файл атомарно и без замены. Существующий файл засчитывается
 * только после повторной проверки uid, прав, inode, размера и SHA.
 */
export async function publishInstallFile(
  file: string, bytes: string | Buffer, mode: number, temporaryDirectory = path.dirname(file),
) {
  const directory = path.dirname(file);
  const temporary = path.join(temporaryDirectory, '.grigdesk-install-' + randomUUID());
  const proof = installationFileProof(bytes, mode);
  const handle = await fs.open(temporary, 'wx', 0o600);

  try {
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fs.link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    await verifyInstallPublication(file, proof);
    await syncDirectory(directory);
  } finally {
    await fs.unlink(temporary);
  }

  return proof;
}

/**
 * Все владельцы обновления используют одну блокировку I. Electron может
 * передать FD стабильному maintenance, который уже содержит native helper.
 */
export async function acquireInstalledUpdateLock(root: string) {
  await assertInstallationPath(root, 'update');

  return acquireInstallLock(path.join(root, 'update/installation'), {
    waitMs: 0,
    darwinMaintenance: path.join(root, 'update/maintenance'),
  });
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
  const value = decodeInstalledPointer(receipt, await readInstallationJson(receipt.root, 'current.json'));

  for (const relative of [value.desktop, value.server, value.control]) {
    if (relative != null) {
      await assertInstallationPath(receipt.root, relative);
    }
  }

  return value;
}

/**
 * Читает форму указателя без файловых эффектов. Наличие каталога проверяется для current.
 * Канонический путь поколения подтверждается отдельно для каждой роли.
 */
export function decodeInstalledPointer(receipt: InstallationReceipt, input: unknown): InstalledPointer {
  const value = input as InstalledPointer;
  const keys = value?.format === 2 ? 'control,desktop,floor,format,installationId,server'
    : 'desktop,format,installationId,server';

  if (!value || ![1, 2].includes(value.format) || value.installationId !== receipt.installationId
    || Object.keys(value).sort().join(',') !== keys) {
    throw new Error('installation_pointer_invalid');
  }

  if (value.format === 2) {
    const [directory, version, extra] = typeof value.control === 'string' ? value.control.split('/') : [];

    if (directory !== 'generations' || !parseProductVersion(version) || extra !== undefined
      || !parseProductVersion(value.floor) || compareProductVersions(version!, value.floor!) < 0) {
      throw new Error('installation_pointer_invalid');
    }
  }

  for (const component of ['desktop', 'server'] as const) {
    const relative = value[component];

    if (relative === null) {
      if (receipt.mode === 'local' || receipt.mode === component.replace('desktop', 'remote')) {
        throw new Error('installation_component_missing');
      }

      continue;
    }

    const parts = typeof relative === 'string' ? relative.split('/') : [];

    const version = parts[1];

    if (parts.length !== 3 || parts[0] !== 'generations' || !version || !parseProductVersion(version)
      || parts[2] !== component || value.format === 2 && (compareProductVersions(version, value.floor!) < 0
        || component === 'desktop' && receipt.mode === 'server'
        || component === 'server' && receipt.mode === 'remote')) {
      throw new Error('installation_pointer_invalid');
    }
  }

  return value;
}
