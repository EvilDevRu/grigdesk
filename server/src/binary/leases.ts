import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { acquireDirectoryLock, type DirectoryLockOptions } from '../../../shared/node/directoryLock.ts';
import type { ExtractionOptions } from './cache.ts';

export interface RuntimeOwner {
  pid: number;
  starttime: string;
}

export interface RuntimeLease {
  format: 1;
  token: string;
  packageId: string;
  kind: 'prepare' | 'server' | 'engine';
  owners: RuntimeOwner[];
}

export interface ProcessProbe {
  readStat(pid: number): Promise<string>;
}

export interface LeaseLocation {
  cacheDir: string;
  packageId: string;
  token: string;
}

export const PACKAGE_ID = /^[a-f0-9]{64}$/u;
export const RUNTIME_TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

const actualProbe: ProcessProbe = {
  readStat: (pid) => fs.readFile(`/proc/${pid}/stat`, 'utf8'),
};

/**
 * Именованный отказ оставляет lease и поколение для следующего безопасного разбора.
 * Вызывающий видит код контракта без содержимого состояния и credentials.
 */
export function runtimeError(code: string): Error {
  return Object.assign(new Error(`Не удалось подтвердить runtime сервера: ${code}`), { code });
}

/**
 * Каталоги metadata принадлежат текущему uid и недоступны остальным пользователям.
 * Проверка physical path запрещает ссылки в любом компоненте, включая готовый cache.
 */
export async function privateRuntimeDirectory(directory: string, create = true): Promise<void> {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || directory === '/') {
    throw runtimeError('server_cache_invalid');
  }

  const missing: string[] = [];
  let existing = directory;
  let existingStat;

  for (;;) {
    existingStat = await fs.lstat(existing).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return null;
    });

    if (existingStat) {
      break;
    }

    missing.push(existing);
    existing = path.dirname(existing);
  }

  if (!existingStat.isDirectory() || await fs.realpath(existing) !== existing) {
    throw runtimeError('server_cache_invalid');
  }

  if (!create && missing.length > 0) {
    throw Object.assign(new Error('Metadata ещё не опубликована'), { code: 'ENOENT' });
  }

  for (const item of missing.reverse()) {
    await fs.mkdir(item, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
    await syncRuntimeDirectory(path.dirname(item));
  }

  const stat = await fs.lstat(directory);

  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0
    || stat.uid !== process.getuid?.() || await fs.realpath(directory) !== directory) {
    throw runtimeError('server_cache_invalid');
  }
}

/**
 * O_NOFOLLOW и fstat защищают приватные записи от подмены последнего компонента ссылкой.
 * Родитель проверяется до чтения; отсутствие отличается от повреждённой metadata.
 */
export async function readRuntimeJson(file: string): Promise<unknown> {
  await privateRuntimeDirectory(path.dirname(file), false);

  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
      || stat.size > 1024 * 1024) {
      throw runtimeError('server_runtime_metadata_invalid');
    }

    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

/**
 * Fsync каталога завершает durable публикацию или удаление отдельной записи metadata.
 * Это выполняется снаружи marker tree и не меняет fingerprints готового payload.
 */
export async function syncRuntimeDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Temp создаётся эксклюзивно и синхронизируется до rename, затем синхронизируется каталог.
 * CAS authority использует отдельную проверку под package lock, а не перезапись вслепую.
 */
export async function writeRuntimeJson(file: string, value: unknown): Promise<void> {
  await privateRuntimeDirectory(path.dirname(file));

  const existing = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return null;
  });

  if (existing && (!existing.isFile() || existing.uid !== process.getuid?.()
    || (existing.mode & 0o777) !== 0o600)) {
    throw runtimeError('server_runtime_metadata_invalid');
  }

  const temporary = path.join(path.dirname(file), `.write-${randomUUID()}`);
  const handle = await fs.open(temporary, 'wx', 0o600);

  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, file);
    await syncRuntimeDirectory(path.dirname(file));
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

/**
 * Package lock совпадает с lock materializePayload; повторный захват внутри запрещён.
 * Global GC lock берётся только раньше package lock, никогда в afterReady или bind.
 */
export async function withPackageLock<T>(cacheDir: string, packageId: string,
  action: () => Promise<T>, options?: DirectoryLockOptions): Promise<T> {
  if (!PACKAGE_ID.test(packageId)) {
    throw runtimeError('server_lease_invalid');
  }

  await privateRuntimeDirectory(cacheDir);
  await privateRuntimeDirectory(path.join(cacheDir, '.locks'));

  const lock = await acquireDirectoryLock(path.join(cacheDir, '.locks', packageId), options);

  try {
    return await action();
  } finally {
    await lock.release();
  }
}

/**
 * Общий lock сериализует registry, usage и GC без удержания attempt lock движка.
 * Внутри допускается package lock; обратный порядок создавал бы дедлок с bind.
 */
export async function withRuntimeGcLock<T>(cacheDir: string, action: () => Promise<T>): Promise<T> {
  await privateRuntimeDirectory(cacheDir);
  await privateRuntimeDirectory(path.join(cacheDir, '.locks'));

  const lock = await acquireDirectoryLock(path.join(cacheDir, '.locks', 'gc'));

  try {
    return await action();
  } finally {
    await lock.release();
  }
}

function validOwner(owner: RuntimeOwner): boolean {
  return Number.isSafeInteger(owner?.pid) && owner.pid > 0
    && typeof owner.starttime === 'string' && /^\d+$/u.test(owner.starttime);
}

function statFields(stat: string, pid: number): string[] {
  const close = stat.lastIndexOf(')');

  return stat.startsWith(`${pid} (`) && close > 0 ? stat.slice(close + 2).trim().split(/\s+/u) : [];
}

/**
 * PID без времени старта не доказывает владение: номер мог уже получить другой процесс.
 * Только ENOENT/ESRCH, zombie или смена starttime доказывают смерть, EACCES означает keep.
 */
export async function runtimeOwnerState(owner: RuntimeOwner,
  probe: ProcessProbe = actualProbe): Promise<'alive' | 'dead' | 'unknown'> {
  if (!validOwner(owner)) {
    return 'unknown';
  }

  try {
    const fields = statFields(await probe.readStat(owner.pid), owner.pid);
    const starttime = fields[19];

    if (!starttime || !/^\d+$/u.test(starttime) || !/^[A-Z]$/u.test(fields[0] ?? '')) {
      return 'unknown';
    }

    return starttime !== owner.starttime || ['Z', 'X'].includes(fields[0]!) ? 'dead' : 'alive';
  } catch (error) {
    return ['ENOENT', 'ESRCH'].includes(String((error as NodeJS.ErrnoException).code)) ? 'dead' : 'unknown';
  }
}

/**
 * Новый owner всегда считывается из proc, а не принимается из provider metadata.
 * Неизвестное состояние не позволяет выдать новый handle со случайной identity.
 */
export async function readProcessOwner(pid: number): Promise<RuntimeOwner> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw runtimeError('server_lease_owner_unknown');
  }

  const fields = statFields(await actualProbe.readStat(pid), pid);
  const owner = { pid, starttime: fields[19] ?? '' };

  if (!validOwner(owner) || ['Z', 'X'].includes(fields[0] ?? '')) {
    throw runtimeError('server_lease_owner_unknown');
  }

  return owner;
}

function sameOwner(left: RuntimeOwner, right: RuntimeOwner): boolean {
  return left.pid === right.pid && left.starttime === right.starttime;
}

/**
 * Token и package ID проверяются до построения пути; схема записи закрыта.
 * Непонятная metadata сохраняется и не разрешает release или автоматическое удаление.
 */
function leaseFile(input: LeaseLocation): string {
  if (!PACKAGE_ID.test(input.packageId) || !RUNTIME_TOKEN.test(input.token)) {
    throw runtimeError('server_lease_invalid');
  }

  return path.join(input.cacheDir, 'leases', input.packageId, `${input.token}.json`);
}

/**
 * Lease содержит только host identity и список владельцев, без provider state.
 * Пустой список запрещён: передача всегда добавляет нового owner до снятия старого.
 */
async function readLease(input: LeaseLocation): Promise<RuntimeLease> {
  try {
    const value = await readRuntimeJson(leaseFile(input)) as RuntimeLease;

    if (!value || Object.keys(value).sort().join() !== 'format,kind,owners,packageId,token'
      || value.format !== 1 || value.token !== input.token || value.packageId !== input.packageId
      || !['prepare', 'server', 'engine'].includes(value.kind) || !Array.isArray(value.owners)
      || value.owners.length === 0 || !value.owners.every((owner) => validOwner(owner)
        && Object.keys(owner).sort().join() === 'pid,starttime')) {
      throw runtimeError('server_lease_invalid');
    }

    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw error;
    }

    throw runtimeError('server_lease_invalid');
  }
}

/**
 * Вызывается только из afterReady под уже удерживаемым package lock.
 * Callback failure сохраняет опубликованную lease, чтобы неизвестный spawn не потерял R.
 */
export async function createRuntimeLeaseLocked(input: {
  cacheDir: string;
  packageId: string;
  kind: RuntimeLease['kind'];
  ownerPid?: number;
}): Promise<RuntimeLease> {
  const ownerPid = input.ownerPid ?? (input.kind === 'prepare' ? process.ppid : process.pid);
  const owner = await readProcessOwner(ownerPid);
  const lease: RuntimeLease = {
    format: 1,
    token: randomUUID(),
    packageId: input.packageId,
    kind: input.kind,
    owners: [owner],
  };

  await privateRuntimeDirectory(path.join(input.cacheDir, 'leases'));
  await writeRuntimeJson(leaseFile({ ...input, token: lease.token }), lease);

  return lease;
}

/**
 * Защита появляется между verify и отпусканием того же lock распаковщика.
 * Prepare по умолчанию принадлежит родителю probe, server и engine — самому launcher.
 */
export async function materializeWithLease(options: ExtractionOptions, input: {
  kind: RuntimeLease['kind'];
  ownerPid?: number;
}): Promise<{ root: string; lease: RuntimeLease }> {
  const { materializePayload } = await import('./cache.ts');
  let lease: RuntimeLease | undefined;

  const root = await materializePayload({
    ...options,
    afterReady: async (directory) => {
      lease = await createRuntimeLeaseLocked({ ...options, ...input });
      await options.afterReady?.(directory);
    },
  });

  return { root, lease: lease! };
}

/**
 * Добавление owner завершено на диске до IPC ACK и до снятия coordinator owner.
 * Worker добавляется тем же API: живой launcher не исчезает в промежутке передачи.
 */
export async function addRuntimeLeaseOwner(
  input: LeaseLocation & { ownerPid?: number },
): Promise<RuntimeLease> {
  return withPackageLock(input.cacheDir, input.packageId, async () => {
    const lease = await readLease(input);
    const owner = await readProcessOwner(input.ownerPid ?? process.pid);

    if (!lease.owners.some((item) => sameOwner(item, owner))) {
      lease.owners.push(owner);
    }

    await writeRuntimeJson(leaseFile(input), lease);

    return lease;
  });
}

/**
 * Adoption подтверждает исходную prepare lease и сохраняет coordinator до ACK.
 * Повтор launcher с тем же token допустим; foreign/malformed запись не исправляется.
 */
export async function adoptPreparation(input: LeaseLocation & { ownerPid?: number }): Promise<RuntimeLease> {
  return withPackageLock(input.cacheDir, input.packageId, async () => {
    const lease = await readLease(input);
    const owner = await readProcessOwner(input.ownerPid ?? process.pid);

    if (lease.kind !== 'prepare' && !lease.owners.some((item) => sameOwner(item, owner))) {
      throw runtimeError('server_lease_owner_mismatch');
    }

    if (!lease.owners.some((item) => sameOwner(item, owner))) {
      lease.owners.push(owner);
    }

    lease.kind = 'server';
    await writeRuntimeJson(leaseFile(input), lease);

    return lease;
  });
}

interface ReleasedRuntimeLease {
  format: 1;
  token: string;
  packageId: string;
  owners: RuntimeOwner[];
}

/**
 * Квитанция release доказывает прежнее владение после ACK либо удаления самой lease.
 * Она лежит вне leases и не удерживает поколение; чужой случайный token не получает success.
 */
async function readReleasedLease(input: LeaseLocation): Promise<ReleasedRuntimeLease | null> {
  leaseFile(input);

  const file = path.join(input.cacheDir, 'state/released-leases', input.packageId, `${input.token}.json`);

  try {
    const receipt = await readRuntimeJson(file) as ReleasedRuntimeLease;

    if (!receipt || Object.keys(receipt).sort().join() !== 'format,owners,packageId,token'
      || receipt.format !== 1 || receipt.token !== input.token || receipt.packageId !== input.packageId
      || !Array.isArray(receipt.owners) || receipt.owners.length === 0
      || !receipt.owners.every((owner) => validOwner(owner)
        && Object.keys(owner).sort().join() === 'pid,starttime')) {
      throw runtimeError('server_lease_invalid');
    }

    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

/**
 * Cleanup снимает только полную записанную identity и сохраняет всех остальных owners.
 * Durable квитанция делает повтор собственного release идемпотентным без разрешения чужому token.
 */
export async function releaseRuntimeLeaseOwner(
  input: LeaseLocation & { owner: RuntimeOwner },
): Promise<void> {
  if (!validOwner(input.owner)) {
    throw runtimeError('server_lease_owner_mismatch');
  }

  await withPackageLock(input.cacheDir, input.packageId, async () => {
    const lease = await readLease(input).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return null;
    });
    const receipt = await readReleasedLease(input);

    if (!lease || !lease.owners.some((owner) => sameOwner(owner, input.owner))) {
      if (receipt?.owners.some((owner) => sameOwner(owner, input.owner))) {
        return;
      }

      throw runtimeError('server_lease_owner_mismatch');
    }

    const released: ReleasedRuntimeLease = receipt ?? {
      format: 1,
      token: input.token,
      packageId: input.packageId,
      owners: [],
    };

    if (!released.owners.some((owner) => sameOwner(owner, input.owner))) {
      released.owners.push(input.owner);
    }

    await writeRuntimeJson(path.join(input.cacheDir, 'state/released-leases',
      input.packageId, `${input.token}.json`), released);

    lease.owners = lease.owners.filter((owner) => !sameOwner(owner, input.owner));

    if (lease.owners.length > 0) {
      await writeRuntimeJson(leaseFile(input), lease);
    } else {
      await fs.unlink(leaseFile(input));
      await syncRuntimeDirectory(path.dirname(leaseFile(input)));
    }
  });
}

/**
 * Проверка для GC не меняет leases и допускает вызов внутри package lock.
 * Любой живой owner удерживает поколение; ошибки metadata/proc означают unknown keep.
 */
export async function inspectRuntimeLeases(input: {
  cacheDir: string;
  packageId: string;
  probe?: ProcessProbe;
})
  : Promise<{ state: 'protected' | 'unprotected' | 'unknown'; leases: RuntimeLease[] }> {
  const leases: RuntimeLease[] = [];
  let unknown = false;

  try {
    const directory = path.join(input.cacheDir, 'leases', input.packageId);

    await privateRuntimeDirectory(directory, false);

    for (const name of await fs.readdir(directory)) {
      try {
        const lease = await readLease({ ...input, token: name.replace(/\.json$/u, '') });

        leases.push(lease);

        for (const owner of lease.owners) {
          const state = await runtimeOwnerState(owner, input.probe);

          if (state === 'alive') {
            return { state: 'protected', leases };
          }

          unknown ||= state === 'unknown';
        }
      } catch {
        unknown = true;
      }
    }
  } catch (error) {
    unknown ||= (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }

  return { state: unknown ? 'unknown' : 'unprotected', leases };
}
