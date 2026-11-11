// Координатор остановки сервера: сигнал → шаги слива → закрытие Fastify → выход.
//
// Раньше сервер не ловил сигналы вовсе: SIGTERM от systemd, deploy/restart.sh или кнопки
// «Перезапустить» убивал процесс мгновенно, ни один onClose-хук не выполнялся, а живые
// сессии агентов умирали посреди хода вместе с лентой и id сессии. Здесь остановка идёт
// в два этапа. Сначала шаги слива (чат прерывает ходы и сохраняет их итог), пока сервер
// ещё полностью работает и отвечает окнам: так ответ прерванного хода и запись истории
// доезжают штатным путём. Потом обычное `app.close()`. Общий бюджет ограничен: зависший
// шаг не должен держать systemd до SIGKILL, иначе слив теряет смысл.

import type { EventEmitter } from 'node:events';

import { startProcessWatchdog } from './processWatchdog.ts';
import { nodeExecutable } from './runtimePaths.ts';

// Журнал сервера в том минимуме, который использует координатор.
interface ShutdownLog {
  info?: (fields: Record<string, unknown>, message: string) => void;
  warn?: (fields: Record<string, unknown>, message: string) => void;
  error?: (fields: Record<string, unknown>, message: string) => void;
}

// Шаг слива: имя для журнала и сама работа. Отказ шага не прерывает остановку.
interface ShutdownStep {
  name: string;
  run: () => Promise<void>;
}

// Что отдаётся модулям и точке входа.
export interface ShutdownCoordinator {
  // Идёт ли остановка прямо сейчас: модули отказывают новой долгой работе.
  readonly active: boolean;
  // Зарегистрировать шаг слива; порядок — порядок регистрации.
  register(name: string, run: () => Promise<void>): void;
  afterDrain?(observer: (success: boolean) => Promise<void>): void;
  closeStep(name: string, run: () => Promise<unknown>): Promise<void>;
  // Начать остановку. Повторный вызов возвращает ту же остановку.
  begin(reason: string, exitCode?: number): Promise<void>;
  // Повесить обработчики SIGTERM/SIGINT. Второй сигнал во время остановки — немедленный выход.
  arm(): void;
}

const SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
const exitProcess = (code: number) => process.exit(code);

/**
 * Создать координатор. `close` — штатное закрытие Fastify, `exit` — выход из процесса:
 * оба подменяются в тестах, где ни сервера, ни процесса поднимать нельзя.
 */
export function createShutdownCoordinator({
  close,
  log = null,
  timeoutMs,
  exit = exitProcess,
  signals = process,
}: {
  close: () => Promise<unknown>;
  log?: ShutdownLog | null;
  timeoutMs: number;
  exit?: (code: number) => void;
  signals?: EventEmitter;
}): ShutdownCoordinator {
  const steps: ShutdownStep[] = [];
  const observers: ((success: boolean) => Promise<void>)[] = [];

  let active = false;
  let running: Promise<void> | null = null;
  let terminated = false;
  const closing = new Map<symbol, { name: string; startedAt: number }>();

  /**
   * Именует внутреннюю операцию close, чтобы общий deadline указывал точное ожидание.
   * Ошибка сохраняется для Fastify, но её потенциально секретный текст не записывается.
   */
  async function closeStep(name: string, operation: () => Promise<unknown>): Promise<void> {
    const id = Symbol(name);
    const startedAt = Date.now();
    let outcome = 'error';

    closing.set(id, { name, startedAt });
    log?.info?.({
      event: 'shutdown.step.start',
      phase: 'close',
      step: name,
    }, 'сервер: начало закрытия сервиса');

    try {
      await operation();
      outcome = 'ok';
    } finally {
      log?.info?.({
        event: 'shutdown.step.end',
        phase: 'close',
        step: name,
        outcome,
        tookMs: Date.now() - startedAt,
      }, 'сервер: закрытие сервиса завершено');
      closing.delete(id);
    }
  }

  /**
   * Сама остановка. Жёсткий таймер стоит на весь процесс: шаги и `close()` вместе
   * обязаны уложиться в бюджет, иначе выходим с ошибкой — данные слива к этому моменту
   * уже записаны, а держать порт дольше значит поймать SIGKILL снаружи.
   */
  async function run(reason: string, exitCode: number): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let drained = true;
    let phase = 'drain';
    let currentStep = 'begin';
    let stepStartedAt = startedAt;

    if (exit === exitProcess) {
      startProcessWatchdog({
        node: nodeExecutable(),
        deadline,
        phase: 'process-exit',
      });
      process.send?.({
        type: 'grigdesk:shutdown-start',
        deadline,
        exitCode,
      }, () => {});
    }

    log?.info?.({ reason, steps: steps.map((step) => step.name) }, 'сервер: начинаю остановку');

    const hardStop = setTimeout(() => {
      const pendingClose = [...closing.values()];
      const latestClose = pendingClose.at(-1);

      terminated = true;
      log?.error?.({
        event: 'shutdown.deadline',
        phase,
        step: latestClose?.name ?? currentStep,
        pendingCloseSteps: pendingClose.map((step) => step.name),
        timeoutMs,
        tookMs: Date.now() - startedAt,
        stepMs: Date.now() - (latestClose?.startedAt ?? stepStartedAt),
      }, 'сервер: остановка не уложилась в бюджет');
      exit(exitCode || 1);
    }, Math.max(0, deadline - Date.now()));
    hardStop.unref?.();

    /**
     * Каждая граница имеет постоянное имя и длительность без текста исключений.
     * Поля последнего незавершённого шага попадают и в событие общего deadline.
     */
    async function traced(name: string, runStep: () => Promise<unknown>): Promise<boolean> {
      currentStep = name;
      stepStartedAt = Date.now();
      log?.info?.({
        event: 'shutdown.step.start',
        phase,
        step: name,
      }, 'сервер: начало шага остановки');

      try {
        await runStep();
        log?.info?.({
          event: 'shutdown.step.end',
          phase,
          step: name,
          outcome: 'ok',
          tookMs: Date.now() - stepStartedAt,
        }, 'сервер: шаг остановки завершён');

        return true;
      } catch {
        log?.error?.({
          event: 'shutdown.step.end',
          phase,
          step: name,
          outcome: 'error',
          tookMs: Date.now() - stepStartedAt,
        }, 'сервер: шаг остановки упал');

        return false;
      }
    }

    for (const step of steps) {
      drained = await traced(step.name, step.run) && drained;

      if (terminated) {
        return;
      }
    }

    phase = 'close';

    if (!await traced('fastify', close)) {
      terminated = true;
      clearTimeout(hardStop);
      exit(exitCode || 1);
      return;
    }

    if (terminated) {
      return;
    }

    phase = 'proof';

    // Наблюдатели drain-пруфов остаются внутри общего бюджета: зависший observer
    // не должен держать процесс (и systemd до SIGKILL) после закрытия соединений.
    for (const [index, observer] of observers.entries()) {
      await traced(`observer-${index}`, () => observer(drained));

      if (terminated) {
        return;
      }
    }

    phase = 'exit';
    log?.info?.({
      event: 'shutdown.exit',
      exitCode,
      drained,
      tookMs: Date.now() - startedAt,
    }, 'сервер: слив завершён, запрошен выход процесса');
    clearTimeout(hardStop);
    exit(exitCode);
  }

  /**
   * Первый запрос фиксирует причину и код выхода на весь слив.
   * Повторный запрос ждёт ту же работу и не меняет принятое решение.
   */
  function begin(reason: string, exitCode = 0): Promise<void> {
    if (running) {
      return running;
    }

    active = true;
    running = run(reason, exitCode);

    return running;
  }

  /**
   * Первый сигнал начинает штатный слив, повторный сохраняет аварийный код 1.
   * Немедленный независимый срок не даёт native cleanup превратить его в рестарт 75.
   */
  function onSignal(signal: NodeJS.Signals): void {
    if (active) {
      terminated = true;
      log?.warn?.({ signal }, 'сервер: повторный сигнал во время остановки — выхожу немедленно');

      if (exit === exitProcess) {
        const deadline = Date.now();

        startProcessWatchdog({
          node: nodeExecutable(),
          deadline,
          phase: 'repeated-signal',
        });
        process.send?.({
          type: 'grigdesk:shutdown-start',
          deadline,
          exitCode: 1,
        }, () => {});
      }

      exit(1);
      return;
    }
    void begin(`сигнал ${signal}`);
  }

  return {
    get active() { return active; },
    register(name, runStep) {
      steps.push({ name, run: runStep });
    },
    afterDrain(observer) {
      observers.push(observer);
    },
    begin,
    closeStep,
    arm() {
      for (const signal of SIGNALS) signals.on(signal, () => onSignal(signal));
    },
  };
}
