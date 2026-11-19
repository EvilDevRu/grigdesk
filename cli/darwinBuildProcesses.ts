import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Writable } from 'node:stream';

import { delayWithAbort } from '../shared/lib/delay.ts';
import {
  readDarwinProcessCensus, signalDarwinBuildMember, type DarwinProcessCensusEntry,
} from '../shared/node/processIdentity.ts';

type ProcessRow = DarwinProcessCensusEntry;
type ProcessMap = ReadonlyMap<number, ProcessRow>;
type Ownership = 'owned' | 'independent' | 'unknown';
type StopReason = 124 | 130 | 143;
type StageExit = { code: number | null; signal: NodeJS.Signals | null };

const cleanupMs = 10000;
const pollMs = 80;

function sameProcess(row: ProcessRow, reference: ProcessRow | undefined): boolean {
  return reference !== undefined && row.pid === reference.pid && row.starttime === reference.starttime;
}

/**
 * Привязывает новые записи только к живой цепочке родителей либо подтверждённой сессии.
 * PID после повторной выдачи, новый orphan и цепочка с пропуском остаются неизвестными.
 */
export function classifyDarwinBuildProcesses(rows: ProcessRow[], baseline: ProcessMap,
  observed: ProcessMap, root?: ProcessRow): { owned: ProcessRow[]; unknown: ProcessRow[] } {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const currentLeader = root && byPid.get(root.pid);
  const sessionConfirmed = root && (!currentLeader || sameProcess(root, currentLeader))
    && rows.some((row) => row.sid === root.sid && sameProcess(row, observed.get(row.pid))
      && observed.get(row.pid)?.sid === root.sid);
  const memo = new Map<number, Ownership>();

  /**
   * Цепочка не может окончиться на PID 1 или на новом поколении родителя.
   * Потомок доходит до собственного участника или до неизменившегося якоря baseline.
   */
  function ownership(row: ProcessRow): Ownership {
    const known = memo.get(row.pid);

    if (known) {
      return known;
    }

    let owner: Ownership = 'unknown';
    const prior = baseline.get(row.pid);
    const parent = byPid.get(row.ppid);

    if (sameProcess(row, observed.get(row.pid)) || sessionConfirmed && row.sid === root?.sid) {
      owner = 'owned';
    } else if (sameProcess(row, prior)) {
      owner = 'independent';
    } else if (parent && parent.pid !== 1 && BigInt(parent.starttime) < BigInt(row.starttime)) {
      const ancestor = ownership(parent);
      const anchor = baseline.get(parent.pid);

      if (ancestor !== 'independent' || !sameProcess(parent, anchor)
        || parent.ppid === anchor?.ppid && parent.sid === anchor.sid) {
        owner = ancestor;
      }
    }

    memo.set(row.pid, owner);

    return owner;
  }

  return {
    owned: rows.filter((row) => ownership(row) === 'owned'),
    unknown: rows.filter((row) => ownership(row) === 'unknown'),
  };
}

interface DarwinBuildProcessInput {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  setsid: string;
  output: 'pipe' | number;
  capture?(child: ChildProcess, signal: AbortSignal): Promise<void>;
  finishStartup?(started: boolean): Promise<void>;
  contextFd3?: string;
  onStopReason?(reason: StopReason): void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface DarwinBuildProcessResult extends StageExit {
  cleanupConfirmed: boolean;
  reason: StopReason | null;
  error?: unknown;
}

/**
 * Передаёт единственный байт после доказательства session leader.
 * Ошибка канала завершает барьер без запуска пользовательской команды.
 */
async function grantPermit(pipe: Writable, signal: AbortSignal): Promise<void> {
  const sent = once(pipe, 'finish', { signal });

  pipe.end(Buffer.from([1]));
  await sent;
}

/**
 * Один срок включает TERM, KILL и два полных согласованных снимка после закрытия стадии.
 * Любая неизвестная запись запрещает подтверждение очистки и остаётся без сигнала.
 */
async function finishDarwinBuildProcesses(input: {
  baseline: ProcessMap;
  observed: Map<number, ProcessRow>;
  root?: ProcessRow;
  childExited(): boolean;
  killAfter: number | null;
  signal: AbortSignal;
}): Promise<boolean> {
  const signalled = new Set<string>();
  let previous = '';

  while (!input.signal.aborted) {
    const rows = await readDarwinProcessCensus(input.signal).catch(() => null);

    if (!rows) {
      previous = '';
    } else {
      const { owned, unknown } = classifyDarwinBuildProcesses(
        rows, input.baseline, input.observed, input.root,
      );

      for (const row of owned) {
        input.observed.set(row.pid, row);

        if (input.killAfter === null) {
          continue;
        }

        const name = performance.now() >= input.killAfter ? 'KILL' : 'TERM';
        const key = `${name}:${row.pid}:${row.starttime}:${row.sid}:${row.pgid}`;

        if (!signalled.has(key) && !input.signal.aborted) {
          await signalDarwinBuildMember(row, name, input.signal).then(() => signalled.add(key), () => {});
        }
      }

      if (input.childExited() && owned.length === 0 && unknown.length === 0) {
        const current = JSON.stringify(rows.toSorted((a, b) => a.pid - b.pid));

        if (current === previous) {
          return true;
        }

        previous = current;
      } else {
        previous = '';
      }
    }

    await delayWithAbort(pollMs, input.signal).catch(() => {});
  }

  return false;
}

/**
 * Выпускает команду только после снимка UID и проверки новой сессии.
 * Первый exit, timeout или отмена начинают терминальный обход независимо от pipe close.
 */
export async function runDarwinBuildProcess(
  input: DarwinBuildProcessInput,
): Promise<DarwinBuildProcessResult> {
  const stopped = new AbortController();
  const captureStop = new AbortController();
  const observed = new Map<number, ProcessRow>();
  let root: ProcessRow | undefined;
  let exit: StageExit | undefined;
  let reason: StopReason | null = null;
  let setupError: unknown;
  let child: ChildProcess | undefined;
  let permit: Writable | undefined;
  let capture = Promise.resolve(true);
  let terminalAt = 0;

  /**
   * Фиксирует первый момент остановки для общего бюджета очистки и вывода.
   * Готовый exit из обработчика ребёнка остаётся доступен при внешней отмене.
   */
  function stop(): void {
    if (!stopped.signal.aborted) {
      terminalAt = performance.now();
      stopped.abort();
    }
  }

  /**
   * Таймаут и входной сигнал фиксируются сразу, в том числе во время cleanup.
   * Вызывающий сохраняет ту же причину для итоговой квитанции.
   */
  function stopWithReason(value: StopReason): void {
    if (reason === null) {
      reason = value;
      input.onStopReason?.(value);
    }

    stop();
  }

  const cancel = () => {
    const value = input.signal?.reason;

    stopWithReason(value === 130 || value?.code === 130 ? 130 : 143);
  };
  const timeout = input.timeoutMs === undefined ? undefined : setTimeout(() => stopWithReason(124),
    input.timeoutMs);

  input.signal?.addEventListener('abort', cancel, { once: true });

  if (input.signal?.aborted) {
    cancel();
  }

  try {
    let baseline: Map<number, ProcessRow> | undefined;

    try {
      const rows = await readDarwinProcessCensus(stopped.signal);

      baseline = new Map(rows.map((row) => [row.pid, row]));
      stopped.signal.throwIfAborted();

      const context = input.contextFd3;
      const permitSlot = context === undefined ? 3 : 4;
      const streams: ('ignore' | 'pipe' | number)[] = ['ignore', input.output, input.output, 'pipe'];

      if (context !== undefined) {
        streams.push('pipe');
      }

      child = spawn(input.setsid, ['--permit-fd', String(permitSlot), '--', input.file, ...input.args], {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: streams,
      });

      const started = child;

      permit = started.stdio[permitSlot] as Writable;
      permit.on('error', (error) => {
        setupError = error;
        stop();
      });
      started.once('error', (error) => {
        setupError = error;
        exit = { code: null, signal: null };
        clearTimeout(timeout);
        stop();
      });
      started.once('exit', (code, signal) => {
        exit = { code, signal };
        clearTimeout(timeout);
        stop();
      });
      capture = Promise.resolve().then(() => input.capture?.(started, captureStop.signal)).then(
        () => true, () => {
          stop();

          return false;
        },
      );

      const ready = AbortSignal.any([stopped.signal, AbortSignal.timeout(5000)]);

      while (!root && !ready.aborted) {
        const snapshot = await readDarwinProcessCensus(ready).catch(() => []);

        root = snapshot.find((row) => row.pid === started.pid && row.ppid === process.pid
          && row.sid === row.pid && row.pgid === row.pid);

        if (!root) {
          await delayWithAbort(pollMs, ready).catch(() => {});
        }
      }

      ready.throwIfAborted();
      observed.set(root!.pid, root!);
      await grantPermit(permit, stopped.signal);

      if (context !== undefined) {
        const channel = started.stdio[3] as Writable;

        channel.on('error', () => channel.destroy());
        channel.end(context);
      }

      while (!stopped.signal.aborted) {
        const snapshot = await readDarwinProcessCensus(stopped.signal).catch(() => []);
        const { owned } = classifyDarwinBuildProcesses(snapshot, baseline, observed, root);

        for (const row of owned) {
          observed.set(row.pid, row);
        }

        await delayWithAbort(pollMs, stopped.signal).catch(() => {});
      }
    } catch (error) {
      if (!stopped.signal.aborted) {
        setupError = error;
      }

      stop();
    } finally {
      permit?.destroy();
      clearTimeout(timeout);
    }

    if (!child?.pid || !baseline) {
      return {
        code: null,
        signal: null,
        reason,
        cleanupConfirmed: baseline !== undefined || reason !== null,
        error: setupError,
      };
    }

    if (input.finishStartup) {
      // До проверки launch lease принадлежит только непосредственный ctl.
      // Сервис и его потомки получают сигналы исключительно через checked cleanup.
      if (root && !exit) {
        await signalDarwinBuildMember(root, 'TERM', AbortSignal.timeout(2000)).catch(() => {});
      }

      try {
        const reported = exit?.code === 0 && !setupError && await Promise.race([
          capture,
          delayWithAbort(2000, AbortSignal.timeout(2000)).then(() => false, () => false),
        ]);

        await input.finishStartup(reported);
      } catch (error) {
        return {
          code: exit?.code ?? null,
          signal: exit?.signal ?? null,
          reason,
          cleanupConfirmed: false,
          error,
        };
      }

      terminalAt = performance.now();
    }

    const remaining = Math.max(1, Math.ceil(terminalAt + cleanupMs - performance.now()));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), remaining);

    try {
      const cleanup = await finishDarwinBuildProcesses({
        baseline,
        observed,
        root,
        childExited: () => exit !== undefined,
        killAfter: input.finishStartup ? null : terminalAt + cleanupMs / 2,
        signal: deadline.signal,
      });
      const captureEnded = await Promise.race([
        capture, delayWithAbort(remaining, deadline.signal).then(() => false, () => false),
      ]);

      return {
        code: setupError ? null : exit?.code ?? null,
        signal: exit?.signal ?? null,
        cleanupConfirmed: cleanup && captureEnded,
        reason,
        error: setupError,
      };
    } finally {
      clearTimeout(timer);
      deadline.abort();
    }
  } finally {
    input.signal?.removeEventListener('abort', cancel);
    captureStop.abort();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    child?.stdio[3]?.destroy();
    child?.unref();
  }
}
