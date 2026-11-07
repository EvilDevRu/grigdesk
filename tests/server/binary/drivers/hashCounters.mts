import path from 'node:path';

/**
 * Strace разрывает перекрывающиеся syscalls между unfinished и resumed записями одного TID.
 * Сборка пары сохраняет аргументы openat; незавершённый open остаётся консервативным чтением.
 */
function syscalls(trace: string) {
  const pending = new Map<string, string>();
  const calls: { pid: string; call: string }[] = [];

  for (const line of trace.split('\n')) {
    const match = line.match(/^(\d+)\s+(.*)$/u);

    if (!match) {
      continue;
    }

    const pid = match[1]!;
    let call = match[2]!;

    if (call.endsWith('<unfinished ...>')) {
      pending.set(pid, call.slice(0, -'<unfinished ...>'.length));
      continue;
    }

    if (call.startsWith('<... ')) {
      const prefix = pending.get(pid);

      if (!prefix) {
        throw new Error(`Trace потерял начало syscall потока ${pid}`);
      }

      pending.delete(pid);
      call = prefix + call.replace(/^<\.\.\. \w+ resumed>/u, '');
    }

    calls.push({ pid, call });
  }

  for (const [pid, call] of pending) {
    calls.push({ pid, call });
  }

  return calls;
}

/**
 * Счётчик учитывает все libuv threads launcher-а и исключает ordinary worker process.
 * Нулевое число чтений payload должно быть доказано полным trace, включая resumed syscalls.
 */
export function launcherPayloadReads(trace: string, binary: string, root: string) {
  const calls = syscalls(trace);
  const threadParents = new Map<string, string>();
  const launchers = new Set<string>();
  const executed = new Set<string>();

  for (const { pid, call } of calls) {
    const clone = call.match(/^clone(?:3)?\(.*\)\s+=\s+(\d+)$/u);

    if (clone && call.includes('CLONE_THREAD')) {
      threadParents.set(clone[1]!, pid);
    }

    const exec = call.match(/^execve\("([^"\n]+)".*\)\s+=\s+0$/u);

    if (exec) {
      executed.add(pid);

      if (exec[1] === binary) {
        launchers.add(pid);
      }
    }
  }

  /**
   * CLONE_THREAD наследует thread group, fork/vfork создаёт самостоятельный процесс worker-а.
   * Два прохода учитывают даже open, записанный раньше возврата clone родительскому TID.
   */
  const group = (pid: string): string => {
    const seen = new Set<string>();

    while (threadParents.has(pid)) {
      if (seen.has(pid)) {
        throw new Error('Trace содержит цикл CLONE_THREAD');
      }

      seen.add(pid);
      pid = threadParents.get(pid)!;
    }

    return pid;
  };
  const staging = path.join(path.dirname(root), `.${path.basename(root)}.staging-`);
  const opened: string[] = [];

  for (const { pid, call } of calls) {
    const open = call.match(/^openat\([^,]+, "([^"\n]+)", (.*)$/u);

    if (!open || !(open[1]!.startsWith(root + '/') || open[1]!.startsWith(staging))
      || open[1]!.endsWith('/.ready.json') || !open[2]!.includes('O_RDONLY')
      || open[2]!.includes('O_DIRECTORY') || /\)\s+=\s+-1\b/u.test(call)) {
      continue;
    }

    const owner = group(pid);

    if (!executed.has(owner)) {
      throw new Error(`Trace не установил executable для payload-reading потока ${pid}`);
    }

    if (launchers.has(owner)) {
      opened.push(open[1]!);
    }
  }

  return {
    launcherPids: [...launchers],
    threadIds: [...new Set([...launchers, ...threadParents.keys()])]
      .filter((pid) => launchers.has(group(pid))),
    opened,
  };
}
