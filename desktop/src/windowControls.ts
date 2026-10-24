import type { BrowserWindow } from 'electron';

import type { WindowControlAction, WindowControlsState } from '../../shared/desktop/windowControls.ts';
import { sameOrigin } from './windowSecurity.ts';

type ControlledWindow = Pick<BrowserWindow,
  'isDestroyed' | 'isMaximized' | 'minimize' | 'maximize' | 'unmaximize' | 'close' | 'webContents'>;

export interface WindowControls {
  state(): WindowControlsState;
  subscribe(listener: () => void): () => void;
  control(origin: string, action: WindowControlAction): boolean;
}

/**
 * Кнопки принадлежат странице и подчиняются её модальным слоям, а действия — Electron.
 * Закрытие проходит через обычный close, сохраняя подтверждение выхода и защиту правок.
 */
export function createWindowControls(options: {
  getWindow(): ControlledWindow | null;
  origin(): string | null;
  stopping(): boolean;
}) {
  const listeners = new Set<() => void>();

  const changed = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    changed,
    state: (): WindowControlsState => {
      const window = options.getWindow();

      return { maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()) };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * Принимается только текущий origin главного UI, включая экран без выбранной машины.
     * Отложенный close даёт трубе отправить ответ и повторно проверяет владельца окна.
     */
    control(origin: string, action: WindowControlAction): boolean {
      const window = options.getWindow();

      if (options.stopping() || origin !== options.origin() || !window || window.isDestroyed()
        || window.webContents.isDestroyed() || !sameOrigin(window.webContents.getURL(), origin)
        || new URL(window.webContents.getURL()).pathname !== '/') {
        return false;
      }

      if (action === 'minimize') {
        window.minimize();
      } else if (action === 'toggle-maximize') {
        if (window.isMaximized()) {
          window.unmaximize();
        } else {
          window.maximize();
        }
      } else {
        setImmediate(() => {
          if (!options.stopping() && options.getWindow() === window
            && options.origin() === origin && !window.isDestroyed()) {
            window.close();
          }
        });
      }

      return true;
    },
  } satisfies WindowControls & { changed(): void };
}
