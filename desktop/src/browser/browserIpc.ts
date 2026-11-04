import { isPlainRecord } from '../../../shared/lib/objects.ts';

import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/**
 * Surface того же origin и iframe не имеют identity главного WebContents/mainFrame.
 * HTTP cookies, Referer и UA не участвуют в разрешении native операции.
 */
export function isBrowserSender(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  window: BrowserWindow | null, origin: string | null,
): boolean {
  if (!window || window.isDestroyed() || !origin || event.sender !== window.webContents
    || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame
    || event.senderFrame.isDestroyed()) {
    return false;
  }

  try {
    return new URL(event.senderFrame.url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Один native document epoch связывает handshake, async invoke и synchronous hide.
 * BrowserApi повторяет valid callback до каждого CDP input и после async наблюдения.
 */
export function attachBrowserIpc(options: {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>;
  window(): BrowserWindow | null;
  origin(): string | null;
  epoch(): number;
  execute(request: unknown, valid: () => boolean): Promise<unknown>;
  hide(request: unknown): string | null | void;
}) {
  const sender = (event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>) =>
    isBrowserSender(event, options.window(), options.origin());
  const payload = (event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, value: unknown) => {
    if (!sender(event) || !isPlainRecord(value)
      || Object.keys(value).sort().join() !== 'epoch,request' || value.epoch !== options.epoch()) {
      throw new Error('browser_sender_forbidden');
    }

    return value;
  };

  options.ipc.handle('grigdesk:browser:hello', (event) => {
    if (!sender(event)) {
      throw new Error('browser_sender_forbidden');
    }

    return { epoch: options.epoch() };
  });
  options.ipc.handle('grigdesk:browser', (event, value: unknown) => {
    const message = payload(event, value);
    const epoch = options.epoch();

    return options.execute(message.request, () => sender(event) && epoch === options.epoch());
  });

  /**
   * Синхронное скрытие проверяет ту же identity документа, что async invoke.
   * Ответ возвращается только после завершения native hide.
   */
  const hide = (event: IpcMainEvent, value: unknown) => {
    try {
      const message = payload(event, value);

      const preview = options.hide(message.request);

      event.returnValue = typeof preview === 'string' ? { ok: true, preview } : { ok: true };
    } catch {
      event.returnValue = { ok: false, error: 'browser_sender_forbidden' };
    }
  };

  options.ipc.on('grigdesk:browser:hide', hide);

  return () => {
    options.ipc.removeHandler('grigdesk:browser:hello');
    options.ipc.removeHandler('grigdesk:browser');
    options.ipc.removeListener('grigdesk:browser:hide', hide);
  };
}
