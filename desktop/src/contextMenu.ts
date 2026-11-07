import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import { requestDesktopContextMenu } from '../../shared/desktop/contextMenu.ts';

const SHORTCUTS: Record<string, string> = {
  cut: 'X',
  copy: 'C',
  paste: 'V',
  selectAll: 'A',
};

/**
 * Документ рисует меню, но не получает буфер обмена или произвольные команды.
 * Ответ сверяется с исходным шаблоном; чужие документы используют нативное меню.
 */
export async function showStyledContextMenu(
  window: BrowserWindow,
  params: ContextMenuParams,
  template: MenuItemConstructorOptions[],
): Promise<boolean> {
  const modifier = process.platform === 'darwin' ? '⌘' : 'Ctrl+';
  const items = template.map((item) => item.type === 'separator' ? null : {
    label: item.label ?? '',
    action: item.role ?? 'link',
    shortcut: item.role && SHORTCUTS[item.role] ? `${modifier}${SHORTCUTS[item.role]}` : '',
  });
  const request = JSON.stringify({
    x: params.x,
    y: params.y,
    items,
  });
  const result = await window.webContents.executeJavaScript(
    `(${requestDesktopContextMenu.toString()})(${request})`,
  );

  if (result === 'native') {
    return false;
  }

  if (window.isDestroyed() || !Number.isInteger(result)) {
    return true;
  }

  const item = template[result];
  const role = item?.role;

  if (role === 'cut' || role === 'copy' || role === 'paste' || role === 'selectAll') {
    window.webContents[role]();
  } else if (item?.click && item.type !== 'separator') {
    // Только локальный callback шаблона: renderer не передаёт адрес ссылки.
    (item.click as () => void)();
  }

  return true;
}
