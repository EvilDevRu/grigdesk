import { desktopText } from './locale.ts';
// Загрузка документа и проверка закреплённого релиза отделены от главного процесса.
// Модуль использует только типы Electron и вызывается без его запуска в Node.
import type { BrowserWindow } from 'electron';

type DocumentWindow = Pick<BrowserWindow, 'webContents' | 'loadURL' | 'isDestroyed'>;
/**
 * Повтор того же URL с hash через loadURL может остаться навигацией внутри страницы.
 * Reload гарантирует новый документ; ожидание и listeners заканчиваются вместе с загрузкой.
 */
function reloadDocument(window: DocumentWindow, signal: AbortSignal): Promise<void> {
  const contents = window.webContents;

  return new Promise((resolve, reject) => {
    /**
     * Все исходы снимают одни и те же listeners до завершения обещания.
     * Следующая загрузка не должна завершить уже прошедшую попытку.
     */
    function cleanup(): void {
      contents.removeListener('did-finish-load', finish);
      contents.removeListener('did-fail-load', fail);
      contents.removeListener('destroyed', cancel);
      signal.removeEventListener('abort', cancel);
    }

    function finish(): void {
      cleanup();
      resolve();
    }

    function fail(_event: unknown, code: number, message: string, _url: string, main: boolean): void {
      if (main) {
        cleanup();
        reject(Object.assign(new Error(message), { code }));
      }
    }

    function cancel(): void {
      cleanup();
      reject(Object.assign(new Error(desktopText('desktop.documentAborted')), { code: 'ERR_ABORTED' }));
    }

    contents.once('did-finish-load', finish);
    contents.on('did-fail-load', fail);
    contents.once('destroyed', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    contents.reload();
  });
}

/**
 * Загрузка документа принадлежит одному циклу и останавливается его сигналом.
 * Listener удаляется после загрузки, включая отказ или закрытие окна.
 */
export async function loadDocument(window: DocumentWindow, url: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || window.isDestroyed()) {
    return;
  }

  const cancel = () => {
    if (!window.isDestroyed()) {
      window.webContents.stop();
    }
  };

  signal.addEventListener('abort', cancel, { once: true });

  try {
    if (window.webContents.getURL() === url) {
      await reloadDocument(window, signal);
    } else {
      await window.loadURL(url);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
