import { createHash } from 'node:crypto';

import { browserUrl } from '../../../shared/browser/browserContract.ts';
import { isPlainRecord } from '../../../shared/lib/objects.ts';

import type {
  BrowserWindow, BrowserWindowConstructorOptions, NativeImage,
  WebContentsView, WebContentsViewConstructorOptions,
} from 'electron';
import type { BrowserRect, TabView } from './browserTabs.ts';
import type { createBrowserProtocol } from './browserProtocol.ts';

type Send = Parameters<typeof createBrowserProtocol>[0]['send'];

export interface BrowserViewEvents {
  start(): void;
  navigated(url: string): void;
  metadata(value: {
    title?: string;
    loading?: boolean;
    error?: string
  }): void;
  lost(): void;
  popup(url: string): void;
  intent(value: 'address' | 'new' | 'close' | 'back' | 'forward'): void;
}

export interface NativeBrowserView extends TabView {
  send: Send;
  state(): {
    canBack: boolean;
    canForward: boolean;
    zoom: number
  };
  history(direction: -1 | 1): void;
  reload(): void;
  zoom(factor: number): void;
  screenshot(send: Send): Promise<string>;
  console(): { level: string; text: string }[];
}

/**
 * Site cookies отделены от UI secret, другой машины и другого owner session.
 * Stable digest не содержит URL и не делает путь профиля частью renderer DTO.
 */
export function browserViewOptions(machine: string, scope: string): WebContentsViewConstructorOptions {
  const digest = createHash('sha256').update(JSON.stringify([machine, scope])).digest('hex');

  return {
    webPreferences: {
      partition: `persist:grigdesk-browser-${digest}`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      devTools: false,
    },
  };
}

/**
 * Main BrowserWindow options копируются существующим guard в дочерние окна.
 * Privileged preload снимается до этого копирования, включая рекурсивное onChild.
 */
export function browserChildWindowOptions(options: BrowserWindowConstructorOptions) {
  const { preload: _preload, ...webPreferences } = options.webPreferences ?? {};

  return { ...options, webPreferences };
}

/**
 * Electron imports остаются в main, а adapter принимает обычные values port.
 * Все load/history/popup entry points применяют тот же URL guard до эффекта.
 */
export function createNativeBrowserView(options: {
  machine: string;
  scope: string;
  create(value: WebContentsViewConstructorOptions): WebContentsView;
  imageFromBuffer(data: Buffer): NativeImage;
  window(): BrowserWindow;
  pipeOrigins(): ReadonlySet<string>;
  events: BrowserViewEvents;
}): NativeBrowserView {
  const window = options.window();
  const view = options.create(browserViewOptions(options.machine, options.scope));
  const contents = view.webContents;
  const log: { level: string; text: string }[] = [];
  let disposed = false;
  let debuggerReady = false;
  let attached = false;

  /**
   * Сайт получает bounded кольцевой журнал без network headers/cookies.
   * Одинаковая граница применяется к console API, Log и debugger exceptions.
   */
  function appendLog(level: string, text: string): void {
    log.push({ level: level.slice(0, 20), text: text.slice(0, 2000) });

    if (log.length > 100) {
      log.shift();
    }
  }

  const webUrl = (raw: string) => {
    const url = browserUrl(raw);

    if (options.pipeOrigins().has(new URL(url).origin)) {
      throw new Error('browser_origin_forbidden');
    }

    return url;
  };
  const reset = () => {
    if (!disposed) {
      options.events.start();
    }
  };

  view.setBounds({
    x: 0,
    y: 0,
    width: 1280,
    height: 720
  });
  view.setVisible(false);
  // Скрытый guest остаётся вне дерева окна: setVisible(false) выключает рисование,
  // но прикреплённая страница всё ещё может забрать клавиатурный фокус при загрузке.
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let blocked = false;

    try {
      blocked = options.pipeOrigins().has(new URL(details.url).origin);
    } catch {
      blocked = true;
    }

    callback({ cancel: blocked });
  });
  contents.on('will-navigate', (event) => {
    try {
      webUrl(event.url);
    } catch {
      event.preventDefault();
    }
  });
  contents.on('will-redirect', (event) => {
    try {
      webUrl(event.url);
    } catch {
      event.preventDefault();
    }
  });
  contents.on('will-frame-navigate', (event) => {
    try {
      webUrl(event.url);
    } catch {
      event.preventDefault();
    }
  });
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame) {
      reset();
    }
  });
  contents.on('did-navigate', (_event, url) => {
    options.events.navigated(url === 'about:blank' ? '' : url);
  });
  contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
    if (mainFrame) {
      reset();
      options.events.navigated(url);
    }
  });
  contents.on('page-title-updated', (_event, title) => {
    options.events.metadata({ title: title.slice(0, 300) });
  });
  contents.on('did-start-loading', () => {
    options.events.metadata({ loading: true });
  });
  contents.on('did-stop-loading', () => {
    options.events.metadata({ loading: false });
  });
  contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) {
      options.events.navigated(contents.getURL() === 'about:blank' ? '' : contents.getURL());
      options.events.metadata({ loading: false, error: 'browser_load_failed' });
    }
  });
  contents.on('render-process-gone', () => {
    debuggerReady = false;
    options.events.lost();
    options.events.metadata({ loading: false, error: 'browser_renderer_gone' });
  });
  contents.setWindowOpenHandler(({ url }) => {
    try {
      options.events.popup(webUrl(url));
    } catch {
      // Неверный popup не создаёт окно, capability или внешнюю программу.
    }

    return { action: 'deny' };
  });
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return;
    }

    const key = input.key.toLowerCase();
    const intent = (input.control || input.meta) && ['l', 't', 'w'].includes(key)
      ? ({
        l: 'address',
        t: 'new',
        w: 'close'
      } as const)[key as 'l' | 't' | 'w']
      : input.alt && input.key === 'ArrowLeft' ? 'back'
        : input.alt && input.key === 'ArrowRight' ? 'forward' : null;

    if (intent) {
      event.preventDefault();
      options.events.intent(intent);
    }
  });

  try {
    contents.debugger.attach('1.3');
    debuggerReady = true;
    void Promise.all([
      contents.debugger.sendCommand('Runtime.enable'), contents.debugger.sendCommand('Log.enable'),
    ]).catch(() => {
      debuggerReady = false;
      options.events.lost();
    });
  } catch {
    options.events.metadata({ error: 'browser_debugger_unavailable' });
  }

  contents.debugger.on('detach', () => {
    debuggerReady = false;

    if (!disposed) {
      options.events.lost();
    }
  });
  contents.debugger.on('message', (_event, method, raw) => {
    if (!['Log.entryAdded', 'Runtime.exceptionThrown', 'Runtime.consoleAPICalled'].includes(method)
      || !isPlainRecord(raw)) {
      return;
    }

    if (method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(raw.args) ? raw.args.slice(0, 10) : [];
      const text = args.map((arg) => {
        if (!isPlainRecord(arg)) {
          return '';
        }

        return typeof arg.value === 'string' || typeof arg.value === 'number'
          || typeof arg.value === 'boolean' ? String(arg.value).slice(0, 2000)
          : typeof arg.description === 'string' ? arg.description.slice(0, 300) : '';
      }).join(' ');

      appendLog(String(raw.type ?? 'log'), text);

      return;
    }

    const entry = isPlainRecord(raw.entry) ? raw.entry : raw.exceptionDetails;

    if (isPlainRecord(entry)) {
      const exception = isPlainRecord(entry.exception) ? entry.exception : null;

      appendLog(String(entry.level ?? 'error'), String(exception?.description ?? entry.text ?? ''));
    }
  });

  /**
   * У скрытого WebContentsView может не быть compositor surface для capturePage.
   * CDP снимает только текущий viewport без показа вкладки и без захвата всего документа.
   */
  async function captureImage(send: Send): Promise<NativeImage> {
    try {
      const image = await contents.capturePage(undefined, { stayHidden: true });

      if (!image.isEmpty()) {
        return image;
      }
    } catch {
      // Отсутствующая native поверхность не означает недоступность живого документа.
    }

    if (disposed || !debuggerReady || !contents.debugger.isAttached()) {
      throw new Error('browser_debugger_unavailable');
    }

    const { cssVisualViewport: viewport } = await send('Page.getLayoutMetrics') as {
      cssVisualViewport?: unknown;
    };

    if (!isPlainRecord(viewport) || !['pageX', 'pageY', 'clientWidth', 'clientHeight']
      .every((key) => typeof viewport[key] === 'number' && Number.isFinite(viewport[key]))
      || Number(viewport.clientWidth) <= 0 || Number(viewport.clientHeight) <= 0) {
      throw new Error('browser_capture_failed');
    }

    const { data } = await send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 75,
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: viewport.pageX,
        y: viewport.pageY,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scale: Math.min(1, 1280 / Number(viewport.clientWidth)),
      },
    }) as { data?: unknown };

    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
      throw new Error('browser_capture_failed');
    }

    if (Buffer.byteLength(data, 'base64') > 2 * 1024 * 1024) {
      throw new Error('browser_image_too_large');
    }

    const image = options.imageFromBuffer(Buffer.from(data, 'base64'));

    if (image.isEmpty()) {
      throw new Error('browser_capture_failed');
    }

    return image;
  }

  /**
   * Скрытая страница отсоединяется от native-дерева, сохраняя документ и CDP.
   * Фокус возвращается интерфейсу только из этого guest в активном окне.
   */
  function hideView(): void {
    if (!attached) {
      return;
    }

    const alive = !window.isDestroyed();
    const returnToMain = alive && window.isFocused() && !contents.isDestroyed() && contents.isFocused();

    view.setVisible(false);

    if (alive) {
      window.contentView.removeChildView(view);
    }

    attached = false;

    if (returnToMain && !window.isDestroyed() && window.isFocused()) {
      window.webContents.focus();
    }
  }

  return {
    state: () => ({
      canBack: contents.navigationHistory.getActiveIndex() > 0,
      canForward: contents.navigationHistory.getActiveIndex() + 1 < contents.navigationHistory.length(),
      zoom: Math.round(contents.getZoomFactor() * 100),
    }),
    /**
     * Готовность документа достаточна для snapshot и ввода: внешние ресурсы могут висеть.
     * loadURL остаётся обработанным после dom-ready, а сетевой отказ получает стабильный код.
     */
    async navigate(raw) {
      const url = raw === '' ? 'about:blank' : webUrl(raw);

      reset();

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const ready = () => finish();
        const failed = () => finish('browser_load_failed');
        const lost = () => finish('browser_renderer_gone');

        /**
         * Первая готовность или ошибка завершает ожидание и снимает все listeners.
         * Поздний результат полной загрузки уже не меняет исход навигации.
         */
        const finish = (error?: string) => {
          if (settled) {
            return;
          }

          settled = true;
          contents.removeListener('dom-ready', ready);
          contents.removeListener('destroyed', lost);
          contents.removeListener('render-process-gone', lost);

          if (error) {
            reject(new Error(error));
          } else {
            resolve();
          }
        };

        contents.once('dom-ready', ready);
        contents.once('destroyed', lost);
        contents.once('render-process-gone', lost);

        try {
          void contents.loadURL(url).then(ready, failed);
        } catch {
          failed();
        }
      });
    },
    /**
     * Только видимая вкладка получает родителя в native-дереве окна.
     * Прикрепление сохраняет текущий фокус интерфейса, включая курсор поля чата.
     */
    show(rect: BrowserRect) {
      if (disposed || window.isDestroyed()) {
        return;
      }

      const preserveMainFocus = window.isFocused() && window.webContents.isFocused();

      view.setBounds(rect);

      if (!attached) {
        window.contentView.addChildView(view);
        attached = true;
      }

      view.setVisible(true);

      if (preserveMainFocus && !window.isDestroyed() && window.isFocused()) {
        window.webContents.focus();
      }
    },
    hide() {
      if (!disposed) {
        hideView();
      }
    },
    /**
     * Переход по истории проверяет целевой URL до native эффекта.
     * Выход за границы истории не меняет состояние текущей страницы.
     */
    history(direction) {
      const history = contents.navigationHistory;
      const target = history.getActiveIndex() + direction;

      if (target < 0 || target >= history.length()) {
        return;
      }

      const url = history.getEntryAtIndex(target).url;

      if (url !== 'about:blank') {
        webUrl(url);
      }

      reset();
      history.goToIndex(target);
    },
    /**
     * Повторная загрузка использует тот же URL guard, что навигация.
     * Перед эффектом прежние refs инвалидируются событием начала загрузки.
     */
    reload() {
      const url = contents.getURL();

      if (url !== 'about:blank') {
        webUrl(url);
      }

      reset();
      contents.reload();
    },
    zoom: (factor) => contents.setZoomFactor(factor),
    async send(method, params) {
      if (disposed || !debuggerReady || !contents.debugger.isAttached()) {
        throw new Error('browser_debugger_unavailable');
      }

      return contents.debugger.sendCommand(method, params as Record<string, unknown> | undefined);
    },
    /**
     * Снимок скрытой страницы ограничивается по ширине и размеру JPEG.
     * Превышение лимита возвращает отказ без передачи большого изображения.
     */
    async screenshot(send) {
      const image = await captureImage(send);
      const resized = image.getSize().width > 1280 ? image.resize({ width: 1280 }) : image;
      const jpeg = resized.toJPEG(75);

      if (jpeg.length > 2 * 1024 * 1024) {
        throw new Error('browser_image_too_large');
      }

      return jpeg.toString('base64');
    },
    console: () => structuredClone(log),
    /**
     * Повторное уничтожение не обращается к уже закрытым native объектам.
     * Поверхность скрывается до удаления из окна и закрытия WebContents.
     */
    destroy() {
      if (disposed) {
        return;
      }

      disposed = true;
      hideView();

      if (!contents.isDestroyed()) {
        contents.close();
      }
    },
  };
}
