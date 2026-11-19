import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { privateRuntimeDirectory, readRuntimeJson, syncRuntimeDirectory, writeRuntimeJson }
  from '../binary/leases.ts';

export interface OwnershipPaths {
  dataHome: string;
  stateDir: string;
  factoryControlDir: string;
}

function receiptFile(dataHome: string): string {
  return path.join(dataHome, 'state', 'darwin-factory-ownership.json');
}

/**
 * Идентичность каталога считывается с открытого FD и сверяется с физическим именем.
 * Сохраняем значения bigint строками, включая поколение inode после удаления.
 */
async function directoryIdentity(file: string, isControl: boolean) {
  const directory = await fs.open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);

  try {
    const held = await directory.stat({ bigint: true });
    const named = await fs.lstat(file, { bigint: true });

    if (!held.isDirectory() || held.uid !== BigInt(process.getuid!())
      || isControl && (held.mode & 0o7777n) !== 0o700n || await fs.realpath(file) !== file
      || held.dev !== named.dev || held.ino !== named.ino || held.birthtimeNs !== named.birthtimeNs) {
      throw new Error('factory_ownership_root_invalid');
    }

    return [file, String(held.dev), String(held.ino), String(held.birthtimeNs)];
  } finally {
    await directory.close();
  }
}

/**
 * Использует те же непересекающиеся state и control roots, что фабрика.
 * Списки durable launch и runner получают собственную физическую идентичность.
 */
function ownershipDirectories({ stateDir, factoryControlDir }: OwnershipPaths) {
  const roots = [stateDir, factoryControlDir];

  if (roots.some((root) => !path.isAbsolute(root) || path.resolve(root) !== root
    || root === '/' || /[\n\t]/u.test(root))
    || roots.some((root, index) => root === roots[1 - index]
      || root.startsWith(`${roots[1 - index]}/`))) {
    throw new Error('factory_ownership_root_invalid');
  }

  return [...roots,
    path.join(factoryControlDir, 'launch-processes'),
    path.join(factoryControlDir, 'runner-processes'),
    path.join(factoryControlDir, 'external-provider-processes'),
    path.join(factoryControlDir, 'transaction-finalization'),
    path.join(factoryControlDir, 'transactions'),
    path.join(factoryControlDir, 'profile-channels'),
    path.join(stateDir, 'archive'),
  ];
}

/** Снимок неизменяемых свойств каталогов, отдельно от их содержимого. */
async function ownershipIdentity(directories: string[]) {
  const privateControl = directories.slice(1, -1);

  return {
    format: 1,
    directories: await Promise.all(directories.map((directory) =>
      directoryIdentity(directory, privateControl.includes(directory)))),
  };
}

/**
 * Read-only проверка для безопасных операций. Ошибка, новый inode и ENOENT
 * возвращаются вызывающему и не могут считаться свежей пустой установкой.
 */
export async function verifyDarwinOwnershipRoots(paths: OwnershipPaths): Promise<void> {
  const expected = await readRuntimeJson(receiptFile(paths.dataHome));
  const current = await ownershipIdentity(ownershipDirectories(paths));

  if (canonicalJson(expected) !== canonicalJson(current)) {
    throw new Error('factory_ownership_root_changed');
  }
}

/**
 * Повторная инициализация до receipt снова подтверждает создание всех имён
 * внутри D, включая parent уже видимого control после частичного fsync.
 */
async function syncBootstrapDirectories(paths: OwnershipPaths, directory: string): Promise<void> {
  let current = directory;

  for (;;) {
    const parent = path.dirname(current);

    if (await fs.realpath(current) !== current || await fs.realpath(parent) !== parent) {
      throw new Error('factory_ownership_root_invalid');
    }

    await syncRuntimeDirectory(current);
    await syncRuntimeDirectory(parent);

    if (parent === paths.dataHome || !parent.startsWith(paths.dataHome + path.sep)) {
      return;
    }

    current = parent;
  }
}

/**
 * Вызывается после блокировки папки данных и до приёма запросов.
 * С уже записанной квитанцией выполняется только сверка.
 */
export async function initializeDarwinOwnershipRoots(paths: OwnershipPaths): Promise<void> {
  const file = receiptFile(paths.dataHome);
  const directories = ownershipDirectories(paths);
  const existing = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return null;
  });

  if (existing) {
    await verifyDarwinOwnershipRoots(paths);

    return;
  }

  for (const directory of directories) {
    const stateArea = directory === paths.stateDir || directory === path.join(paths.stateDir, 'archive');

    if (stateArea && await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return null;
    })) {
      continue;
    }

    await privateRuntimeDirectory(directory);

    if (!stateArea) {
      await syncBootstrapDirectories(paths, directory);
    }
  }

  await writeRuntimeJson(file, await ownershipIdentity(directories));
  await verifyDarwinOwnershipRoots(paths);
}
