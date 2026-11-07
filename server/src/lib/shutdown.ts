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
  // Начать остановку. Повторный вызов возвращает ту же остановку.
  begin(reason: string, exitCode?: number): Promise<void>;
  // Повесить обработчики SIGTERM/SIGINT. Второй сигнал во время остановки — немедленный выход.
  arm(): void;
}

const SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * Создать координатор. `close` — штатное закрытие Fastify, `exit` — выход из процесса:
 * оба подменяются в тестах, где ни сервера, ни процесса поднимать нельзя.
 */
export function createShutdownCoordinator({
  close,
  log = null,
  timeoutMs,
  exit = (code: number) => process.exit(code),
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

  /**
   * Сама остановка. Жёсткий таймер стоит на весь процесс: шаги и `close()` вместе
   * обязаны уложиться в бюджет, иначе выходим с ошибкой — данные слива к этому моменту
   * уже записаны, а держать порт дольше значит поймать SIGKILL снаружи.
   */
  async function run(reason: string, exitCode: number): Promise<void> {
    const startedAt = Date.now();
    let drained = true;

    log?.info?.({ reason, steps: steps.map((step) => step.name) }, 'сервер: начинаю остановку');

    const hardStop = setTimeout(() => {
      log?.error?.({ reason, timeoutMs }, 'сервер: остановка не уложилась в бюджет — выхожу принудительно');
      exit(exitCode || 1);
    }, timeoutMs);
    hardStop.unref?.();

    for (const step of steps) {
      try {
        await step.run();
      } catch (error) {
        drained = false;
        log?.error?.({ step: step.name, err: (error as Error)?.message }, 'сервер: шаг остановки упал');
      }
    }

    try {
      await close();
    } catch (error) {
      clearTimeout(hardStop);
      log?.error?.({ err: (error as Error)?.message }, 'сервер: закрытие завершилось ошибкой');
      exit(exitCode || 1);
      return;
    }

    log?.info?.({ reason, tookMs: Date.now() - startedAt }, 'сервер: остановлен');

    // Наблюдатели drain-пруфов остаются внутри общего бюджета: зависший observer
    // не должен держать процесс (и systemd до SIGKILL) после закрытия соединений.
    for (const observer of observers) {
      try {
        await observer(drained);
      } catch (error) {
        log?.error?.({ err: (error as Error)?.message }, 'сервер: подтверждение слива не записано');
      }
    }

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

  function onSignal(signal: NodeJS.Signals): void {
    if (active) {
      log?.warn?.({ signal }, 'сервер: повторный сигнал во время остановки — выхожу немедленно');
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
    arm() {
      for (const signal of SIGNALS) signals.on(signal, () => onSignal(signal));
    },
  };
}
