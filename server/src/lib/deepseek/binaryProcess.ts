import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

export interface BinaryProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface OwnedDeepSeekBinary {
  child: ChildProcess;
  closed: Promise<BinaryProcessExit>;
  stop(): Promise<void>;
}

function cleanupFailure(): Error & { code: string } {
  return Object.assign(new Error('Не подтверждено штатное завершение DeepSeek: cleanup'), {
    code: 'deepseek_binary_cleanup',
  });
}

/**
 * PGID известен только из собственного detached spawn и не принимается от callers.
 * ESRCH доказывает отсутствие группы; отказ доступа не превращается в успешный cleanup.
 */
function signalGroup(pgid: number | undefined, signal: NodeJS.Signals | 0): boolean {
  if (!pgid || !Number.isSafeInteger(pgid) || pgid <= 1) {
    return false;
  }

  try {
    process.kill(-pgid, signal);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }

    throw error;
  }
}

/**
 * Владелец создаёт отдельную process group только для своего запуска бинарника.
 * Stop подтверждает фактический выход и не выдаёт эскалацию за успешный cleanup.
 */
export function spawnDeepSeekBinary(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
  spawnProcess: typeof spawn = spawn,
): OwnedDeepSeekBinary {
  const child = spawnProcess(command, [...args], { ...options, detached: true });
  const pgid = child.pid;
  let outcome: BinaryProcessExit | undefined;
  let failedSpawn = false;
  let stopping: Promise<void> | undefined;
  const closed = new Promise<BinaryProcessExit>((resolve) => {
    child.once('error', () => {
      failedSpawn = true;
    });
    child.once('close', (code, signal) => {
      outcome = { code, signal };
      resolve(outcome);
    });
  });

  /**
   * Ожидание включает закрытие stdio и отсутствие всей собственной группы.
   * Один бюджет относится ко всему ожиданию, а не отдельно к каждому потомку.
   */
  async function waitForGone(milliseconds: number): Promise<boolean> {
    const deadline = performance.now() + milliseconds;

    do {
      if (outcome && !signalGroup(pgid, 0)) {
        return true;
      }

      await pause(20);
    } while (performance.now() < deadline);

    return Boolean(outcome) && !signalGroup(pgid, 0);
  }

  /**
   * Graceful TERM адресован launcher, который владеет forwarding и disposal worker.
   * По истечении 6 с своя группа получает KILL; ещё 2 с ждём выход и честно отказываем.
   */
  async function stopProcess(signalLauncher: boolean): Promise<void> {
    if (signalLauncher && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }

    if (!await waitForGone(6000)) {
      signalGroup(pgid, 'SIGKILL');
      await waitForGone(2000);

      throw cleanupFailure();
    }

    const code = outcome?.code;

    if (failedSpawn || typeof code === 'number' && ![0, 130].includes(code)) {
      throw cleanupFailure();
    }
  }

  /**
   * Повторный stop получает тот же исход и не сдвигает deadline эскалации.
   * PGID захвачен до возврата child наружу и не читается из изменяемого child.pid.
   */
  function ensureStopped(signalLauncher: boolean): Promise<void> {
    stopping ??= stopProcess(signalLauncher);

    return stopping;
  }

  child.once('exit', () => {
    // Сначала оставляем worker время на IPC disconnect и штатный disposal.
    // Фоновый отказ сохраняется в том же promise и будет виден последующему stop.
    void ensureStopped(false).catch(() => {});
  });

  return {
    child,
    closed,
    stop: () => ensureStopped(true),
  };
}
