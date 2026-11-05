import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setImmediate as nextLoop } from 'node:timers/promises';

import {
  browserChildWindowOptions, browserViewOptions, createNativeBrowserView,
} from '../../desktop/src/browser/browserView.ts';
import { guardContents } from '../../desktop/src/windowSecurity.ts';

import type { BaseWindow, BrowserWindow, NativeImage, WebContentsView } from 'electron';

/**
 * Fake хранит реальные вызовы Electron adapter, не повторяя его guards.
 * Cast нужен только вместо огромных Electron interfaces, модельные параметры не кастуются.
 */
function fixture(options: {
  pendingLoad?: boolean;
  failedCapture?: boolean;
  emptyCapture?: boolean;
  pendingCapture?: boolean;
  failedFreshCapture?: boolean;
  pendingFreshCapture?: boolean;
  failedAttach?: boolean;
  failedCaptureAttach?: boolean;
  favicon?(url: string, init?: RequestInit): Promise<Response>;
} = {}) {
  const calls: unknown[] = [];
  const metadata: { favicon?: string | null }[] = [];
  const contents = new EventEmitter();
  const debuggerPort = new EventEmitter();
  const frames: ((image: NativeImage) => void)[] = [];
  let opener: ((input: { url: string }) => unknown) | null = null;

  type Network = (details: { url: string }, callback: (value: { cancel: boolean }) => void) => void;

  let network: Network | null = null;
  let visible = false;
  let attached = false;
  let captureAttached = false;
  let captureDestroyed = true;
  let focused: 'main' | 'guest' | 'outside' = 'main';
  let bounds = {
    x: 0,
    y: 0,
    width: 0,
    height: 0
  };
  let url = '';
  let active = 0;
  let zoom = 1;
  const history = ['http://fixture.test/', 'http://pipe.test/'];
  let finishLoad = () => {};
  let failLoad = (_error: Error) => {};
  const pendingLoad = new Promise<void>((resolve, reject) => {
    finishLoad = resolve;
    failLoad = reject;
  });
  let finishCapture = () => {};
  const pendingCapture = new Promise<void>((resolve) => {
    finishCapture = resolve;
  });
  let finishFreshCapture = () => {};
  const pendingFreshCapture = new Promise<void>((resolve) => {
    finishFreshCapture = resolve;
  });
  const nativeImage = {
    isEmpty: () => false,
    getSize: () => ({ width: 2000, height: 1000 }),
    resize: (options: unknown) => {
      calls.push(['resize-image', options]);

      return nativeImage;
    },
    toJPEG: (quality: number) => {
      calls.push(['jpeg', quality]);

      return Buffer.from('fixture');
    },
  } as unknown as NativeImage;
  const webContents = Object.assign(contents, {
    session: {
      fetch: options.favicon ?? (async () => new Response('icon', {
        headers: { 'content-type': 'image/png' },
      })),
      setPermissionCheckHandler: (handler: () => boolean) => {
        calls.push(['permission-check', handler()]);
      },
      setPermissionRequestHandler: (handler: (
        wc: null, permission: string, reply: (allow: boolean) => void,
      ) => void) => {
        handler(null, 'media', (allow) => calls.push(['permission-request', allow]));
      },
      webRequest: {
        onBeforeRequest: (_filter: unknown, callback: Network) => {
          network = callback;
        },
      },
    },
    debugger: Object.assign(debuggerPort, {
      attach: () => {},
      isAttached: () => true,
      sendCommand: async (method: string, params: unknown) => {
        calls.push([method, params]);

        if (method === 'Page.captureScreenshot' && options.failedFreshCapture) {
          throw new Error('browser_capture_failed');
        }

        if (method === 'Page.captureScreenshot' && options.pendingFreshCapture) {
          await pendingFreshCapture;
        }

        if (method === 'Page.getLayoutMetrics') {
          return { cssVisualViewport: {
            pageX: 20,
            pageY: 300,
            clientWidth: 2000,
            clientHeight: 1000,
          } };
        }

        return method === 'Page.captureScreenshot' ? { data: 'Zml4dHVyZQ==' } : {};
      },
    }),
    setWindowOpenHandler: (value: typeof opener) => {
      opener = value;
    },
    loadURL: async (value: string) => {
      url = value;
      calls.push(['load', value]);

      if (options.pendingLoad) {
        await pendingLoad;
      }
    },
    getURL: () => url,
    isLoadingMainFrame: () => false,
    setZoomFactor: (factor: number) => {
      zoom = factor;
      calls.push(['zoom', factor]);
    },
    getZoomFactor: () => zoom,
    setBackgroundThrottling: (value: boolean) => calls.push(['throttling', value]),
    beginFrameSubscription: (callback: (image: NativeImage) => void) => {
      frames.push(callback);
    },
    endFrameSubscription: () => calls.push(['unsubscribe-frames']),
    capturePage: async (...args: unknown[]) => {
      calls.push(['capture', ...args]);

      if (options.pendingCapture) {
        await pendingCapture;
      }

      if (options.failedCapture) {
        throw new Error('Failed to capture page');
      }

      return options.emptyCapture ? { isEmpty: () => true } as NativeImage : {
        ...nativeImage,
        getSize: () => ({ width: 1280, height: 720 }),
        toJPEG: () => Buffer.from('stale-native-frame'),
      } as unknown as NativeImage;
    },
    close: () => calls.push(['close']),
    isDestroyed: () => false,
    isFocused: () => focused === 'guest',
    reload: () => calls.push(['reload']),
    navigationHistory: {
      getActiveIndex: () => active,
      length: () => history.length,
      getEntryAtIndex: (index: number) => ({ url: history[index]!, title: '' }),
      goToIndex: (index: number) => {
        active = index;
        calls.push(['history', index]);
      },
    },
  });
  const view = {
    webContents,
    getBounds: () => bounds,
    setBounds: (value: typeof bounds) => {
      bounds = value;
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
  } as unknown as WebContentsView;
  const window = {
    isDestroyed: () => false,
    isFocused: () => focused !== 'outside',
    webContents: {
      isFocused: () => focused === 'main',
      focus: () => {
        focused = 'main';
        calls.push(['focus-main']);
      },
    },
    contentView: {
      addChildView: () => {
        if (options.failedAttach) {
          throw new Error('fixture_attach_failed');
        }

        attached = true;
        focused = 'guest';
        calls.push(['add']);
      },
      removeChildView: () => {
        attached = false;
        calls.push(['remove']);
      },
    },
  } as unknown as BrowserWindow;
  const adapter = createNativeBrowserView({
    machine: 'fixture-machine',
    scope: 'fixture-owner',
    create: () => view,
    captureWindow: (value) => {
      calls.push(['capture-window', value]);
      captureDestroyed = false;

      return {
        isDestroyed: () => captureDestroyed,
        destroy: () => {
          assert.equal(captureAttached, false, 'guest снимается до уничтожения поверхности');
          captureDestroyed = true;
          calls.push(['capture-destroy']);
        },
        contentView: {
          addChildView: () => {
            if (options.failedCaptureAttach) {
              throw new Error('fixture_capture_attach_failed');
            }

            captureAttached = true;
            calls.push(['capture-add']);
          },
          removeChildView: () => {
            captureAttached = false;
            calls.push(['capture-remove']);
          },
        },
      } as unknown as BaseWindow;
    },
    imageFromBuffer: () => nativeImage,
    window: () => window,
    pipeOrigins: () => new Set(['http://pipe.test']),
    events: {
      start: () => calls.push(['start']),
      navigated: (target) => calls.push(['navigated', target]),
      metadata: (value) => metadata.push(value),
      lost: () => calls.push(['lost']),
      popup: (target) => calls.push(['popup', target]),
      intent: (intent) => calls.push(['intent', intent]),
    },
  });

  return {
    adapter,
    metadata,
    contents,
    debuggerPort,
    calls,
    frames,
    frame: (text: string) => ({
      ...nativeImage,
      getSize: () => ({ width: 800, height: 600 }),
      toJPEG: () => Buffer.from(text),
    }) as unknown as NativeImage,
    finishLoad,
    failLoad,
    finishCapture,
    finishFreshCapture,
    captureAttached: () => captureAttached,
    captureDestroyed: () => captureDestroyed,
    visible: () => visible,
    attached: () => attached,
    focused: () => focused,
    focus: (target: typeof focused) => {
      focused = target;
    },
    bounds: () => bounds,
    popup: (target: string) => opener!({ url: target }),
    network: (target: string) => {
      let cancelled = false;

      network!({ url: target }, (value) => {
        cancelled = value.cancel;
      });

      return cancelled;
    },
  };
}

test('BR-V-favicon: иконка читается в session сайта и передаётся встроенным изображением', async (t) => {
  const requests: string[] = [];
  const f = fixture({ favicon: async (url) => {
    requests.push(url);

    return new Response('icon', { headers: { 'content-type': 'image/x-icon' } });
  } });

  t.after(() => f.adapter.destroy());
  f.contents.emit('page-favicon-updated', {}, ['https://fixture.test/favicon.ico']);
  await nextLoop();
  assert.deepEqual(requests, ['https://fixture.test/favicon.ico']);
  assert.equal(f.metadata.at(-1)?.favicon, 'data:image/x-icon;base64,aWNvbg==');

  f.contents.emit('page-favicon-updated', {}, ['http://pipe.test/api/private']);
  await nextLoop();
  assert.equal(requests.length, 1);
  assert.equal(f.metadata.at(-1)?.favicon, null);
});

test('BR-V-favicon-navigation: поздняя иконка не попадает на новую страницу', async (t) => {
  const pending = Promise.withResolvers<Response>();
  const f = fixture({ favicon: () => pending.promise });

  t.after(() => f.adapter.destroy());
  f.contents.emit('page-favicon-updated', {}, ['https://fixture.test/old.png']);
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  pending.resolve(new Response('old', { headers: { 'content-type': 'image/png' } }));
  await nextLoop();
  assert.equal(f.metadata.at(-1)?.favicon, null);

  f.contents.emit('page-favicon-updated', {}, ['data:image/svg+xml;base64,AQ==']);
  await nextLoop();
  assert.equal(f.metadata.at(-1)?.favicon, 'data:image/svg+xml;base64,AQ==');
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.equal(f.metadata.at(-1)?.favicon, 'data:image/svg+xml;base64,AQ==');
});

test('BR-V-favicon-failure: ошибка, чужой тип и большая иконка оставляют глобус', async (t) => {
  for (const response of [
    new Response('missing', { status: 404 }),
    new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    new Response(new Uint8Array(256 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
  ]) {
    const f = fixture({ favicon: async () => response });

    t.after(() => f.adapter.destroy());
    f.contents.emit('page-favicon-updated', {}, ['https://fixture.test/favicon.png']);
    await nextLoop();
    assert.equal(f.metadata.at(-1)?.favicon, null);
  }
});

test('BR-V-preview: подложка хранит показанный кадр, не захватывает скрытый guest', () => {
  const f = fixture();
  const rect = {
    x: 10,
    y: 20,
    width: 800,
    height: 600,
  };

  assert.equal(f.frames.length, 0);
  assert.equal(f.adapter.preview(), null);
  f.adapter.show(rect);
  f.adapter.show(rect);
  assert.equal(f.frames.length, 1, 'повторный layout не заводит новую подписку');
  assert.equal(f.adapter.preview(), null);
  f.frames[0]!(f.frame('shown-page'));
  assert.equal(f.adapter.preview(), Buffer.from('shown-page').toString('base64'));
  assert.equal(f.calls.some((call) => JSON.stringify(call).includes('capture')), false);
  f.adapter.hide();
  assert.equal(f.adapter.preview(), null);
  assert.equal(f.calls.filter((call) => JSON.stringify(call) === '["unsubscribe-frames"]').length, 1);
  f.adapter.show(rect);
  f.frames[0]!(f.frame('late-old-page'));
  assert.equal(f.adapter.preview(), null, 'поздний кадр прошлой подписки игнорируется');
  f.frames[1]!(f.frame('current-page'));
  assert.equal(f.adapter.preview(), Buffer.from('current-page').toString('base64'));
  f.adapter.show({ ...rect, width: 600 });
  assert.equal(f.adapter.preview(), null, 'новая геометрия не использует прежний кадр');
  f.adapter.destroy();
  f.frames[1]!(f.frame('closed-page'));
  assert.equal(f.adapter.preview(), null);
});

test('BR-V-focus-background: навигация и команды скрытой страницы не забирают ввод у чата', async () => {
  const f = fixture();

  await f.adapter.navigate('http://fixture.test/background');
  await f.adapter.send('Input.insertText', { text: 'тестовый ввод' });
  await f.adapter.screenshot(f.adapter.send);
  f.adapter.hide();

  assert.equal(f.attached(), false, 'фоновый guest не принадлежит дереву главного окна');
  assert.equal(f.focused(), 'main');
  assert.equal(f.calls.some((call) => JSON.stringify(call) === '["add"]'), false);
  f.adapter.destroy();
  assert.equal(f.calls.some((call) => JSON.stringify(call) === '["remove"]'), false);
});

test('BR-V-focus-visible: показ сохраняет ввод интерфейса, скрытие возвращает его из guest', () => {
  const f = fixture();
  const rect = {
    x: 5,
    y: 6,
    width: 700,
    height: 500
  };

  f.adapter.show(rect);
  assert.equal(f.attached(), true);
  assert.equal(f.focused(), 'main', 'прикрепление view не забирает текущий ввод интерфейса');
  assert.deepEqual(f.calls.filter((call) => Array.isArray(call) && call[0] === 'throttling'),
    [['throttling', true], ['throttling', false]]);

  f.focus('guest');
  f.adapter.show(rect);
  assert.equal(f.focused(), 'guest', 'повторный layout сохраняет явный фокус сайта');
  assert.equal(f.calls.filter((call) => JSON.stringify(call) === '["add"]').length, 1);
  assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'throttling').length, 2);

  f.adapter.hide();
  assert.equal(f.attached(), false);
  assert.equal(f.focused(), 'main');
  f.adapter.hide();
  assert.equal(f.calls.filter((call) => JSON.stringify(call) === '["remove"]').length, 1);

  f.focus('outside');
  f.adapter.show(rect);
  f.focus('outside');
  f.adapter.hide();
  assert.equal(f.focused(), 'outside', 'скрытие не активирует окно поверх другого приложения');
  f.adapter.destroy();
});

test('BR-V-show-failure: отказ прикрепления не оставляет фоновую страницу throttled', () => {
  const f = fixture({ failedAttach: true });
  const rect = {
    x: 5,
    y: 6,
    width: 700,
    height: 500,
  };

  assert.throws(() => f.adapter.show(rect), /fixture_attach_failed/u);
  assert.equal(f.attached(), false);
  assert.equal(f.focused(), 'main');
  assert.deepEqual(f.calls.filter((call) => Array.isArray(call) && call[0] === 'throttling'),
    [['throttling', true], ['throttling', false]]);
  f.adapter.destroy();
});

test('BR-V-focus-close: закрытие видимого guest возвращает ввод и снимает native-родителя один раз', () => {
  const f = fixture();

  f.adapter.show({
    x: 5,
    y: 6,
    width: 700,
    height: 500
  });
  f.focus('guest');
  f.adapter.destroy();
  f.adapter.destroy();

  assert.equal(f.attached(), false);
  assert.equal(f.focused(), 'main');
  assert.equal(f.calls.filter((call) => JSON.stringify(call) === '["remove"]').length, 1);
  assert.equal(f.calls.filter((call) => JSON.stringify(call) === '["close"]').length, 1);
});

test('BR-V-capture-attach: отказ скрытой поверхности сохраняет фоновые команды и фокус', async () => {
  const f = fixture({ failedCaptureAttach: true });

  await assert.rejects(f.adapter.screenshot(f.adapter.send), /fixture_capture_attach_failed/u);
  assert.equal(f.captureDestroyed(), true);
  assert.equal(f.captureAttached(), false);
  assert.equal(f.attached(), false);
  assert.equal(f.focused(), 'main');
  assert.deepEqual(f.calls.filter((call) => Array.isArray(call) && call[0] === 'throttling'),
    [['throttling', false]]);
  await f.adapter.send('Runtime.evaluate', { expression: 'document.readyState' });
  f.adapter.destroy();
});

test('BR-V-capture-switch: показ во время снимка переносит guest без позднего hide', async () => {
  const f = fixture({ pendingCapture: true });
  const pending = f.adapter.screenshot(f.adapter.send);
  const rect = {
    x: 10,
    y: 20,
    width: 700,
    height: 500,
  };

  assert.equal(f.attached(), false);
  assert.equal(f.captureAttached(), true);
  assert.equal(f.focused(), 'main');
  f.adapter.show(rect);
  assert.equal(f.captureDestroyed(), true);
  assert.equal(f.captureAttached(), false);
  assert.equal(f.attached(), true);
  f.finishCapture();
  await pending;
  assert.equal(f.visible(), true);
  assert.equal(f.attached(), true);
  assert.equal(f.focused(), 'main');
  assert.deepEqual(f.bounds(), rect);
  f.adapter.destroy();
});

test('BR-V-capture-close: закрытие во время снимка освобождает служебную поверхность', async () => {
  const f = fixture({ pendingCapture: true });
  const pending = f.adapter.screenshot(f.adapter.send);

  f.adapter.destroy();
  assert.equal(f.captureDestroyed(), true);
  assert.equal(f.captureAttached(), false);
  assert.equal(f.visible(), false);
  f.finishCapture();
  await assert.rejects(pending, /browser_debugger_unavailable/u);
  assert.equal(f.calls.filter((call) => JSON.stringify(call) === '["capture-destroy"]').length, 1);
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === 'Page.captureScreenshot'), false);
});

test('BR-V01: безопасные options, hidden default viewport и правильный capturePage API', async () => {
  const options = browserViewOptions('machine-a', 'owner-a').webPreferences!;

  assert.equal(options.sandbox, true);
  assert.equal(options.contextIsolation, true);
  assert.equal(options.nodeIntegration, false);
  assert.equal('preload' in options, false);
  assert.notEqual(options.partition, browserViewOptions('machine-a', 'owner-b').webPreferences!.partition);

  const f = fixture();

  assert.equal(f.visible(), false);
  assert.deepEqual(f.bounds(), {
    x: 0,
    y: 0,
    width: 1280,
    height: 720
  });
  await f.adapter.screenshot(f.adapter.send);
  assert.equal(f.captureDestroyed(), true);
  assert.deepEqual(f.calls.find((call) => Array.isArray(call) && call[0] === 'capture-window'),
    ['capture-window', {
      show: false,
      focusable: false,
      skipTaskbar: true,
      frame: false,
      width: 1280,
      height: 720,
    }]);
  f.adapter.show({
    x: 5,
    y: 6,
    width: 700,
    height: 500
  });
  assert.equal(f.visible(), true);
  await f.adapter.screenshot(f.adapter.send);
  assert.ok(f.calls.some((call) => JSON.stringify(call)
    === '["capture",null,{"stayHidden":false}]'));
  f.adapter.hide();
  assert.equal(f.visible(), false);
  f.adapter.zoom(1.5);
  assert.equal(f.adapter.state().zoom, 150);
  f.adapter.destroy();
  f.adapter.destroy();
  assert.equal(f.calls.filter((call) => JSON.stringify(call) === '["close"]').length, 1);
});

test('BR-V01B: готовый DOM открывается до завершения медленного ресурса', async (t) => {
  const f = fixture({ pendingLoad: true });
  let ready = false;

  t.after(() => {
    f.finishLoad();
    f.adapter.destroy();
  });

  const navigation = f.adapter.navigate('http://fixture.test/slow').then(() => {
    ready = true;
  });

  f.contents.emit('dom-ready');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ready, true, 'DOM готов, но navigate продолжает ждать внешние ресурсы');
  await navigation;
});

test('BR-V01C: отказ loadURL до готовности DOM даёт точный код и снимает listener', async () => {
  const f = fixture({ pendingLoad: true });
  const navigation = f.adapter.navigate('http://fixture.test/failure');

  f.failLoad(new Error('net::ERR_NAME_NOT_RESOLVED'));
  await assert.rejects(navigation, /browser_load_failed/u);
  assert.equal(f.contents.listenerCount('dom-ready'), 0);
  f.adapter.destroy();
});

test('BR-V-abort: отменённая навигация завершается текущим URL после остановки загрузки', async () => {
  const f = fixture();

  await f.adapter.navigate('http://fixture.test/original');
  f.calls.length = 0;
  f.contents.emit('did-start-navigation', { isMainFrame: true });
  f.contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://fixture.test/cancelled', true);
  f.contents.emit('did-stop-loading');
  assert.deepEqual(f.calls, [['start'], ['navigated', 'http://fixture.test/original']]);
  f.adapter.destroy();
});

test('BR-V01D: снимок берёт свежий кадр CDP вместо прежнего, пустого или упавшего native', async (t) => {
  for (const options of [{}, { failedCapture: true }, { emptyCapture: true }]) {
    const f = fixture(options);

    t.after(() => f.adapter.destroy());
    assert.equal(await f.adapter.screenshot(f.adapter.send), Buffer.from('fixture').toString('base64'));
    assert.equal(f.visible(), false);

    const capture = f.calls.find((call) => Array.isArray(call) && call[0] === 'Page.captureScreenshot');

    assert.deepEqual(capture, ['Page.captureScreenshot', {
      format: 'jpeg',
      quality: 75,
      fromSurface: true,
      captureBeyondViewport: false,
    }]);
  }
});

test('BR-V-capture-fresh: отказ свежего кадра не подменяется успешной старой native-копией', async () => {
  const f = fixture({ failedFreshCapture: true });

  await assert.rejects(f.adapter.screenshot(f.adapter.send), /browser_capture_failed/u);
  assert.equal(f.captureDestroyed(), true);
  assert.equal(f.captureAttached(), false);
  assert.equal(f.visible(), false);
  f.adapter.destroy();
});

test('BR-V-capture-timeout: поверхность живёт до ответа Chromium после таймаута команды', async () => {
  const f = fixture({ pendingFreshCapture: true });
  let raw: Promise<unknown> | undefined;
  const send: typeof f.adapter.send = async (method, params) => {
    if (method === 'Page.captureScreenshot') {
      raw = f.adapter.send(method, params);

      throw new Error('browser_capture_failed');
    }

    return f.adapter.send(method, params);
  };

  await assert.rejects(f.adapter.screenshot(send), /browser_capture_failed/u);
  assert.equal(f.captureDestroyed(), false);
  assert.equal(f.captureAttached(), true);
  assert.equal(f.attached(), false);
  await assert.rejects(f.adapter.screenshot(f.adapter.send), /browser_capture_failed/u);
  assert.equal(f.calls.filter((call) => Array.isArray(call)
    && call[0] === 'Page.captureScreenshot').length, 1);
  f.finishFreshCapture();
  await raw;
  assert.equal(f.captureDestroyed(), true);
  assert.equal(f.captureAttached(), false);
  assert.equal(f.visible(), false);
  f.adapter.destroy();
});

test('BR-V-capture-layout: скрытие и новый layout переживают фактическое завершение CDP', async () => {
  const f = fixture({ pendingFreshCapture: true });
  const first = {
    x: 10,
    y: 20,
    width: 700,
    height: 500,
  };
  const next = {
    x: 30,
    y: 40,
    width: 900,
    height: 600,
  };

  f.adapter.show(first);

  const pending = f.adapter.screenshot(f.adapter.send);

  await new Promise<void>((resolve) => setImmediate(resolve));
  f.adapter.hide();
  assert.equal(f.attached(), false);
  assert.equal(f.captureAttached(), true);
  f.adapter.show(next);
  f.finishFreshCapture();
  await pending;
  assert.equal(f.captureDestroyed(), true);
  assert.equal(f.captureAttached(), false);
  assert.equal(f.attached(), true);
  assert.equal(f.visible(), true);
  assert.deepEqual(f.bounds(), next);
  f.adapter.destroy();
});

test('BR-V01E: поздний отказ ресурса после dom-ready не отклоняет открытую страницу', async (t) => {
  const f = fixture({ pendingLoad: true });
  const navigation = f.adapter.navigate('http://fixture.test/slow');

  t.after(() => f.adapter.destroy());
  f.contents.emit('dom-ready');
  await navigation;
  f.failLoad(new Error('net::ERR_ABORTED'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.contents.listenerCount('dom-ready'), 0);
});

test('BR-V01F: закрытие вкладки до dom-ready завершает ожидание и снимает listeners', async (t) => {
  const f = fixture({ pendingLoad: true });
  const navigation = f.adapter.navigate('http://fixture.test/slow');

  t.after(() => {
    f.finishLoad();
    f.adapter.destroy();
  });

  f.contents.emit('destroyed');
  await assert.rejects(navigation, /browser_renderer_gone/u);
  assert.equal(f.contents.listenerCount('dom-ready'), 0);
  assert.equal(f.contents.listenerCount('destroyed'), 0);
});

test('BR-V02: pipe origin запрещён для load/history/popup/request, медиа отклонены', async () => {
  const f = fixture();

  await assert.rejects(() => f.adapter.navigate('http://pipe.test/private'), /browser_origin_forbidden/u);
  assert.throws(() => f.adapter.history(1), /browser_origin_forbidden/u);
  assert.deepEqual(f.popup('http://pipe.test/'), { action: 'deny' });
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === 'popup'), false);
  assert.equal(f.network('http://pipe.test/__shell/state'), true);
  assert.equal(f.network('http://fixture.test/'), false);
  assert.ok(f.calls.some((call) => JSON.stringify(call) === '["permission-request",false]'));
  await f.adapter.navigate('http://fixture.test/');
  assert.deepEqual(f.popup('http://other.test/'), { action: 'deny' });
  assert.ok(f.calls.some((call) => JSON.stringify(call) === '["popup","http://other.test/"]'));
  f.adapter.destroy();
});

test('BR-V03: Chromium navigation/console/crash/shortcut events обновляют runtime port', () => {
  const f = fixture();
  let prevented = false;

  f.contents.emit('did-start-navigation', { isMainFrame: true });
  f.contents.emit('did-navigate', {}, 'http://fixture.test/next');
  f.debuggerPort.emit('message', {}, 'Runtime.consoleAPICalled', {
    type: 'error', args: [{ type: 'string', value: 'fixture-console' }],
  });
  f.contents.emit('before-input-event', { preventDefault: () => {
    prevented = true;
  } }, {
    type: 'keyDown',
    key: 'w',
    control: true,
  });
  assert.equal(prevented, true);
  assert.deepEqual(f.adapter.console(), [{ level: 'error', text: 'fixture-console' }]);
  f.contents.emit('render-process-gone');
  assert.ok(f.calls.some((call) => JSON.stringify(call) === '["lost"]'));
  assert.ok(f.calls.some((call) => JSON.stringify(call) === '["intent","close"]'));
  f.adapter.destroy();
});

test('BR-V03B: console API args и кольцевой buffer ограничены без чтения object properties', () => {
  const f = fixture();

  for (let index = 0; index < 120; index += 1) {
    f.debuggerPort.emit('message', {}, 'Runtime.consoleAPICalled', {
      type: 'error', args: [{ value: 'x'.repeat(5000) }, { objectId: 'opaque', description: 'Object' }],
    });
  }

  assert.equal(f.adapter.console().length, 100);
  assert.equal(f.adapter.console().every((row) => row.text.length <= 2000), true);
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === 'Runtime.getProperties'), false);
  f.adapter.destroy();
});

test('BR-V04: main preload снимается до существующего same-origin window.open override', () => {
  const contents = new EventEmitter() as EventEmitter & {
    setWindowOpenHandler(handler: (input: { url: string }) => unknown): void;
  };
  let handler = (_input: { url: string }): unknown => {
    throw new Error('handler not installed');
  };

  contents.setWindowOpenHandler = (value) => {
    handler = value;
  };

  const childOptions = browserChildWindowOptions({
    webPreferences: {
      preload: '/fixture/browserPreload.cjs',
      sandbox: true,
      nodeIntegration: false
    },
  });

  guardContents(contents as unknown as Parameters<typeof guardContents>[0], {
    origin: 'http://pipe.test',
    openExternal: async () => {},
    childOptions,
  });

  const result = handler!({ url: 'http://pipe.test/child' }) as {
    overrideBrowserWindowOptions: { webPreferences: Record<string, unknown> };
  };

  assert.equal('preload' in result.overrideBrowserWindowOptions.webPreferences, false);
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.sandbox, true);
});
