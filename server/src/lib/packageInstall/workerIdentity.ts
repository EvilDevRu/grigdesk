import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';

export interface ProcessIdentity {
  pid: number;
  pgid: number;
  startTime: string;
  state: string;
}

/**
 * PID без времени старта не доказывает владение процессом после повторного использования.
 * Linux stat разбирается после имени в скобках, которое само может содержать пробелы.
 */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  let raw: string;

  try {
    raw = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'ENOENT' || code === 'ESRCH') {
      return null;
    }

    throw error;
  }

  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/u);

  const startTime = fields[19];
  const state = fields[0];

  if (!startTime || !state || !/^\d+$/u.test(startTime)) {
    throw new Error('Identity процесса не читается');
  }

  return {
    pid,
    pgid: Number(fields[2]),
    startTime,
    state,
  };
}

/**
 * Завершение leader не означает отсутствие writer: потомок может держать тот же PGID.
 * Zombie больше не исполняет код и не держит файловые дескрипторы, поэтому не задерживает слив.
 */
export async function liveGroupMembers(pgid: number): Promise<ProcessIdentity[]> {
  const members: ProcessIdentity[] = [];

  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }

    const current = await readProcessIdentity(Number(entry));

    if (current?.pgid === pgid && current.state !== 'Z' && current.state !== 'X') {
      members.push(current);
    }
  }

  return members;
}

/**
 * Recovery посылает TERM только живому supervisor с совпавшим временем старта.
 * Потерянный supervisor при живой группе даёт блокировку и сохраняет файловые копии.
 */
export async function terminateOwnedWorker(worker: {
  supervisorPid: number;
  supervisorStartTime: string;
  pid: number;
  pgid: number;
  startTime: string;
}): Promise<boolean> {
  const supervisor = await readProcessIdentity(worker.supervisorPid);
  const target = await readProcessIdentity(worker.pid);

  if (supervisor && supervisor.startTime !== worker.supervisorStartTime) {
    return false;
  }

  if (target && (target.startTime !== worker.startTime || target.pgid !== worker.pgid)) {
    return false;
  }

  if (!supervisor || supervisor.state === 'Z' || supervisor.state === 'X') {
    return (await liveGroupMembers(worker.pgid)).length === 0;
  }

  if (supervisor.pgid === worker.pgid) {
    return false;
  }

  process.kill(worker.supervisorPid, 'SIGTERM');

  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const current = await readProcessIdentity(worker.supervisorPid);

    if (current && current.startTime !== worker.supervisorStartTime) {
      return false;
    }

    if ((!current || current.state === 'Z' || current.state === 'X')
      && (await liveGroupMembers(worker.pgid)).length === 0) {
      return true;
    }

    await pause(20);
  }

  return false;
}
