import { createHash } from 'node:crypto';

import { browserFavicon, browserUrl } from '../../../shared/browser/browserContract.ts';
import { isPlainRecord } from '../../../shared/lib/objects.ts';

import type {
  BaseWindow, BaseWindowConstructorOptions, BrowserWindow, BrowserWindowConstructorOptions, NativeImage,
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
    favicon?: string | null;
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
  preview(): string | null;
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
      /**
       * Вкладки агентов работают в фоне: приостановленный рендерер не принимает
       * синтетический ввод и не отдаёт кадр для снимка — команда висит до
       * таймаута транспорта. Отключение throttling держит страницу активной.
       */
      backgroundThrottling: false,
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
  captureWindow(value: BaseWindowConstructorOptions): BaseWindow;
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
  let faviconRead: AbortController | null = null;
  let attached = false;
  let captureHost: BaseWindow | null = null;
  let captureJobs = 0;
  let captureReads = 0;
  let lastFrame: NativeImage | null = null;
  let frameSubscription = 0;
  let frameGeneration = 0;

  /**
   * Храним только последний реально представленный кадр видимой вкладки.
   * Это подложка DOM-слоя, а не агентский screenshot с перерисовкой через CDP.
   */
  function subscribeFrames(): void {
    if (frameSubscription) {
      return;
    }

    const subscription = ++frameGeneration;

    frameSubscription = subscription;

    try {
      contents.beginFrameSubscription((frame) => {
        if (!disposed && attached && frameSubscription === subscription) {
          lastFrame = frame;
        }
      });
    } catch {
      // Необязательная подложка не мешает показу и вводу самой страницы.
      frameSubscription = 0;
    }
  }

  /**
   * Скрытая вкладка больше не копирует кадры. Поздний callback прежней подписки
   * не заполняет подложку после повторного показа или перехода на другую страницу.
   */
  function unsubscribeFrames(): void {
    const subscribed = frameSubscription !== 0;

    frameSubscription = 0;
    lastFrame = null;

    if (subscribed && !contents.isDestroyed()) {
      contents.endFrameSubscription();
    }
  }

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
      lastFrame = null;
      options.events.start();
    }
  };

  /**
   * Иконку читаем в session сайта, сохраняя его cookies вне документа GrigDesk.
   * Навигация, новая иконка и закрытие отменяют чтение; поздний ответ не меняет новую страницу.
   */
  async function updateFavicon(urls: string[]): Promise<void> {
    faviconRead?.abort();

    const read = new AbortController();

    faviconRead = read;
    options.events.metadata({ favicon: null });

    try {
      const source = urls[0];

      if (!source || disposed) {
        return;
      }

      let favicon = browserFavicon(source);

      if (!favicon) {
        const response = await contents.session.fetch(webUrl(source), {
          signal: AbortSignal.any([read.signal, AbortSignal.timeout(3000)]),
          redirect: 'error',
        });
        const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        const reader = response.body?.getReader();

        if (!response.ok || !reader) {
          return;
        }

        const chunks: Uint8Array[] = [];
        let size = 0;

        while (true) {
          const chunk = await reader.read();

          if (chunk.done) {
            break;
          }

          size += chunk.value.length;

          if (size > 256 * 1024) {
            read.abort();

            return;
          }

          chunks.push(chunk.value);
        }

        favicon = browserFavicon(`data:${type};base64,${Buffer.concat(chunks).toString('base64')}`);
      }

      if (!disposed && faviconRead === read && !read.signal.aborted) {
        options.events.metadata({ favicon });
      }
    } catch {
      // Недоступная иконка оставляет глобус, не меняя состояние загрузки страницы.
    } finally {
      read.abort();

      if (faviconRead === read) {
        faviconRead = null;
      }
    }
  }

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
      if (!event.isSameDocument) {
        void updateFavicon([]);
      }

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
  contents.on('page-favicon-updated', (_event, urls) => {
    void updateFavicon(urls);
  });
  contents.on('did-start-loading', () => {
    options.events.metadata({ loading: true });
  });
  contents.on('did-stop-loading', () => {
    /**
     * Отмена навигации (ERR_ABORTED, загрузка файла) не даёт did-navigate.
     * После остановки всех загрузок фиксируем фактический URL: иначе navigating
     * остаётся навсегда и следующий запрос ошибочно получает access_revoked.
     */
    if (!disposed && !contents.isLoadingMainFrame()) {
      options.events.navigated(contents.getURL() === 'about:blank' ? '' : contents.getURL());
    }

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
   * Служебная поверхность никогда не показывается и не получает фокус окна.
   * Перед передачей guest главному окну освобождаем прежнего native-родителя;
   * поздний finally снимка уже не сможет скрыть выбранную человеком вкладку.
   */
  function releaseCaptureHost(): void {
    const host = captureHost;

    if (!host) {
      return;
    }

    captureHost = null;
    view.setVisible(false);

    if (!host.isDestroyed()) {
      host.contentView.removeChildView(view);
      host.destroy();
    }
  }

  /**
   * Таймаут команды не отменяет захват внутри Chromium. Поверхность остаётся
   * доступной до фактического ответа, иначе ожидаемый кадр теряет родителя.
   */
  function releaseIdleCaptureHost(): void {
    if (captureJobs === 0 && captureReads === 0 && captureHost) {
      releaseCaptureHost();
    }
  }

  /**
   * Учитываем исходный Promise Electron, а не ограниченное ожидание команды.
   * Поздний ответ освобождает только служебный host и не скрывает главное окно.
   */
  async function captureRead<T>(read: () => Promise<T>): Promise<T> {
    captureReads += 1;

    try {
      return await read();
    } finally {
      captureReads -= 1;
      releaseIdleCaptureHost();
    }
  }

  /**
   * Отсоединённому guest нужен compositor с native-родителем. Даём ему скрытый
   * BaseWindow без собственного WebContents: документ, session и grant остаются
   * прежними, а содержимое не входит в дерево главного окна даже на один кадр.
   */
  function prepareCaptureHost(): BaseWindow | null {
    if (attached) {
      return null;
    }

    if (captureHost) {
      return captureHost;
    }

    const { width, height } = view.getBounds();
    const host = options.captureWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      frame: false,
      width,
      height,
    });

    captureHost = host;

    try {
      host.contentView.addChildView(view);
      view.setBounds({
        x: 0,
        y: 0,
        width,
        height,
      });
      view.setVisible(true);
    } catch (error) {
      releaseCaptureHost();

      throw error;
    } finally {
      contents.setBackgroundThrottling(false);
    }

    return host;
  }

  /**
   * Native capture будит скрытую поверхность, но может вернуть её прежний кадр.
   * Результат берём только через CDP: этот путь запрашивает перерисовку renderer
   * перед копированием. Clip и full-page режим не включаем: они меняют размеры
   * renderer, которые поздний ответ мог бы восстановить поверх нового layout.
   */
  async function captureImage(send: Send): Promise<NativeImage> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        captureRead(() => contents.capturePage(undefined, { stayHidden: false })).catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
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

    const pending = send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 75,
      fromSurface: true,
      captureBeyondViewport: false,
    });

    const { data } = await pending as { data?: unknown };

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
    unsubscribeFrames();

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

    if (!disposed && (captureJobs > 0 || captureReads > 0)) {
      prepareCaptureHost();
    }

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

      releaseCaptureHost();

      // Синхронизируем скрытый виджет Chromium перед повторным прикреплением.
      // Настройка фоновой работы восстанавливается в том же синхронном вызове.
      const reattaching = !attached;

      if (reattaching) {
        contents.setBackgroundThrottling(true);
      }

      try {
        if (!attached) {
          window.contentView.addChildView(view);
          attached = true;
        }

        const previous = view.getBounds();

        if (previous.width !== rect.width || previous.height !== rect.height) {
          lastFrame = null;
        }

        view.setBounds(rect);
        view.setVisible(true);
        subscribeFrames();
      } finally {
        if (reattaching) {
          contents.setBackgroundThrottling(false);
        }
      }

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
    /**
     * Подложка берётся до синхронного hide и не запускает новый захват Chromium.
     * Ограничиваем JPEG для IPC; пустой или уже скрытый guest кадра не отдаёт.
     */
    preview() {
      if (!attached || disposed || !lastFrame || lastFrame.isEmpty()) {
        return null;
      }

      const image = lastFrame.getSize().width > 1280 ? lastFrame.resize({ width: 1280 }) : lastFrame;
      const jpeg = image.toJPEG(75);

      return jpeg.length <= 2 * 1024 * 1024 ? jpeg.toString('base64') : null;
    },
    /**
     * Захват CDP удерживает служебную поверхность до реального ответа Electron.
     * Срок и права команды проверяет внешний send, не отменяющий этот Promise.
     */
    async send(method, params) {
      if (disposed || !debuggerReady || !contents.debugger.isAttached()) {
        throw new Error('browser_debugger_unavailable');
      }

      const read = () => contents.debugger.sendCommand(method, params as Record<string, unknown> | undefined);

      return method === 'Page.captureScreenshot' ? captureRead(read) : read();
    },
    /**
     * Снимок скрытой страницы ограничивается по ширине и размеру JPEG.
     * Превышение лимита возвращает отказ без передачи большого изображения.
     */
    async screenshot(send) {
      if (captureReads > 0 || captureJobs > 0) {
        throw new Error('browser_capture_failed');
      }

      captureJobs += 1;

      try {
        prepareCaptureHost();

        const image = await captureImage(send);
        const resized = image.getSize().width > 1280 ? image.resize({ width: 1280 }) : image;
        const jpeg = resized.toJPEG(75);

        if (jpeg.length > 2 * 1024 * 1024) {
          throw new Error('browser_image_too_large');
        }

        return jpeg.toString('base64');
      } finally {
        captureJobs -= 1;
        releaseIdleCaptureHost();
      }
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
      faviconRead?.abort();
      hideView();
      releaseCaptureHost();

      if (!contents.isDestroyed()) {
        contents.close();
      }
    },
  };
}
