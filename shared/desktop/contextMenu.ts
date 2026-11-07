export interface DesktopContextMenuItem {
  label: string;
  action: string;
  shortcut: string;
}

export interface DesktopContextMenuRequest {
  x: number;
  y: number;
  items: (DesktopContextMenuItem | null)[];
}

/**
 * Исполняется в главном документе без preload и доступа к Node.
 * В ответ возвращается только индекс; полномочия и команды остаются в Electron.
 */
export function requestDesktopContextMenu(
  request: DesktopContextMenuRequest,
): Promise<number | null | 'native'> {
  if (!document.documentElement.hasAttribute('data-desktop-context-menu')) {
    return Promise.resolve('native');
  }

  return new Promise((resolve) => {
    const channel = `grigdesk:context-menu-result:${crypto.randomUUID()}`;
    const finish = (event: Event) => {
      window.removeEventListener(channel, finish);
      resolve((event as CustomEvent<number | null>).detail);
    };

    window.addEventListener(channel, finish);
    window.dispatchEvent(new CustomEvent('grigdesk:context-menu', {
      detail: { ...request, channel },
    }));
  });
}
