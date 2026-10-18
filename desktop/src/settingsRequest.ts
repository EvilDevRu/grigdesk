import type { BrowserWindow, WebContents } from 'electron';
import { isUiDocumentPath } from '../../shared/runtime/uiRelease.ts';
import { sameOrigin } from './windowSecurity.ts';

export const OPEN_SETTINGS_SCRIPT =
  "window.dispatchEvent(new Event('grigdesk:open-settings')); void 0;";

type RequestWindow = Pick<BrowserWindow, 'isDestroyed' | 'webContents' | 'on' | 'removeListener'>;

type SettingsRequestOptions = {
  getWindow(): RequestWindow | null;
  revealed(): boolean;
  origin: string;
};

/**
 * Событие доставляется в тот же проверенный frame без создания документа.
 * Только ещё не отправленный запрос склеивается и снимает свои обработчики при отмене.
 */
export function createSettingsRequest(options: SettingsRequestOptions) {
  let pending: RequestWindow | null = null;
  let disposed = false;

  /**
   * Отложенный запрос владеет только собственными слушателями.
   * Закрытие и выход не оставляют обработчиков на прежнем webContents.
   */
  function clearPending(): void {
    const window = pending;

    pending = null;

    if (window) {
      window.removeListener('closed', clearPending);
      window.webContents.removeListener('did-finish-load', retry);
      window.webContents.removeListener('did-stop-loading', retry);
      window.webContents.removeListener('did-start-navigation', navigation);
      window.webContents.removeListener('destroyed', clearPending);
    }
  }

  function allowed(url: string): boolean {
    return sameOrigin(url, options.origin) && isUiDocumentPath(new URL(url).pathname);
  }

  function navigation(details: { url: string; isMainFrame: boolean }): void {
    if (details.isMainFrame && !allowed(details.url)) {
      clearPending();
    }
  }

  function retry(): void {
    const window = pending;

    if (window) {
      deliver(window);
    }
  }

  /**
   * Загрузка откладывает один запрос; каждый повтор заново проверяет главный frame.
   * Отказ уже отправленного скрипта поглощается без блокировки следующего нажатия.
   */
  function deliver(window: RequestWindow): void {
    try {
      const contents: WebContents = window.webContents;

      if (!options.revealed() || window.isDestroyed() || contents.isDestroyed() || contents.isCrashed()) {
        clearPending();

        return;
      }

      if (contents.isLoadingMainFrame()) {
        if (pending !== window) {
          clearPending();
          pending = window;
          window.on('closed', clearPending);
          contents.on('did-finish-load', retry);
          contents.on('did-stop-loading', retry);
          contents.on('did-start-navigation', navigation);
          contents.on('destroyed', clearPending);
        }

        return;
      }

      clearPending();

      const frame = contents.mainFrame;

      if (frame.isDestroyed() || frame.detached || !allowed(frame.url)) {
        return;
      }

      void frame.executeJavaScript(OPEN_SETTINGS_SCRIPT).catch(() => undefined);
    } catch {
      clearPending();
    }
  }

  function open(): void {
    const window = options.getWindow();

    if (!disposed && window) {
      deliver(window);
    }
  }

  function dispose(): void {
    disposed = true;
    clearPending();
  }

  return { open, dispose };
}
