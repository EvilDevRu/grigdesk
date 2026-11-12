import { randomUUID, createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { isRecord } from '../../../../shared/lib/objects.ts';
import {
  acquireDirectoryLock, processOwnerState, type DirectoryLockOwner,
} from '../../../../shared/node/directoryLock.ts';
import { writeDurableFile } from '../durableFile.ts';
import { InstallEnvironmentError } from './npmEnvironment.ts';

export interface CliLeaseInput {
  directory: string;
  providerId: string;
  resourceKey: string;
  mode: 'reader' | 'exclusive';
  sessionId?: number;
  jobId?: string;
}

export interface CliLeaseHolder {
  ownerPid: number;
  childPid: number | null;
  sessionId: number | null;
  chatKey: string | null;
  ageSeconds: number;
}

interface LeaseRecord {
  resourceKey: string;
  owner: DirectoryLockOwner;
  mode: 'reader' | 'exclusive';
  phase: 'acquiring' | 'active' | 'exclusive';
  child: DirectoryLockOwner | null;
  sessionId: number | null;
  jobId: string | null;
}

export interface CliLease {
  token: string;
  attachChild(pid: number): Promise<void>;
  attachSession(sessionId: number): Promise<void>;
  release(): Promise<void>;
}

const validOwner = (value: unknown): value is DirectoryLockOwner => isRecord(value)
  && Number.isSafeInteger(value.pid) && Number(value.pid) > 0
  && typeof value.starttime === 'string' && /^\d+$/u.test(value.starttime)
  && typeof value.token === 'string' && value.token.length > 0 && value.token.length <= 128;
const fieldsOf = (stat: string): string[] => stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);

/**
 * PID дополняется временем старта, иначе переиспользованный номер мог бы снять чужой reader.
 * Ошибка чтения владельца запрещает допуск, а не превращается в пустую блокировку.
 */
async function identity(pid: number, token: string): Promise<DirectoryLockOwner> {
  const fields = fieldsOf(await fs.readFile(`/proc/${pid}/stat`, 'utf8'));
  const starttime = fields[19];

  if (!starttime || !/^\d+$/u.test(starttime)) {
    throw new Error('Не удалось установить владельца CLI lease');
  }

  return {
    pid,
    starttime,
    token,
  };
}

/**
 * Сессия helper-а удерживает reader после смерти самого helper-а, если остались потомки.
 * Недоступная таблица процессов не доказывает завершение; TTL для reclaim не используется.
 */
async function sessionAlive(record: LeaseRecord): Promise<boolean> {
  if (record.sessionId === null) {
    return false;
  }

  const entries = await fs.readdir('/proc');

  for (const name of entries.filter((entry) => /^\d+$/u.test(entry))) {
    if (Number(name) === record.owner.pid) {
      continue;
    }

    try {
      const fields = fieldsOf(await fs.readFile(`/proc/${name}/stat`, 'utf8'));

      if (fields[0] !== 'Z' && Number(fields[3]) === record.sessionId) {
        return true;
      }
    } catch (error) {
      // Посторонний процесс может исчезнуть между readdir и чтением stat.
      // ENOENT и ESRCH доказывают его выход; другие ошибки сохраняют запрет снятия reader.
      const code = (error as NodeJS.ErrnoException).code;

      if (code !== 'ENOENT' && code !== 'ESRCH') {
        return true;
      }
    }
  }

  return false;
}

/**
 * Приватный журнал читается ограниченно и без symlink; повреждение закрывает обслуживание.
 * Внешнее API не принимает records, PID, ключ ресурса или обход блокировки от клиента.
 */
async function readRecords(file: string): Promise<LeaseRecord[]> {
  let handle;

  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  try {
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    if (bytesRead === buffer.length) {
      throw new Error('Журнал CLI leases слишком большой');
    }

    const records: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));

    if (!Array.isArray(records) || records.length > 512 || !records.every((record) =>
      isRecord(record) && typeof record.resourceKey === 'string' && /^[0-9a-f]{64}$/u.test(record.resourceKey)
      && validOwner(record.owner) && ['reader', 'exclusive'].includes(String(record.mode))
      && ['acquiring', 'active', 'exclusive'].includes(String(record.phase))
      && (record.child === null || validOwner(record.child))
      && (record.sessionId === null || Number.isSafeInteger(record.sessionId) && Number(record.sessionId) > 0)
      && (record.jobId === null || typeof record.jobId === 'string'))) {
      throw new Error('Повреждён журнал CLI leases');
    }

    return records as LeaseRecord[];
  } finally {
    await handle.close();
  }
}

/**
 * Мёртвый holder не освобождает живого child или неизвестную сессию потомков.
 * Проверка вызывается под коротким mutex перед любым изменением records.
 */
async function retainRecords(records: LeaseRecord[]): Promise<LeaseRecord[]> {
  const retained: LeaseRecord[] = [];

  for (const record of records) {
    if (await processOwnerState(record.owner) !== 'dead'
      || record.child && await processOwnerState(record.child) !== 'dead'
      || await sessionAlive(record)) {
      retained.push(record);
    }
  }

  return retained;
}

/**
 * Reader и exclusive публикуются атомарно под общим mutex провайдера.
 * Writer закрывает новые readers даже при временно исчезнувшем tree и другом discovery-key.
 */
export async function acquireCliLease(input: CliLeaseInput): Promise<CliLease> {
  if (!path.isAbsolute(input.directory) || !/^[a-zA-Z0-9_-]{1,64}$/u.test(input.providerId)
    || !/^[0-9a-f]{64}$/u.test(input.resourceKey)) {
    throw new Error('Неверная цель CLI lease');
  }

  const directory = path.join(input.directory, createHash('sha256').update(input.providerId).digest('hex'));
  const mutexPath = path.join(directory, 'mutex');
  const file = path.join(directory, 'records.json');
  const token = randomUUID();
  const owner = await identity(process.pid, token);

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  const deadline = Date.now() + 2000;
  let pending = false;
  let acquired = false;

  while (!acquired) {
    const lock = await acquireDirectoryLock(mutexPath, { waitMs: 2000 });
    let wait = false;

    try {
      const records = await retainRecords(await readRecords(file));
      const exclusive = records.find((record) => record.mode === 'exclusive'
        && record.owner.token !== token);

      if (exclusive && (input.mode === 'reader' || exclusive.resourceKey === input.resourceKey)) {
        throw new InstallEnvironmentError(
          input.mode === 'reader' ? 'provider_maintenance' : 'provider_in_use',
          input.mode === 'reader' ? 'Исполнитель обслуживается'
            : 'Эта копия исполнителя используется живым процессом');
      }

      const readers = records.filter((record) => record.mode === 'reader'
        && record.resourceKey === input.resourceKey);

      if (input.mode === 'exclusive' && readers.length) {
        if (Date.now() >= deadline) {
          await writeDurableFile(file, JSON.stringify(records
            .filter((record) => record.owner.token !== token)));

          throw new InstallEnvironmentError('provider_in_use',
            'Живой процесс не освободил копию за отведённое ожидание');
        }
        if (!pending) {
          if (records.length >= 512) {
            throw new InstallEnvironmentError('provider_in_use', 'Слишком много процессов исполнителя');
          }

          records.push({
            resourceKey: input.resourceKey,
            owner,
            mode: 'exclusive',
            phase: 'acquiring',
            child: null,
            sessionId: input.sessionId ?? null,
            jobId: input.jobId ?? null,
          });
          await writeDurableFile(file, JSON.stringify(records));
          pending = true;
        }

        wait = true;
      } else {
        if (!pending) {
          if (records.length >= 512) {
            throw new InstallEnvironmentError('provider_in_use', 'Слишком много процессов исполнителя');
          }

          records.push({
            resourceKey: input.resourceKey,
            owner,
            mode: input.mode,
            phase: input.mode === 'reader' ? 'acquiring' : 'exclusive',
            child: null,
            sessionId: input.sessionId ?? null,
            jobId: input.jobId ?? null,
          });
        } else {
          const own = records.find((record) => record.owner.token === token);

          if (!own) {
            throw new Error('CLI writer потерял собственную запись');
          }

          own.phase = 'exclusive';
        }

        await writeDurableFile(file, JSON.stringify(records));
        acquired = true;
      }
    } finally {
      await lock.release();
    }

    if (wait) {
      await sleep(50);
    }
  }

  return {
    token,
    /**
     * Запоминает child под mutex до возможной смерти holder.
     * Повторная привязка не может заменить уже удерживаемый процесс.
     */
    async attachChild(pid) {
      const child = await identity(pid, token);
      const update = await acquireDirectoryLock(mutexPath, { waitMs: 2000 });

      try {
        const records = await readRecords(file);
        const own = records.find((record) => record.owner.token === token);

        if (!own || own.mode !== 'reader' || own.child) {
          throw new Error('CLI reader уже закрыт или привязан');
        }

        own.child = child;
        own.phase = 'active';
        await writeDurableFile(file, JSON.stringify(records));
      } finally {
        await update.release();
      }
    },
    /**
     * Дочерняя сессия позволяет helper-у без своей сессии доказать выход всех потомков.
     * Привязка выполняется один раз и только владельцем записи.
     */
    async attachSession(sessionId) {
      if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        throw new Error('Неверная сессия CLI');
      }

      const update = await acquireDirectoryLock(mutexPath, { waitMs: 2000 });

      try {
        const records = await readRecords(file);
        const own = records.find((record) => record.owner.token === token);

        if (!own || own.mode !== 'reader' || own.sessionId !== null || own.child) {
          throw new Error('CLI reader уже закрыт или привязан');
        }

        own.sessionId = sessionId;
        await writeDurableFile(file, JSON.stringify(records));
      } finally {
        await update.release();
      }
    },
    /**
     * Только свой token может снять запись после доказанного выхода потомков.
     * Живой child сохраняет reader даже при явном release владельца.
     */
    async release() {
      const update = await acquireDirectoryLock(mutexPath, { waitMs: 2000 });

      try {
        const records = await readRecords(file);
        const own = records.find((record) => record.owner.token === token);

        if (!own) {
          return;
        }
        if (own.child && await processOwnerState(own.child) !== 'dead' || await sessionAlive(own)) {
          throw new InstallEnvironmentError('provider_in_use', 'Процессы CLI ещё не завершились');
        }

        await writeDurableFile(file,
          JSON.stringify(records.filter((record) => record.owner.token !== token)));
      } finally {
        await update.release();
      }
    },
  };
}

function leasePaths(input: { directory: string; providerId: string }): {
  directory: string;
  mutexPath: string;
  file: string;
} {
  const directory = path.join(input.directory,
    createHash('sha256').update(input.providerId).digest('hex'));

  return {
    directory,
    mutexPath: path.join(directory, 'mutex'),
    file: path.join(directory, 'records.json'),
  };
}

/**
 * Возраст процесса считается по полю starttime из /proc и общему uptime системы.
 * Недоступный /proc даёт ноль: подтверждение закрывающего окна не должно падать
 * из-за возраста, даже если цифра окажется заниженной.
 */
async function ownerAgeSeconds(owner: DirectoryLockOwner): Promise<number> {
  try {
    const uptime = Number((await fs.readFile('/proc/uptime', 'utf8')).split(/\s+/u)[0]);
    const seconds = uptime - Number(owner.starttime) / 100;

    return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  } catch {
    return 0;
  }
}

/**
 * Живые readers провайдера для подтверждения человека перед обслуживанием копии.
 * Проход выполняется под mutex и заодно вычищает протухшие записи из журнала:
 * до появления этой проверки мёртвый holder мог блокировать exclusive до первого acquire.
 */
export async function inspectCliLeases(input: {
  directory: string;
  providerId: string;
}): Promise<CliLeaseHolder[]> {
  if (!path.isAbsolute(input.directory) || !/^[a-zA-Z0-9_-]{1,64}$/u.test(input.providerId)) {
    throw new Error('Неверная цель CLI lease');
  }

  const { directory, mutexPath, file } = leasePaths(input);

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  const lock = await acquireDirectoryLock(mutexPath, { waitMs: 2000 });

  try {
    const records = await retainRecords(await readRecords(file));

    await writeDurableFile(file, JSON.stringify(records));

    return Promise.all(records.filter((record) => record.mode === 'reader').map(async (record) => ({
      ownerPid: record.owner.pid,
      childPid: record.child?.pid ?? null,
      sessionId: record.sessionId,
      chatKey: record.jobId,
      ageSeconds: await ownerAgeSeconds(record.owner),
    })));
  } finally {
    await lock.release();
  }
}

/**
 * Подтверждённое человеком закрытие живых readers: сигнал получает вся группа
 * владельца записи, включая CLI и его потомков. Свою группу сервер пропускает:
 * его записи не являются живыми сессиями исполнителя. Перед каждым сигналом
 * сверяется starttime, чтобы переиспользованный PID не получил чужой SIGKILL.
 */
export async function terminateCliLeaseHolders(input: {
  directory: string;
  providerId: string;
}): Promise<void> {
  if (!path.isAbsolute(input.directory) || !/^[a-zA-Z0-9_-]{1,64}$/u.test(input.providerId)) {
    throw new Error('Неверная цель CLI lease');
  }

  const { mutexPath, file } = leasePaths(input);

  const lock = await acquireDirectoryLock(mutexPath, { waitMs: 2000 });

  try {
    const records = await retainRecords(await readRecords(file));
    const targets = records.filter((record) => record.mode === 'reader'
      && record.owner.pid !== process.pid);

    await writeDurableFile(file, JSON.stringify(records));
    await Promise.all(targets.map((record) => terminateHolderGroup(record)));
  } finally {
    await lock.release();
  }
}

/**
 * Дожидается выхода и holder, и записанного child: мёртвый holder ещё не означает
 * мёртвый CLI, а живой CLI продлевает запись через сессию своих потомков.
 * Неизвестное состояние процесса держит ожидание до верхней границы и SIGKILL.
 */
async function terminateHolderGroup(record: LeaseRecord): Promise<void> {
  const alive = async () => (await processOwnerState(record.owner)) !== 'dead'
    || (!!record.child && (await processOwnerState(record.child)) !== 'dead');

  await signalHolderProcesses(record, 'SIGTERM');

  const deadline = Date.now() + 5000;

  while (await alive()) {
    if (Date.now() >= deadline) {
      await signalHolderProcesses(record, 'SIGKILL');

      return;
    }

    await sleep(100);
  }
}

/**
 * Сигнал адресуется и группе, и самому процессу: собственная группа CLI покрывает
 * его потомков, а убитый раньше holder не должен оставлять живым записанный child.
 * Свёрка starttime перед каждым сигналом исключает переиспользованный PID.
 */
async function signalHolderProcesses(record: LeaseRecord, signal: NodeJS.Signals): Promise<void> {
  for (const owner of [record.owner, ...(record.child ? [record.child] : [])]) {
    const stat = await fs.readFile(`/proc/${owner.pid}/stat`, 'utf8').catch(() => null);
    const starttime = stat ? fieldsOf(stat)[19] : null;

    if (!starttime || starttime !== owner.starttime) {
      continue;
    }

    for (const pid of [-owner.pid, owner.pid]) {
      try {
        process.kill(pid, signal);
      } catch {
        // Группа или процесс уже завершились: следующая проверка зафиксирует смерть.
      }
    }
  }
}
