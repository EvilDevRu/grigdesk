import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { delayWithAbort } from '../../../shared/lib/delay.ts';
import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { readDarwinBootId, readDarwinProcessIdentity, type DarwinProcessIdentity }
  from '../../../shared/node/processIdentity.ts';
import { privateRuntimeDirectory, RUNTIME_TOKEN, syncRuntimeDirectory, writeRuntimeJson }
  from '../binary/leases.ts';
import { hasDarwinRunnerMarker, readDarwinRunnerBinding } from './factoryDarwinRunnerState.ts';
import { inspectDarwinSession } from './factoryDarwinSessions.ts';

export interface DarwinLaunchRecord {
  format: 1;
  bootId: string;
  task: string;
  launchId: string;
  attempt: string | null;
  dispatch: string | null;
  owner: DarwinProcessIdentity;
  phase: 'reserved' | 'registered';
  process: DarwinProcessIdentity | null;
}

interface LaunchInput {
  task: string;
  attempt: string | null;
  dispatch: string | null;
  controlRoot: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  logFile: string;
}

type LaunchResult = { state: 'before-spawn' | 'unknown' } | { state: 'launched'; exit: number | null };

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const attemptId = /^a_[a-f0-9]{32}$/u;
const dispatchId = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const identityKeys = 'executable,pgid,pid,ppid,sid,starttime,state,uid';
const launchKeys = 'attempt,bootId,dispatch,format,launchId,owner,phase,process,task';
const launchName = /^t([1-9][0-9]{0,18})\.([a-f0-9-]{36})\.json$/u;
const temporaryName = /^\.write-[a-f0-9-]{36}$/u;
const unreleasedCleanup = new Map<string, readonly DarwinLaunchRecord[]>();

/**
 * Принимает только проверенный формат libproc для UID владельца записи.
 * PID и start token сохраняются раздельно и никогда не округляются.
 */
function isIdentity(identity: unknown): identity is DarwinProcessIdentity {
  const value = identity as Partial<DarwinProcessIdentity> | null;

  return Boolean(value && Object.keys(value).sort().join(',') === identityKeys
    && value.uid === process.getuid?.()
    && [value.pid, value.ppid, value.pgid, value.sid].every((id) =>
      typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
    && typeof value.starttime === 'string' && /^\d{7,26}$/u.test(value.starttime)
    && typeof value.executable === 'string' && path.isAbsolute(value.executable)
    && (value.state === 'R' || value.state === 'T'));
}

/**
 * Запись связывается с именем своего task/launch, неизвестная схема удерживает допуск.
 * На чтении boot UUID и версия обязательны для обеих фаз.
 */
function decodeLaunchRecord(value: unknown, task: string, name: string): DarwinLaunchRecord {
  const record = value as Partial<DarwinLaunchRecord> | null;

  if (!record || Object.keys(record).sort().join(',') !== launchKeys
    || record.format !== 1 || record.task !== task || typeof record.launchId !== 'string'
    || !RUNTIME_TOKEN.test(record.launchId) || name !== `t${task}.${record.launchId}.json`
    || typeof record.bootId !== 'string' || !uuid.test(record.bootId) || !isIdentity(record.owner)
    || record.attempt !== null && (typeof record.attempt !== 'string' || !attemptId.test(record.attempt))
    || record.dispatch !== null && (typeof record.dispatch !== 'string' || !dispatchId.test(record.dispatch))
    || record.phase !== 'reserved' && record.phase !== 'registered') {
    throw new Error('factory_launch_record_invalid');
  }

  const wrapper = record.process;

  if (record.phase === 'reserved' ? wrapper !== null : !isIdentity(wrapper)
    || wrapper.pid !== wrapper.pgid || wrapper.pid !== wrapper.sid || wrapper.ppid !== record.owner.pid) {
    throw new Error('factory_launch_record_invalid');
  }

  return record as DarwinLaunchRecord;
}

/**
 * Читает запись через один дескриптор. Имя и inode повторно сверяются после чтения.
 * Размер соответствует небольшому закрытому формату, ссылки и специальные файлы запрещены.
 */
async function readLaunchRecord(file: string, task: string): Promise<DarwinLaunchRecord> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const before = await handle.stat({ bigint: true });

    if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || before.nlink !== 1n
      || (before.mode & 0o7777n) !== 0o600n || before.size > 8192n) {
      throw new Error('factory_launch_record_invalid');
    }

    const content = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(content, 0, content.length, 0);
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(file, { bigint: true });

    if (BigInt(bytesRead) !== before.size || ![after, named].every((stat) =>
      stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size
      && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs)) {
      throw new Error('factory_launch_record_conflict');
    }

    return decodeLaunchRecord(JSON.parse(content.subarray(0, bytesRead).toString('utf8')),
      task, path.basename(file));
  } finally {
    await handle.close();
  }
}

/**
 * Перечисляет записи даже без .pipeline. Глобальное чтение требует неподвижного
 * каталога, а под task lock посторонние записи не мешают проверять отдельный ID.
 */
export async function readDarwinLaunchRecords(controlRoot: string,
  task?: string): Promise<DarwinLaunchRecord[]> {
  const directory = path.join(controlRoot, 'launch-processes');

  await privateRuntimeDirectory(directory, false);

  const before = await fs.lstat(directory, { bigint: true });
  const names = (await fs.readdir(directory)).sort();
  const records: DarwinLaunchRecord[] = [];

  for (const name of names) {
    if (task && !name.startsWith(`t${task}.`)) {
      continue;
    }

    const recordTask = launchName.exec(name)?.[1];

    if (!recordTask) {
      if (temporaryName.test(name)) {
        throw new Error('factory_launch_record_pending');
      }

      throw new Error('factory_launch_record_invalid');
    }

    records.push(await readLaunchRecord(path.join(directory, name), recordTask));
  }

  const after = await fs.lstat(directory, { bigint: true });

  if (before.dev !== after.dev || before.ino !== after.ino
    || !task && (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)) {
    throw new Error('factory_launch_record_conflict');
  }

  return records;
}

/**
 * Запись удаляется только после повторного чтения своих точных байтов.
 * Синхронизация parent входит в доказательство для освобождения резервации.
 */
async function retireUnreleasedLaunch(
  file: string, authorized: readonly DarwinLaunchRecord[], absentAllowed = false,
): Promise<void> {
  const directory = path.dirname(file);

  await privateRuntimeDirectory(directory, false);

  const current = await readLaunchRecord(file, authorized[0]!.task).catch((error: NodeJS.ErrnoException) => {
    if (absentAllowed && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  if (current) {
    const encoded = canonicalJson(current);

    if (!authorized.some((record) => canonicalJson(record) === encoded)) {
      throw new Error('factory_launch_record_conflict');
    }

    await fs.unlink(file);
  }

  await syncRuntimeDirectory(directory);
}

/**
 * До permit смерть сервера исключает engine exec. После permit проверяем
 * закрытие точной SID и отдельно отсутствие связанных runner bindings.
 */
async function canRetireLaunch(record: DarwinLaunchRecord,
  bootId: string, control: string): Promise<boolean> {
  if (record.bootId !== bootId) {
    return true;
  }

  if (record.phase === 'registered') {
    if (!record.process || (await inspectDarwinSession(record.process)).state !== 'dead') {
      return false;
    }

    try {
      return !await hasDarwinRunnerMarker(control, record.task, 'pending')
        && !await hasDarwinRunnerMarker(control, record.task, 'scope')
        && await readDarwinRunnerBinding(control, record.task) === null;
    } catch {
      return false;
    }
  }

  const owner = await readDarwinProcessIdentity(record.owner.pid);

  return owner.state === 'dead'
    || owner.state === 'alive' && owner.identity.starttime !== record.owner.starttime;
}

/**
 * Отдельная проверка очереди после рестарта сервера и до появления .pipeline.
 * Ошибки чтения оставляются вызывающему как неизвестная граница запуска.
 */
export async function hasPendingDarwinLaunch(controlRoot: string, task: string): Promise<boolean> {
  const records = await readDarwinLaunchRecords(controlRoot, task);

  if (records.length === 0) {
    return false;
  }

  const bootId = await readDarwinBootId();

  for (const record of records) {
    if (!await canRetireLaunch(record, bootId, controlRoot)) {
      return true;
    }
  }

  return false;
}

/**
 * Повторяет только документированный откат текущего процесса под тем же task lock.
 * Возвращает true после синхронизации хотя бы одного подтверждённого отката.
 */
export async function retryUnreleasedDarwinLaunch(controlRoot: string, task: string): Promise<boolean> {
  const directory = path.join(controlRoot, 'launch-processes');
  let retired = false;

  for (const [file, records] of unreleasedCleanup) {
    if (path.dirname(file) === directory && records[0]!.task === task) {
      await retireUnreleasedLaunch(file, records, true);
      unreleasedCleanup.delete(file);
      retired = true;
    }
  }

  return retired;
}

/**
 * Сверяет старые квитанции под task lock и оставляет их при любом остаточном
 * процессе. До нового spawn синхронизирует удаление точно закрытой записи.
 */
async function settlePreviousLaunches(controlRoot: string, task: string, bootId: string): Promise<boolean> {
  const directory = path.join(controlRoot, 'launch-processes');

  await retryUnreleasedDarwinLaunch(controlRoot, task);

  for (const record of await readDarwinLaunchRecords(controlRoot, task)) {
    const file = path.join(directory, `t${task}.${record.launchId}.json`);

    if (!await canRetireLaunch(record, bootId, controlRoot)) {
      return false;
    }

    await retireUnreleasedLaunch(file, [record]);
  }

  return true;
}

/**
 * Ожидание exit ограничено одним сроком, освобождаем свой таймер при обоих исходах.
 * Истечение срока означает отсутствие доказательства выхода, а не exit 0.
 */
async function waitForExit(exit: Promise<number>, timeout: number): Promise<number | null> {
  const controller = new AbortController();

  try {
    return await Promise.race([
      exit,
      delayWithAbort(timeout, controller.signal).then(() => null, () => null),
    ]);
  } finally {
    controller.abort();
  }
}

/**
 * Связывает session leader с живым child handle сервера, пока permit ещё закрыт.
 * Проверка сессии запрещает принять процесс до выполнения wrapper setsid.
 */
async function readHeldIdentity(
  pid: number | undefined, exited: () => boolean,
): Promise<DarwinProcessIdentity> {
  const deadline = performance.now() + 3000;

  while (pid && !exited() && performance.now() < deadline) {
    const probe = await readDarwinProcessIdentity(pid);

    if (probe.state === 'alive' && probe.identity.ppid === process.pid
      && probe.identity.pgid === pid && probe.identity.sid === pid) {
      return probe.identity;
    }

    await delayWithAbort(40);
  }

  throw new Error('factory_launch_owner_unknown');
}

/**
 * Detached engine получает разрешение только после durable записи своей новой сессии.
 * До permit возможен откат с выходом wrapper и подтверждённым удалением только своей записи.
 */
export async function spawnDarwinRouteProcess(input: LaunchInput,
  writeRecord = writeRuntimeJson): Promise<LaunchResult> {
  const setsid = input.env.FACTORY_DARWIN_SETSID ?? '';

  if (!/^[1-9][0-9]{0,18}$/u.test(input.task) || !path.isAbsolute(setsid) || !path.isAbsolute(input.command)
    || input.attempt !== null && !attemptId.test(input.attempt)
    || input.dispatch !== null && !dispatchId.test(input.dispatch)) {
    return { state: 'before-spawn' };
  }

  const directory = path.join(input.controlRoot, 'launch-processes');
  const prefix = `t${input.task}.`;
  const owner = await readDarwinProcessIdentity(process.pid);
  const bootId = await readDarwinBootId();

  if (owner.state !== 'alive') {
    return { state: 'unknown' };
  }

  await privateRuntimeDirectory(directory);

  if (!await settlePreviousLaunches(input.controlRoot, input.task, bootId)) {
    return { state: 'unknown' };
  }

  const launchId = randomUUID();
  const file = path.join(directory, `${prefix}${launchId}.json`);
  const reserved: DarwinLaunchRecord = {
    format: 1,
    bootId,
    task: input.task,
    launchId,
    attempt: input.attempt,
    dispatch: input.dispatch,
    owner: owner.identity,
    phase: 'reserved',
    process: null,
  };

  const records = [reserved];
  let closed: Promise<number> | undefined;
  let releaseAttempted = false;
  let child: ReturnType<typeof spawn> | undefined;
  let permit: NodeJS.WritableStream | undefined;

  try {
    await writeRecord(file, reserved);

    const log = await fs.open(input.logFile, 'a');

    try {
      child = spawn(setsid, ['--permit-fd', '3', '--', input.command, ...input.args], {
        detached: false,
        env: {
          ...input.env,
          FACTORY_DARWIN_LAUNCH_ID: launchId,
          FACTORY_DARWIN_LAUNCH_BOOT_ID: bootId,
        },
        shell: false,
        stdio: ['ignore', log.fd, log.fd, 'pipe'],
      });

      const launched = child;

      closed = new Promise<number>((resolve) => {
        launched.once('error', () => resolve(1));
        launched.once('exit', (code) => resolve(code ?? 1));
      });
      permit = launched.stdio[3] as NodeJS.WritableStream;
      permit.on('error', () => {});
    } finally {
      await log.close();
    }

    if (!child || !closed || !permit) {
      throw new Error('factory_launch_owner_unknown');
    }

    const launched = child;
    const exited = () => launched.exitCode !== null || launched.signalCode !== null;
    const identity = await readHeldIdentity(launched.pid, exited);
    const registered: DarwinLaunchRecord = {
      ...reserved,
      phase: 'registered',
      process: identity,
    };

    records.push(registered);
    await writeRecord(file, registered);

    const current = await readHeldIdentity(launched.pid, exited);

    if (canonicalJson(current) !== canonicalJson(identity)) {
      throw new Error('factory_launch_owner_changed');
    }

    const sent = once(permit, 'finish', { signal: AbortSignal.timeout(1000) });

    releaseAttempted = true;
    permit.end(Buffer.from([1]));
    await sent;

    return { state: 'launched', exit: await waitForExit(closed, 3000) };
  } catch {
    child?.stdio[3]?.destroy();

    if (releaseAttempted || closed && await waitForExit(closed, 3000) === null) {
      return { state: 'unknown' };
    }

    try {
      unreleasedCleanup.set(file, records);
      await retireUnreleasedLaunch(file, records, true);
      unreleasedCleanup.delete(file);

      return { state: 'before-spawn' };
    } catch {
      return { state: 'unknown' };
    }
  } finally {
    child?.unref();
  }
}
