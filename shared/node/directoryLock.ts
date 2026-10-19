import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export interface DirectoryLockOwner {
  pid: number;
  starttime: string;
  token: string;
}

export interface DirectoryLockProbe {
  readStat(pid: number): Promise<string>;
  signal(pid: number): void;
}

export interface DirectoryLockOptions {
  waitMs?: number;
  pollMs?: number;
  probe?: DirectoryLockProbe;
}

export interface DirectoryLock {
  owner: DirectoryLockOwner;
  release(): Promise<void>;
}

const actualProbe: DirectoryLockProbe = {
  readStat: (pid) => fs.readFile(`/proc/${pid}/stat`, 'utf8'),
  signal: (pid) => {
    process.kill(pid, 0);
  },
};

function procFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
}

/**
 * Отсутствие процесса должно быть доказано, ошибка доступа таким доказательством не служит.
 * Время старта отличает повторно выданный PID от прежнего владельца.
 */
export async function processOwnerState(
  owner: DirectoryLockOwner,
  probe: DirectoryLockProbe = actualProbe,
): Promise<'alive' | 'dead' | 'unknown'> {
  let permitted = true;

  try {
    probe.signal(owner.pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return 'dead';
    }

    permitted = false;
  }

  try {
    const fields = procFields(await probe.readStat(owner.pid));
    const starttime = fields[19];

    if (!starttime || !/^\d+$/u.test(starttime)) {
      return 'unknown';
    }

    if (starttime !== owner.starttime || fields[0] === 'Z') {
      return 'dead';
    }

    return permitted ? 'alive' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Неизвестный, ownerless или недоступный lock остаётся занятым, а не считается мёртвым.
 * Owner читается без следования ссылке, и только из настоящего каталога lock.
 */
async function readOwner(directory: string): Promise<DirectoryLockOwner | null> {
  let handle;

  try {
    if (!(await fs.lstat(directory)).isDirectory()) {
      return null;
    }

    handle = await fs.open(path.join(directory, 'owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW);

    const value = JSON.parse(await handle.readFile('utf8')) as Partial<DirectoryLockOwner>;

    return Number.isSafeInteger(value.pid) && Number(value.pid) > 0
      && typeof value.starttime === 'string' && value.starttime.length > 0
      && typeof value.token === 'string' && value.token.length > 0 ? value as DirectoryLockOwner : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function sameOwner(left: DirectoryLockOwner | null, right: DirectoryLockOwner): boolean {
  return left?.pid === right.pid && left.starttime === right.starttime && left.token === right.token;
}

/**
 * Reclaim внутри старого каталога сериализует уборщиков до его удаления.
 * Владелец перечитывается после захвата claim: свежий lock не удаляется по старому снимку.
 */
async function retireDead(directory: string, options: DirectoryLockOptions): Promise<void> {
  const claim = path.join(directory, '.reclaim');
  let inode: bigint;

  try {
    await fs.mkdir(claim, { mode: 0o700 });
    inode = (await fs.lstat(claim, { bigint: true })).ino;
  } catch (error) {
    if (['EEXIST', 'ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) {
      return;
    }

    throw error;
  }

  try {
    const owner = await readOwner(directory);

    if (owner && await processOwnerState(owner, options.probe) === 'dead') {
      const stale = `${directory}.stale-${randomBytes(16).toString('hex')}`;

      await fs.rename(directory, stale);
      await fs.rm(stale, { recursive: true, force: true });
    }
  } finally {
    const current = await fs.lstat(claim, { bigint: true }).catch(() => null);

    if (current?.isDirectory() && current.ino === inode) {
      try {
        await fs.rmdir(claim);
      } catch (error) {
        // Release мог уже переименовать весь lock после нашего lstat.
        // Отсутствие claim завершает уборку; остальные ошибки не скрываются.
        if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) {
          throw error;
        }
      }
    }
  }
}

/**
 * Эксклюзивный mkdir-lock ограничивает ожидание и снимается только своим владельцем.
 * Восстановление после SIGKILL требует PID и времени старта, а не возраста lock.
 */
export async function acquireDirectoryLock(
  directory: string,
  options: DirectoryLockOptions = {},
): Promise<DirectoryLock> {
  const starttime = procFields(await actualProbe.readStat(process.pid))[19];

  if (!starttime || !/^\d+$/u.test(starttime)) {
    throw new Error('Не удалось установить время старта владельца directory lock');
  }

  const owner = {
    pid: process.pid,
    starttime,
    token: randomBytes(16).toString('hex'),
  };
  const deadline = performance.now() + (options.waitMs ?? 15000);

  for (;;) {
    let created = false;

    try {
      await fs.mkdir(directory, { mode: 0o700 });
      created = true;
      await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify(owner), {
        flag: 'wx',
        mode: 0o600,
      });

      let released = false;

      return {
        owner,
        /**
         * Чужая замена owner не снимается старым handle даже после повторного release.
         * Переименование отделяет уборку от нового владельца прежнего имени.
         */
        async release() {
          if (released || !sameOwner(await readOwner(directory), owner)) {
            return;
          }

          released = true;

          const retired = `${directory}.release-${owner.token}`;

          await fs.rename(directory, retired);
          await fs.rm(retired, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (created) {
        await fs.rm(directory, { recursive: true, force: true });

        throw error;
      }

      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    await retireDead(directory, options);

    if (performance.now() >= deadline) {
      throw Object.assign(new Error('Кэш DeepSeek занят другим процессом; повторите запуск'), {
        code: 'directory_lock_busy',
      });
    }

    await pause(options.pollMs ?? 50);
  }
}
