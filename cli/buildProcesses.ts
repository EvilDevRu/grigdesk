import { readFile } from 'node:fs/promises';

export interface BuildProcess {
  pid: number;
  starttime: string;
  pgid: number;
}

/**
 * Идентичность PID включает время старта, чтобы повторное использование номера было безопасным.
 * Исчезнувший или уже завершённый процесс не считается живым участником своей группы.
 */
async function identity(pid: number): Promise<BuildProcess | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

    if (fields[0] === 'Z') {
      return null;
    }

    return {
      pid,
      pgid: Number(fields[2]),
      starttime: fields[19]!,
    };
  } catch {
    return null;
  }
}

/**
 * Обход начинается только от собственного ребёнка, включая вложенные setsid-группы.
 * Сохранённые идентичности позволяют довести отмену даже после раннего выхода лидера.
 */
export async function collectBuildProcesses(
  rootPid: number, known: readonly BuildProcess[] = [],
): Promise<BuildProcess[]> {
  const found = new Map(known.map((item) => [item.pid, item]));
  const queue = [rootPid, ...known.map((item) => item.pid)];
  const visited = new Set<number>();

  while (queue.length) {
    const pid = queue.shift()!;

    if (visited.has(pid)) {
      continue;
    }

    visited.add(pid);

    const current = await identity(pid);
    const previous = found.get(pid);

    if (!current || previous && previous.starttime !== current.starttime) {
      continue;
    }

    found.set(pid, current);

    const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '');

    queue.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
  }

  return [...found.values()];
}

/**
 * Перед каждым сигналом проверяется живой принадлежащий нам участник группы.
 * Группа CLI и совпавшие по номеру новые процессы никогда не получают сигнал.
 */
export async function signalBuildProcesses(
  processes: readonly BuildProcess[], signal: NodeJS.Signals,
): Promise<number> {
  const parent = await identity(process.pid);
  const sent = new Set<number>();

  for (const member of processes) {
    const current = await identity(member.pid);

    if (!current || current.starttime !== member.starttime || current.pgid !== member.pgid
      || current.pgid === parent?.pgid || sent.has(current.pgid)) {
      continue;
    }

    try {
      process.kill(-current.pgid, signal);
      sent.add(current.pgid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
    }
  }

  return sent.size;
}
