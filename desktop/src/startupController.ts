export const SPLASH_MINIMUM_MS = 2000;
export const STARTUP_DEADLINE_MS = 90_000;
export const FRAME_LIMIT_MS = 1500;
// Ожидание VPN-ворот срок старта не расходует, но не дольше этого предела от start().
export const STARTUP_HOLD_LIMIT_MS = 600_000;
// Как часто проверяется, держит ли ещё удержание срок старта.
const HOLD_POLL_MS = 1000;

export type StartupState = 'idle' | 'booting' | 'revealed' | 'failed' | 'cancelled';
export type StartupPhase = 'splash' | 'server' | 'connect' | 'frame';

export interface StartupAdapters {
  now(): number;
  setTimer(ms: number, callback: () => void): () => void;
  showSplash(signal: AbortSignal): Promise<void>;
  focusSplash(): void;
  prepare(signal: AbortSignal): Promise<void>;
  connect(signal: AbortSignal): Promise<void>;
  waitFrame(signal: AbortSignal): Promise<void>;
  reveal(): void;
  focusMain(): void;
  timeoutMessage(phase: StartupPhase): string;
  fail(message: string): void;
  // Ожидание, которое не расходует срок (VPN-ворота): пока true, отказ по сроку откладывается.
  holdDeadline?(): boolean;
}

export interface StartupController {
  readonly state: StartupState;
  start(): Promise<StartupState>;
  cancel(): void;
  focusRequest(): void;
}

export interface FrameTracker {
  navigated(): void;
  painted(): void;
  wait(signal: AbortSignal, limitMs: number, setTimer: StartupAdapters['setTimer']): Promise<void>;
}

/**
 * Ошибка отмены отличается от отказа адаптера: её не показывают человеку.
 * Причина сигнала сохраняется, если вызывающий код её задал.
 */
function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Старт окна отменён.');
}

/**
 * Ведёт старт окна по шагам: заставка, сервер, вход, кадр и минимум показа заставки.
 * Срок считается от start(); после показа, отказа или отмены поздние ответы ничего не делают.
 */
export function createStartupController(adapters: StartupAdapters): StartupController {
  const controller = new AbortController();
  const signal = controller.signal;
  let state: StartupState = 'idle';
  let phase: StartupPhase = 'splash';
  let running: Promise<StartupState> | null = null;
  let splashShown = false;
  let focusPending = false;
  let cancelDeadline: (() => void) | null = null;
  let startedAt = 0;
  let holding = false;

  /**
   * Завершённый старт снимает срок и отменяет сигнал: адаптеры прекращают ожидания.
   * Повторный вызов ничего не меняет, поэтому срок и отказ не сталкиваются.
   */
  function settle(next: 'failed' | 'cancelled'): boolean {
    if (state !== 'booting' && state !== 'idle') {
      return false;
    }

    state = next;
    cancelDeadline?.();
    cancelDeadline = null;
    controller.abort();

    return true;
  }

  /**
   * Срок старта истёк. Удержание (ожидание VPN) откладывает отказ опросом раз в секунду,
   * но не дольше предела от start(); после конца удержания даётся свежий полный срок.
   */
  function deadlineReached(): void {
    if (state !== 'booting') {
      return;
    }

    const held = adapters.holdDeadline?.() === true;

    if (held && adapters.now() - startedAt < STARTUP_HOLD_LIMIT_MS) {
      holding = true;
      cancelDeadline = adapters.setTimer(HOLD_POLL_MS, deadlineReached);

      return;
    }

    if (holding && !held) {
      holding = false;
      cancelDeadline = adapters.setTimer(STARTUP_DEADLINE_MS, deadlineReached);

      return;
    }

    failWith(adapters.timeoutMessage(phase));
  }

  /**
   * Отказ сообщается ровно один раз и только из фазы загрузки.
   * После показа, отмены или прежнего отказа сообщение отбрасывается.
   */
  function failWith(message: string): void {
    if (state === 'booting' && settle('failed')) {
      adapters.fail(message);
    }
  }

  /**
   * Шаг старта ждёт свой адаптер или отмену — что раньше. Адаптер, не услышавший сигнал,
   * не задерживает отказ по сроку; его поздний ответ или отказ поглощаются.
   */
  function guarded(promise: Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        promise.catch(() => {});
        reject(abortError(signal));

        return;
      }

      const abort = () => reject(abortError(signal));

      signal.addEventListener('abort', abort, { once: true });
      promise.then(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      });
    });
  }

  /**
   * Минимум показа заставки ждёт по часам адаптера и прерывается отменой.
   * Прерывание не отклоняет ожидание: дальше решает проверка состояния.
   */
  function waitMinimum(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let cancelTimer: () => void = () => {};

      const finish = () => {
        cancelTimer();
        signal.removeEventListener('abort', finish);
        resolve();
      };

      cancelTimer = adapters.setTimer(ms, finish);
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  /**
   * Шаги идут строго по порядку; после каждого await проверяется, не закончен ли старт.
   * Показ главного окна — только после кадра и минимума с момента показа заставки.
   */
  async function run(): Promise<StartupState> {
    try {
      await guarded(adapters.showSplash(signal));

      if (state !== 'booting') {
        return state;
      }

      const shownAt = adapters.now();

      splashShown = true;

      if (focusPending) {
        focusPending = false;
        adapters.focusSplash();
      }

      phase = 'server';
      await guarded(adapters.prepare(signal));

      if (state !== 'booting') {
        return state;
      }

      phase = 'connect';
      await guarded(adapters.connect(signal));

      if (state !== 'booting') {
        return state;
      }

      phase = 'frame';
      await guarded(adapters.waitFrame(signal));

      if (state !== 'booting') {
        return state;
      }

      const rest = SPLASH_MINIMUM_MS - (adapters.now() - shownAt);

      if (rest > 0) {
        await waitMinimum(rest);

        if (state !== 'booting') {
          return state;
        }
      }

      state = 'revealed';
      cancelDeadline?.();
      cancelDeadline = null;
      adapters.reveal();

      return state;
    } catch (error) {
      if (state === 'booting') {
        failWith(error instanceof Error ? error.message : String(error));
      }

      return state;
    }
  }

  /**
   * Первый вызов ставит срок и запускает шаги; повторный получает то же обещание.
   * Старт после отмены сразу возвращает итог без эффектов.
   */
  function start(): Promise<StartupState> {
    if (running) {
      return running;
    }

    if (state !== 'idle') {
      running = Promise.resolve(state);

      return running;
    }

    state = 'booting';
    phase = 'splash';
    startedAt = adapters.now();
    cancelDeadline = adapters.setTimer(STARTUP_DEADLINE_MS, deadlineReached);
    running = run();

    return running;
  }

  /**
   * Отмена действует только до показа: показанное окно остаётся показанным.
   * Сигнал прерывает текущий шаг, отказ при этом не сообщается.
   */
  function cancel(): void {
    settle('cancelled');
  }

  /**
   * Второй экземпляр приложения просит фокус: до показа заставки запрос откладывается,
   * во время старта получает заставка, после показа — главное окно.
   */
  function focusRequest(): void {
    if (state === 'revealed') {
      adapters.focusMain();

      return;
    }

    if (state !== 'idle' && state !== 'booting') {
      return;
    }

    if (splashShown) {
      adapters.focusSplash();
    } else {
      focusPending = true;
    }
  }

  return {
    get state() {
      return state;
    },
    start,
    cancel,
    focusRequest,
  };
}

/**
 * Барьер кадра: у ни разу не показанного окна ready-to-show приходит на каждый документ.
 * Готово, когда последний документ своего origin получил кадр; ожидание ограничено пределом.
 */
export function createFrameTracker(): FrameTracker {
  let navigations = 0;
  let painted = 0;
  const waiters = new Set<() => void>();

  function ready(): boolean {
    return navigations > 0 && painted === navigations;
  }

  return {
    navigated() {
      navigations += 1;
    },
    /**
     * Кадр засчитывается документу, который был последним на момент ready-to-show.
     * Если он совпал с последним навигированным, ожидания разрешаются сразу.
     */
    painted() {
      painted = navigations;

      if (ready()) {
        for (const waiter of [...waiters]) {
          waiter();
        }
      }
    },
    /**
     * Разрешается при готовом кадре или по пределу; отмена сигнала — отказ.
     * Таймер и подписка снимаются при любом исходе.
     */
    wait(signal, limitMs, setTimer) {
      if (ready()) {
        return Promise.resolve();
      }

      if (signal.aborted) {
        return Promise.reject(abortError(signal));
      }

      return new Promise((resolve, reject) => {
        let cancelTimer: () => void = () => {};

        const cleanup = () => {
          waiters.delete(finish);
          cancelTimer();
          signal.removeEventListener('abort', abort);
        };

        const finish = () => {
          cleanup();
          resolve();
        };

        const abort = () => {
          cleanup();
          reject(abortError(signal));
        };

        waiters.add(finish);
        cancelTimer = setTimer(limitMs, finish);
        signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
}
