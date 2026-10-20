import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { acquireDirectoryLock } from '../../../shared/node/directoryLock.ts';
import { initializeFactoryRuntimeRegistry, inspectFactoryRuntimePins } from '../lib/factoryRuntimePins.ts';
import {
  PACKAGE_ID,
  inspectRuntimeLeases,
  privateRuntimeDirectory,
  readRuntimeJson,
  runtimeError,
  syncRuntimeDirectory,
  withPackageLock,
  withRuntimeGcLock,
  writeRuntimeJson,
} from './leases.ts';

export const SERVER_CACHE_POLICY = { mode: 'manual', unusedDays: 7 } as const;

interface RuntimeUsage {
  format: 1;
  current: string | null;
  previous: string | null;
  lastUsed: Record<string, number>;
}

export interface ServerCachePruneResult {
  deleted: string[];
  retained: {
    packageId: string;
    reason: string;
  }[];
  unknown: {
    packageId: string;
    reason: string;
  }[];
}

export interface ServerCachePruneOptions {
  cacheDir: string;
  now?: number;
  currentPackageId?: string;
  operations?: {
    rename?(source: string, target: string): Promise<void>;
    remove?(directory: string): Promise<void>;
  };
  checkpoint?(phase: 'candidate' | 'renamed', packageId: string): Promise<void>;
}

/**
 * Usage хранится вне marker tree и всегда читается как приватный atomic snapshot.
 * Потерянная история не разрешает гадать о current/previous либо возрасте generation.
 */
async function readUsage(cacheDir: string): Promise<RuntimeUsage> {
  const value = await readRuntimeJson(path.join(cacheDir, 'state/usage.json')) as RuntimeUsage;

  if (!value || Object.keys(value).sort().join() !== 'current,format,lastUsed,previous'
    || value.format !== 1 || (value.current !== null && !PACKAGE_ID.test(value.current))
    || (value.previous !== null && !PACKAGE_ID.test(value.previous))
    || !value.lastUsed || typeof value.lastUsed !== 'object' || Array.isArray(value.lastUsed)
    || !Object.entries(value.lastUsed).every(([id, time]) => PACKAGE_ID.test(id)
      && Number.isSafeInteger(time) && time >= 0)) {
    throw runtimeError('server_cache_usage_invalid');
  }

  return value;
}

/**
 * Launcher вызывает usage после materializeWithLease, с уже опубликованной защитой.
 * Здесь нельзя держать package lock: инициализация registry берёт global GC lock первой.
 */
export async function recordServerRuntimeUsage(input: {
  cacheDir: string;
  packageId: string;
  now?: number;
  activate?: boolean;
}): Promise<void> {
  const now = input.now ?? Date.now();

  if (!PACKAGE_ID.test(input.packageId) || !Number.isSafeInteger(now) || now < 0) {
    throw runtimeError('server_cache_usage_invalid');
  }

  await initializeFactoryRuntimeRegistry(input.cacheDir);
  await privateRuntimeDirectory(path.join(input.cacheDir, '.locks'));

  const lock = await acquireDirectoryLock(path.join(input.cacheDir, '.locks', 'usage'));

  try {
    const value = await readUsage(input.cacheDir).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      const marker = path.join(input.cacheDir, 'state/usage.initialized.json');

      if (await fs.lstat(marker).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code !== 'ENOENT') {
          throw failure;
        }

        return null;
      })) {
        throw runtimeError('server_cache_usage_invalid');
      }

      await writeRuntimeJson(marker, { format: 1 });

      return {
        format: 1,
        current: null,
        previous: null,
        lastUsed: {},
      } as RuntimeUsage;
    });

    if (input.activate !== false && value.current !== input.packageId) {
      value.previous = value.current;
      value.current = input.packageId;
    }

    value.lastUsed[input.packageId] = Math.max(value.lastUsed[input.packageId] ?? 0, now);
    await writeRuntimeJson(path.join(input.cacheDir, 'state/usage.json'), value);
  } finally {
    await lock.release();
  }
}

/**
 * Snapshot различает целый trash и частично удалённый после ошибки unlink.
 * Ссылки разрешены только относительные внутри своего R, foreign targets не обходятся.
 */
async function treeSnapshot(directory: string): Promise<string[]> {
  const result: string[] = [];

  /**
   * Обход не следует ссылкам и собирает стабильные поля файлов своего дерева.
   * Снимок нужен только ручному GC для консервативного отката неудачного удаления.
   */
  async function walk(relative: string): Promise<void> {
    const file = path.join(directory, relative);
    const stat = await fs.lstat(file, { bigint: true });
    const mode = Number(stat.mode & 0o777n);

    if (stat.uid !== BigInt(process.getuid!()) || (stat.isDirectory() ? (mode & 0o077) !== 0
      : !stat.isSymbolicLink() && ![0o444, 0o555, 0o600].includes(mode))) {
      throw runtimeError('server_cache_generation_unknown');
    }

    if (relative) {
      result.push([relative, stat.ino, stat.size, stat.mode, stat.mtimeNs].join(':'));
    }

    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(file);
      const target = await fs.realpath(file);

      if (path.isAbsolute(link) || !target.startsWith(`${directory}${path.sep}`)) {
        throw runtimeError('server_cache_generation_unknown');
      }
    } else if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) {
        await walk(path.join(relative, name));
      }
    } else if (!stat.isFile()) {
      throw runtimeError('server_cache_generation_unknown');
    }
  }

  await walk('');

  return result;
}

/**
 * Удаление меняет права лишь каталогов уже принадлежащего GC trash.
 * Это нужно для допустимых payload directories 0500; готовое R до rename не меняется.
 */
async function removeOwnTrash(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const child = path.join(directory, entry.name);

      await fs.chmod(child, 0o700);
      await removeOwnTrash(child);
    } else {
      await fs.unlink(path.join(directory, entry.name));
    }
  }

  await fs.rmdir(directory);
}

/**
 * Package lock сохраняется через повторную проверку до rename в private trash.
 * Ошибка до удаления возвращает целое R; частичный trash никогда не публикуется как ready.
 */
async function pruneGeneration(input: ServerCachePruneOptions, packageId: string,
  result: ServerCachePruneResult, now: number): Promise<void> {
  await withPackageLock(input.cacheDir, packageId, async () => {
    await input.checkpoint?.('candidate', packageId);

    const usage = await readUsage(input.cacheDir);
    const retained = (reason: string) => result.retained.push({ packageId, reason });
    const unknown = (reason: string) => result.unknown.push({ packageId, reason });

    if (packageId === usage.current || packageId === input.currentPackageId) {
      retained('current');

      return;
    }

    if (packageId === usage.previous) {
      retained('previous');

      return;
    }

    const lastUsed = usage.lastUsed[packageId];

    if (lastUsed === undefined) {
      unknown('usage-unknown');

      return;
    }

    if (now - lastUsed <= SERVER_CACHE_POLICY.unusedDays * 24 * 60 * 60 * 1000) {
      retained('recent');

      return;
    }

    const leases = await inspectRuntimeLeases({ cacheDir: input.cacheDir, packageId });
    const pins = await inspectFactoryRuntimePins({ cacheDir: input.cacheDir, packageId });

    if (leases.state === 'unknown' || pins.state === 'unknown') {
      unknown('authority-unknown');

      return;
    }

    if (leases.state === 'protected' || pins.state === 'protected') {
      retained(leases.state === 'protected' ? 'lease' : pins.reasons[0] ?? 'attempt-pin');

      return;
    }

    const directory = path.join(input.cacheDir, 'packages', packageId);

    await privateRuntimeDirectory(directory, false);

    const marker = await readRuntimeJson(path.join(directory, '.ready.json')) as Record<string, unknown>;

    if (marker.format !== 2 || marker.packageId !== packageId) {
      throw runtimeError('server_cache_generation_unknown');
    }

    const snapshot = await treeSnapshot(directory);
    const trashRoot = path.join(input.cacheDir, '.trash');

    await privateRuntimeDirectory(trashRoot);

    const trash = path.join(trashRoot, `${packageId}.${randomUUID()}`);
    const rename = input.operations?.rename ?? fs.rename;
    const remove = input.operations?.remove ?? removeOwnTrash;

    try {
      await rename(directory, trash);
      await syncRuntimeDirectory(path.join(input.cacheDir, 'packages'));
      await syncRuntimeDirectory(trashRoot);
      await input.checkpoint?.('renamed', packageId);
      await remove(trash);
      await syncRuntimeDirectory(trashRoot);
      result.deleted.push(packageId);
    } catch (error) {
      const remaining = await treeSnapshot(trash).catch(() => null);

      if (remaining && JSON.stringify(remaining) === JSON.stringify(snapshot)
        && !(await fs.lstat(directory).catch(() => null))) {
        await fs.rename(trash, directory);
        await syncRuntimeDirectory(path.join(input.cacheDir, 'packages'));
        await syncRuntimeDirectory(trashRoot);
      }

      throw error;
    }
  });
}

/**
 * Ручная команда сериализует GC и не запускается при boot/readiness/prepare.
 * Выбор каждого поколения повторяется под его lock, ошибки становятся unknown keep.
 */
export async function pruneServerCache(input: ServerCachePruneOptions): Promise<ServerCachePruneResult> {
  const now = input.now ?? Date.now();

  if (!Number.isSafeInteger(now) || now < 0
    || (input.currentPackageId !== undefined && !PACKAGE_ID.test(input.currentPackageId))) {
    throw runtimeError('server_cache_prune_invalid');
  }

  const result: ServerCachePruneResult = {
    deleted: [],
    retained: [],
    unknown: [],
  };

  await withRuntimeGcLock(input.cacheDir, async () => {
    const packages = path.join(input.cacheDir, 'packages');

    try {
      await privateRuntimeDirectory(packages, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }

      throw error;
    }

    for (const packageId of (await fs.readdir(packages)).sort()) {
      if (!PACKAGE_ID.test(packageId)) {
        result.unknown.push({ packageId, reason: 'foreign-path' });
        continue;
      }

      try {
        await pruneGeneration(input, packageId, result, now);
      } catch {
        result.unknown.push({ packageId, reason: 'metadata-or-io-unknown' });
      }
    }

    await writeRuntimeJson(path.join(input.cacheDir, 'state/gc.json'), {
      format: 1,
      at: now,
      ...result,
    });
  });

  return result;
}
