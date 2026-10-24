import type { BrowserWindow } from 'electron';

import type { DesktopExitCommand } from '../../shared/desktop/desktopExitContract.ts';
import { sameOrigin } from './windowSecurity.ts';

/**
 * Порт закреплён за одним главным документом трубы, без общего execute API.
 * Навигация и потеря frame инвалидируют ответы, даже если старый Promise ещё завершится.
 */
export function createDesktopExitBridge(window: BrowserWindow, origin: string) {
  const contents = window.webContents;
  const frame = contents.mainFrame;
  let invalidated = false;

  const invalidate = () => {
    invalidated = true;
  };
  const navigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) {
      invalidate();
    }
  };

  contents.on('did-start-navigation', navigation);
  contents.on('render-process-gone', invalidate);
  contents.on('destroyed', invalidate);

  /**
   * Проверка выполняется до исполнения и после ответа в том же frame.
   * Загрузка, подкадр и чужой URL никогда не получают команд остановки.
   */
  function valid(): boolean {
    try {
      return !invalidated && !window.isDestroyed() && !contents.isDestroyed() && !contents.isCrashed()
        && !contents.isLoadingMainFrame() && !!frame && contents.mainFrame === frame
        && !frame.parent && !frame.detached && !frame.isDestroyed()
        && sameOrigin(frame.url, origin) && new URL(frame.url).pathname === '/'
        && sameOrigin(contents.getURL(), origin) && new URL(contents.getURL()).pathname === '/';
    } catch {
      return false;
    }
  }

  /**
   * Только фиксированная функция renderer получает сериализованные данные.
   * Таймер и AbortSignal ограничивают ожидание; позднее исполнение ограничено expiresAt.
   */
  function request(command: DesktopExitCommand, signal: AbortSignal): Promise<unknown> {
    if (!valid() || signal.aborted || command.expiresAt <= Date.now()) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      let complete = false;
      let timer: ReturnType<typeof setTimeout>;
      const cancel = () => finish(null);
      /**
       * Только первый исход завершает ожидание и снимает таймер.
       * Поздний ответ закрытого frame больше не влияет на контроллер.
       */
      const finish = (value: unknown) => {
        if (complete) {
          return;
        }

        complete = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        resolve(value);
      };

      timer = setTimeout(cancel, Math.max(0, command.expiresAt - Date.now()));
      signal.addEventListener('abort', cancel, { once: true });

      try {
        const script = 'typeof window.grigdeskDesktopExit === "function"'
          + ' ? window.grigdeskDesktopExit(' + JSON.stringify(command) + ') : null';

        void frame.executeJavaScript(script).then(
          (value: unknown) => finish(valid() && !signal.aborted ? value : null), cancel,
        );
      } catch {
        cancel();
      }
    });
  }

  return {
    valid,
    request,
    /**
     * Подписки принадлежат одной операции выхода, а не жизни webContents.
     * Отмена вопроса освобождает их до следующего close.
     */
    dispose() {
      invalidate();
      contents.removeListener('did-start-navigation', navigation);
      contents.removeListener('render-process-gone', invalidate);
      contents.removeListener('destroyed', invalidate);
    },
  };
}
