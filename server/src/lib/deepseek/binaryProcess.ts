import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

import { errorMessage } from '../../../../shared/lib/errors.ts';

export interface BinaryProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface BinaryStopDetails {
  exit: BinaryProcessExit | null;
  failedSpawn: boolean;
  escalated: boolean;
  groupGone: boolean | null;
}

export interface OwnedDeepSeekBinary {
  child: ChildProcess;
  closed: Promise<BinaryProcessExit>;
  stop(): Promise<void>;
}

/**
 * Вторичный отказ остановки сохраняет исходную причину и собственные факты раздельно.
 * Код cleanup остаётся снаружи: владельцы обязаны сохранить каталог диагностики запуска.
 */
export function combineDeepSeekCleanupFailure(primary: unknown, cleanup: unknown): unknown {
  if (!cleanup || typeof cleanup !== 'object' || cleanup === primary) {
    return cleanup;
  }

  const failure = cleanup as Error & {
    code?: unknown;
    stopDetails?: unknown;
    stopFailure?: unknown;
  };
  const stopFailure = failure.stopFailure ?? {
    code: failure.code,
    message: errorMessage(failure, 'Не удалось подтвердить остановку исполнителя.'),
    ...(failure.stopDetails ? { details: failure.stopDetails } : {}),
    ...(failure.cause ? { cause: failure.cause } : {}),
  };
  const stopMessage = errorMessage(stopFailure, 'Не удалось подтвердить остановку исполнителя.');

  return Object.assign(failure, {
    stopFailure,
    ...(primary === undefined ? {} : {
      cause: primary,
      message: `${errorMessage(primary, String(primary))}\n\n${stopMessage}`,
    }),
  });
}

/**
 * Отказ содержит факты остановки отдельно от причины завершения самого хода.
 * Исчезнувшая группа не превращает code 75 или эскалацию в штатный выход.
 */
function cleanupFailure(stopDetails: BinaryStopDetails, cause?: unknown): Error & {
  code: string;
  stopDetails: BinaryStopDetails;
} {
  const exit = stopDetails.exit;
  const group = stopDetails.groupGone === null ? 'неизвестно' : stopDetails.groupGone ? 'да' : 'нет';
  const message = 'Не подтверждено штатное завершение DeepSeek: cleanup'
    + ` (код: ${exit?.code ?? 'неизвестен'}, сигнал: ${exit?.signal ?? 'нет'},`
    + ` эскалация: ${stopDetails.escalated ? 'да' : 'нет'}, группа отсутствует: ${group},`
    + ` ошибка запуска: ${stopDetails.failedSpawn ? 'да' : 'нет'})`;

  return Object.assign(new Error(message, { cause }), {
    code: 'deepseek_binary_cleanup',
    stopDetails,
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
  let escalated = false;
  let groupGone: boolean | null = null;
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
      if (outcome) {
        groupGone = !signalGroup(pgid, 0);

        if (groupGone) {
          return true;
        }
      }

      await pause(20);
    } while (performance.now() < deadline);

    groupGone = outcome ? !signalGroup(pgid, 0) : null;

    return groupGone === true;
  }

  /**
   * Graceful TERM адресован launcher, который владеет forwarding и disposal worker.
   * По истечении 6 с своя группа получает KILL; ещё 2 с ждём выход и честно отказываем.
   */
  async function stopProcess(signalLauncher: boolean): Promise<void> {
    const failure = (cause?: unknown) => cleanupFailure({
      exit: outcome ?? null,
      failedSpawn,
      escalated,
      groupGone,
    }, cause);

    try {
      // Уже отправленный через child сигнал запускает disposal без повторного TERM.
      // После снятия обработчиков launcher второй TERM оборвал бы штатный выход 0/130.
      if (signalLauncher && !child.killed && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }

      if (!await waitForGone(6000)) {
        escalated = true;
        signalGroup(pgid, 'SIGKILL');
        await waitForGone(2000);
      }

      const code = outcome?.code;

      if (escalated || failedSpawn || code !== 0 && code !== 130) {
        throw failure();
      }
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'deepseek_binary_cleanup') {
        throw error;
      }

      throw failure(error);
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
