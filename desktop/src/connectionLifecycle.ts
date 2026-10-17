import { delayWithAbort } from '../../shared/lib/delay.ts';

// Несовместимость установленного пакета не исправляется повторным опросом сети.
export class PermanentConnectionError extends Error {}

export interface LoadFailure {
  code: number;
  url: string;
  isMainFrame: boolean;
}

// Событие главного документа: адрес и HTTP-код ответа.
export interface NavigationEvent {
  url: string;
  httpResponseCode?: number;
  isMainFrame?: boolean;
}

export type SessionResult = 'session' | 'window-key' | 'unavailable';

export interface ConnectionLifecycleOptions {
  origin: string;
  controller?: AbortController;
  alive: (signal: AbortSignal) => Promise<boolean>;
  wait: (signal: AbortSignal) => Promise<boolean>;
  ensureSession: (signal: AbortSignal) => Promise<SessionResult>;
  loadOffline: (signal: AbortSignal) => Promise<unknown>;
  showUnavailable: (signal: AbortSignal) => Promise<unknown>;
  loadCockpit: (address: string, signal: AbortSignal) => Promise<unknown>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  // Успешный цикл: интерфейс загружен без повтора, восстановления и отказа.
  onConnected?: () => void;
  // Пауза перед повтором входа; при старте окна она короче обычной.
  retryMs?: () => number;
}

export interface ConnectionLifecycle {
  connect: () => Promise<void>;
  loadFailed: (failure: LoadFailure) => Promise<void>;
  navigated: (event: NavigationEvent) => Promise<void>;
  stop: () => void;
}

// Повтор неудачного входа: тот же интервал, что и у ожидания выключенного сервера.
const RETRY_MS = 10_000;
// Автоматический вход по 401 — не чаще раза в минуту: иначе битый вход крутил бы окно.
const AUTO_LOGIN_INTERVAL_MS = 60_000;

/**
 * Ошибка должна относиться к HTTP-документу выбранного origin.
 * Blob со своим вложенным origin и локальная data-страница не являются сайтом.
 */
function ownHttpUrl(value: string, origin: string): boolean {
  try {
    const url = new URL(value);

    return url.protocol === 'http:' && url.origin === origin;
  } catch {
    return false;
  }
}

function abortedLoad(error: unknown): boolean {
  const failure = error as { code?: unknown; errno?: unknown } | null;

  return failure?.code === -3 || failure?.errno === -3 || failure?.code === 'ERR_ABORTED';
}

/**
 * Один цикл владеет опросом, входом и загрузкой, включая их одновременные отказы.
 * Stop запрещает следующий эффект после любого await без зависимости от Electron.
 *
 * Адрес восстановления lifecycle хранит сам: главный документ с 401 загружается заново
 * по тому же адресу с hash, но автоматический вход выполняется не чаще раза в минуту.
 */
export function createConnectionLifecycle(options: ConnectionLifecycleOptions): ConnectionLifecycle {
  const controller = options.controller ?? new AbortController();
  const signal = controller.signal;
  const sleep = options.sleep ?? delayWithAbort;
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? (() => RETRY_MS);
  let running: Promise<void> | null = null;
  // Сбой загрузки: проверять сервер заново не нужно, сразу ожидание.
  let recovering = false;
  // Запрошен ещё один полный цикл: так главный документ с 401 возвращает вход.
  let again = false;
  // Повторный 401 внутри минуты: показываем отказ и повторяем попытку через 10 с.
  let refused = false;
  // Последний адрес своего origin, который стоит открыть после восстановления входа.
  let address = options.origin + '/';
  let lastAutoLogin: number | null = null;

  /**
   * Событие и reject одной загрузки ставят общий признак следующей попытки.
   * Только этот владелец проходит offline/wait и повторяет вход перед сайтом.
   */
  async function run(): Promise<void> {
    try {
      while (!signal.aborted) {
        if (refused) {
          refused = false;
          recovering = false;
          again = false;
          await options.showUnavailable(signal);

          if (signal.aborted) {
            return;
          }

          await sleep(retryMs(), signal);

          if (signal.aborted) {
            return;
          }

          continue;
        }

        const recovery = recovering;

        recovering = false;
        again = false;

        const alive = recovery ? false : await options.alive(signal);

        if (signal.aborted) {
          return;
        }

        if (!alive) {
          await options.loadOffline(signal);

          if (signal.aborted) {
            return;
          }

          const ready = await options.wait(signal);

          if (signal.aborted || !ready) {
            return;
          }
        }

        const result = await options.ensureSession(signal);

        if (signal.aborted) {
          return;
        }

        // Ключ недоступен: интерфейс не грузится, окно показывает отказ и повторяет попытку.
        if (result === 'unavailable') {
          await options.showUnavailable(signal);

          if (signal.aborted) {
            return;
          }

          await sleep(retryMs(), signal);

          if (signal.aborted) {
            return;
          }

          continue;
        }

        try {
          await options.loadCockpit(address, signal);
        } catch (error) {
          if (signal.aborted || abortedLoad(error)) {
            return;
          }

          if (error instanceof PermanentConnectionError) {
            throw error;
          }

          recovering = true;

          continue;
        }

        // Ещё один цикл нужен, только если его запросили во время этой загрузки:
        // сбой загрузки, 401 главного документа или повторный отказ входа.
        if (signal.aborted) {
          return;
        }

        if (!recovering && !again && !refused) {
          options.onConnected?.();

          return;
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
    } finally {
      running = null;
    }
  }

  /**
   * Повторные вызовы получают то же обещание, пока не завершён общий цикл.
   * Отложенный старт назначает владельца до синхронного отказа любого adapter.
   */
  function connect(): Promise<void> {
    if (signal.aborted) {
      return Promise.resolve();
    }

    if (running === null) {
      running = Promise.resolve().then(run);
    }

    return running;
  }

  /**
   * Внешние и отменённые загрузки не создают подключение и не меняют его очередь.
   * Сбой своего главного документа присоединяется к текущему циклу либо начинает новый.
   */
  function loadFailed(failure: LoadFailure): Promise<void> {
    if (signal.aborted || failure.code === -3 || !failure.isMainFrame
      || !ownHttpUrl(failure.url, options.origin)) {
      return Promise.resolve();
    }

    recovering = true;

    return connect();
  }

  /**
   * Главный документ своего origin с 401 означает потерянную сессию.
   * Первый такой отказ за минуту запускает обычный вход; повторный показывает страницу
   * отказа, а окно продолжает повторять попытку. Успешная навигация обновляет адрес.
   *
   * Возвращается обещание восстановления: сбой локальной страницы caller обрабатывает
   * так же, как сбой загрузки, а не теряет его необработанным отказом.
   */
  function navigated(event: NavigationEvent): Promise<void> {
    if (signal.aborted || event.isMainFrame === false || !ownHttpUrl(event.url, options.origin)) {
      return Promise.resolve();
    }

    if (event.httpResponseCode !== 401) {
      if (event.httpResponseCode === undefined || event.httpResponseCode === 200) {
        address = event.url;
      }

      return Promise.resolve();
    }

    address = event.url;

    const last = lastAutoLogin;

    if (last === null || now() - last >= AUTO_LOGIN_INTERVAL_MS) {
      lastAutoLogin = now();
      again = true;

      return connect();
    }

    refused = true;

    return connect();
  }

  return {
    connect,
    loadFailed,
    navigated,
    stop: () => controller.abort(),
  };
}
