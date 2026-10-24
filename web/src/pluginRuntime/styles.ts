/**
 * Каждая попытка владеет отдельными links, даже если URL совпадают.
 * Отмена и ошибка снимают только её элементы; cleanup допускает повторный вызов.
 */
export async function loadPluginStyles(urls: string[], signal: AbortSignal): Promise<() => void> {
  const links: HTMLLinkElement[] = [];
  const disposers: Array<() => void> = [];
  const removeLinks = () => links.forEach((link) => link.remove());
  const cleanup = () => {
    disposers.splice(0).forEach((dispose) => dispose());
    links.splice(0).forEach((link) => link.remove());
    signal.removeEventListener('abort', removeLinks);
  };

  signal.throwIfAborted();
  signal.addEventListener('abort', removeLinks, { once: true });

  try {
    await Promise.all(urls.map((url) => new Promise<void>((resolve, reject) => {
      const link = document.createElement('link');
      const onLoad = () => resolve();
      const onError = () => reject(new Error('load-failed'));
      const onAbort = () => reject(signal.reason);

      link.rel = 'stylesheet';
      link.href = url;
      links.push(link);
      link.addEventListener('load', onLoad, { once: true });
      link.addEventListener('error', onError, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });
      disposers.push(() => {
        link.removeEventListener('load', onLoad);
        link.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      });
      document.head.append(link);
    })));
    signal.throwIfAborted();

    return cleanup;
  } catch (error) {
    cleanup();

    throw error;
  }
}
