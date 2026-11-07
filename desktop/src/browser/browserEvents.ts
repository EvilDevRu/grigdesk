import type { BrowserWindow } from 'electron';

import { sameOrigin } from '../windowSecurity.ts';

type BrowserEventWindow = Pick<BrowserWindow, 'isDestroyed' | 'webContents'>;

/**
 * Состояние и намерения получает только проверенный главный frame текущей трубы.
 * Позднее событие guest не обращается к исчезнувшему документу и не уходит в новый frame.
 */
export function createBrowserEvents(options: {
  window(): BrowserEventWindow | null;
  origin(): string | null;
  stopping(): boolean;
}) {
  /**
   * Проверка origin и отправка закреплены за одним объектом frame без очереди повторов.
   * Ожидаемый отказ Electron при разрушении поглощается, ошибки данных остаются видимыми.
   */
  function deliver(channel: 'grigdesk:browser:state' | 'grigdesk:browser:intent', value: unknown): void {
    const window = options.window();
    const origin = options.origin();

    if (!window || !origin || options.stopping()) {
      return;
    }

    try {
      if (window.isDestroyed()) {
        return;
      }

      const contents = window.webContents;

      if (contents.isDestroyed() || contents.isCrashed() || contents.isLoadingMainFrame()) {
        return;
      }

      const frame = contents.mainFrame;

      if (!frame || frame.isDestroyed() || frame.detached || !sameOrigin(frame.url, origin)
        || contents.mainFrame !== frame || options.origin() !== origin || options.window() !== window) {
        return;
      }

      frame.send(channel, value);
    } catch (error) {
      if (error instanceof Error && (error.message === 'Object has been destroyed'
        || error.message === 'Render frame was disposed before WebFrameMain could be accessed')) {
        return;
      }

      throw error;
    }
  }

  return {
    changed: (snapshot: unknown) => deliver('grigdesk:browser:state', snapshot),
    intent: (value: unknown) => deliver('grigdesk:browser:intent', value),
  };
}
