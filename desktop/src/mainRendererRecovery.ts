import type { BrowserWindow, RenderProcessGoneDetails } from 'electron';

type RecoveryWindow = Pick<BrowserWindow, 'isDestroyed' | 'webContents' | 'on' | 'removeListener'>;

type RecoveryDiagnostic = {
  event: 'renderer-gone' | 'renderer-recovery-failed';
  role: 'main';
  reason?: RenderProcessGoneDetails['reason'];
  exitCode?: number;
  phase?: 'prompt' | 'reload';
};

/**
 * Восстановление интерфейса начинается только с ответа нативного диалога человека.
 * Диалог принадлежит одному документу; навигация, закрытие и выход отменяют его ответ.
 */
export function attachMainRendererRecovery(options: {
  window: RecoveryWindow;
  signal: AbortSignal;
  origin(): string | null;
  stopping(): boolean;
  revealed(): boolean;
  invalidate(): void;
  confirm(signal: AbortSignal): Promise<boolean>;
  reload(origin: string): Promise<void>;
  failStartup(): void;
  log(diagnostic: RecoveryDiagnostic): void;
}): () => void {
  const { window } = options;
  const contents = window.webContents;
  let pending: AbortController | null = null;
  let disposed = false;

  function available(): boolean {
    return !disposed && !options.signal.aborted && !options.stopping()
      && !window.isDestroyed() && !contents.isDestroyed();
  }

  function cancelPending(): void {
    pending?.abort();
    pending = null;
  }

  /**
   * Поздний ответ прежнего диалога не загружает другую машину и не повторяет действий.
   * Сбой native-диалога или загрузки записывается без текста исключения и данных страницы.
   */
  async function recover(origin: string, controller: AbortController): Promise<void> {
    let phase: 'prompt' | 'reload' = 'prompt';

    try {
      const confirmed = await options.confirm(controller.signal);

      if (!confirmed || controller.signal.aborted || !available() || options.origin() !== origin) {
        return;
      }

      // Собственная загрузка тоже даёт did-start-navigation: её диалог уже завершён.
      // Отменять здесь общий lifetime окна или новую загрузку не требуется.
      pending = null;
      phase = 'reload';
      await options.reload(origin);
    } catch {
      if (!controller.signal.aborted && available() && options.origin() === origin) {
        options.log({
          event: 'renderer-recovery-failed',
          role: 'main',
          phase,
        });
      }
    } finally {
      if (pending === controller) {
        pending = null;
      }
    }
  }

  /**
   * Сначала закрываются геометрия и разрешения потерянного renderer.
   * Повторный сигнал не размножает вопросы и не запускает автоматических перезагрузок.
   */
  function gone(_event: unknown, details: RenderProcessGoneDetails): void {
    options.log({
      event: 'renderer-gone',
      role: 'main',
      reason: details.reason,
      exitCode: details.exitCode,
    });

    if (!available()) {
      return;
    }

    options.invalidate();

    if (!options.revealed()) {
      options.failStartup();

      return;
    }

    const origin = options.origin();

    if (!origin || pending) {
      return;
    }

    const controller = new AbortController();

    pending = controller;
    void recover(origin, controller);
  }

  function navigation(details: { isMainFrame: boolean; isSameDocument: boolean }): void {
    if (details.isMainFrame && !details.isSameDocument) {
      cancelPending();
    }
  }

  /**
   * Слушатели принадлежат окну, а не каждой попытке восстановления.
   * Выход и закрытие освобождают диалог даже при незавершённом Promise адаптера.
   */
  function dispose(): void {
    disposed = true;
    cancelPending();
    contents.removeListener('render-process-gone', gone);
    contents.removeListener('did-start-navigation', navigation);
    contents.removeListener('destroyed', dispose);
    window.removeListener('closed', dispose);
    options.signal.removeEventListener('abort', dispose);
  }

  if (available()) {
    contents.on('render-process-gone', gone);
    contents.on('did-start-navigation', navigation);
    contents.on('destroyed', dispose);
    window.on('closed', dispose);
    options.signal.addEventListener('abort', dispose, { once: true });
  }

  return dispose;
}
