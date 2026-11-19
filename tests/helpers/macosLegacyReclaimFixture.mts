import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { directoryLockState } from '../../shared/node/directoryLock.ts';

/**
 * Старый retireDead с вложенным .reclaim используется только в native RED.
 * Состояние владельца проверяет действующий Darwin port, а inode claim
 * остаётся предметом старой проверки и причиной отказа после прерывания.
 */
export async function legacyReclaim(directory: string, checkpoint?: () => Promise<void>): Promise<boolean> {
  const claim = path.join(directory, '.reclaim');
  let inode: bigint;

  try {
    await fs.mkdir(claim, { mode: 0o700 });
    inode = (await fs.lstat(claim, { bigint: true })).ino;
  } catch (error) {
    if (['EEXIST', 'ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) {
      return false;
    }

    throw error;
  }

  try {
    await checkpoint?.();

    if (await directoryLockState(directory) !== 'dead') {
      return false;
    }

    const stale = `${directory}.stale-${randomBytes(16).toString('hex')}`;

    await fs.rename(directory, stale);
    await fs.rm(stale, { recursive: true, force: true });

    return true;
  } finally {
    const current = await fs.lstat(claim, { bigint: true }).catch(() => null);

    if (current?.isDirectory() && current.ino === inode) {
      await fs.rmdir(claim).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  }
}
