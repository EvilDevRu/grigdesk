import { contextBridge, ipcRenderer } from 'electron';

if (process.isMainFrame) {
  let epoch: number | null = null;
  const ready = (ipcRenderer.invoke('grigdesk:browser:hello') as Promise<{ epoch: number }>)
    .then((value) => {
      epoch = value.epoch;

      return value;
    });

  void ready.catch(() => undefined);

  /**
   * Subscription относится ровно к одному фиксированному native каналу.
   * Renderer не получает event, sender, ipcRenderer или возможность выбрать канал.
   */
  function subscribe(channel: string, callback: (value: unknown) => void) {
    const listener = (_event: unknown, value: unknown) => callback(structuredClone(value));

    ipcRenderer.on(channel, listener);

    return () => ipcRenderer.removeListener(channel, listener);
  }

  contextBridge.exposeInMainWorld('grigdeskBrowser', Object.freeze({
    async invoke(request: unknown) {
      const current = await ready;

      return ipcRenderer.invoke('grigdesk:browser', { epoch: current.epoch, request });
    },
    /**
     * Только hide синхронен: native view убирается до отрисовки DOM overlay.
     * До первого handshake view ещё не имеет layout и безопасно остаётся скрытым.
     */
    hide(request: unknown) {
      if (epoch === null) {
        return false;
      }

      const result = ipcRenderer.sendSync('grigdesk:browser:hide', { epoch, request });

      return result?.ok === true;
    },
    /**
     * Тот же синхронный барьер возвращает последний кадр видимой вкладки для DOM.
     * Канал проверяет identity главного документа; произвольный захват здесь недоступен.
     */
    cover(request: unknown) {
      if (epoch === null) {
        return null;
      }

      const result = ipcRenderer.sendSync('grigdesk:browser:hide', { epoch, request });

      return result?.ok === true && typeof result.preview === 'string' ? result.preview : null;
    },
    subscribe: (callback: (value: unknown) => void) => subscribe('grigdesk:browser:state', callback),
    subscribeIntent: (callback: (value: unknown) => void) => subscribe('grigdesk:browser:intent', callback),
  }));
}
