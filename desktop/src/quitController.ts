export type QuitReason = 'user' | 'main-closed' | 'splash-closed' | 'signal' | 'failure';

export interface QuitRequest {
  reason: QuitReason;
  exitCode: 0 | 1;
  message?: string;
}

export interface QuitAdapters {
  cancelStartup(): void;
  closeSplash(): void;
  showError(message: string, signal: AbortSignal): Promise<void>;
  stopOwnServer(): Promise<void>;
  revealed(): boolean;
  saveWindow(): Promise<void>;
  flushCookies(): Promise<void>;
  log(message: string): void;
  exit(code: number): void;
}

export interface QuitController {
  readonly stopping: boolean;
  request(request: QuitRequest): Promise<void>;
}

/**
 * Единственный путь выхода приложения: отменить старт, убрать заставку, остановить свой
 * сервер и только потом выйти. Первый запрос задаёт код и сообщение, остальные ждут его.
 */
export function createQuitController(adapters: QuitAdapters): QuitController {
  const dialog = new AbortController();
  let stopping = false;
  let running: Promise<void> | null = null;

  /**
   * Шаг уборки не должен сорвать остальные: его отказ только пишется в журнал.
   * Синхронное исключение адаптера обрабатывается так же, как отклонённое обещание.
   */
  async function attempt(step: () => Promise<void> | void, failure: string): Promise<void> {
    try {
      await step();
    } catch {
      adapters.log(failure);
    }
  }

  /**
   * Диалог, остановка своего сервера и сохранение окна идут одновременно.
   * Геометрия пишется только после показа главного окна, иначе затёрла бы прежнюю.
   */
  async function run(request: QuitRequest): Promise<void> {
    if (request.message) {
      adapters.log(`GrigDesk: ${request.message}`);
    }

    await attempt(() => adapters.cancelStartup(), 'GrigDesk: старт окна не отменился.');
    await attempt(() => adapters.closeSplash(), 'GrigDesk: заставка не закрылась.');

    const parallel = [];

    if (request.message) {
      const message = request.message;

      parallel.push(attempt(() => adapters.showError(message, dialog.signal),
        'GrigDesk: диалог ошибки не показан.'));
    }

    parallel.push(attempt(() => adapters.stopOwnServer(), 'GrigDesk: свой сервер не остановился штатно.'));

    if (adapters.revealed()) {
      parallel.push(attempt(() => adapters.saveWindow(), 'GrigDesk: не удалось сохранить настройки окна.'));
    }

    await Promise.all(parallel);
    await attempt(() => adapters.flushCookies(), 'GrigDesk: не удалось сохранить данные сессии окна.');
    adapters.exit(request.exitCode);
  }

  /**
   * Первый запрос синхронно включает выход; повторный возвращает то же обещание.
   * Внешний запрос выхода во время диалога — сигнал процесса или app.quit(), куда Electron
   * сам переводит SIGTERM, — закрывает диалог, не меняя код первого запроса.
   */
  function request(next: QuitRequest): Promise<void> {
    if (running) {
      if (next.reason === 'signal' || next.reason === 'user') {
        dialog.abort();
      }

      return running;
    }

    stopping = true;
    running = run(next);

    return running;
  }

  return {
    get stopping() {
      return stopping;
    },
    request,
  };
}
