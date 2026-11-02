import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  browserChildWindowOptions, browserViewOptions, createNativeBrowserView,
} from '../../desktop/src/browser/browserView.ts';
import { guardContents } from '../../desktop/src/windowSecurity.ts';

import type { BrowserWindow, NativeImage, WebContentsView } from 'electron';

/**
 * Fake хранит реальные вызовы Electron adapter, не повторяя его guards.
 * Cast нужен только вместо огромных Electron interfaces, модельные параметры не кастуются.
 */
function fixture(options: {
  pendingLoad?: boolean;
  failedCapture?: boolean;
  emptyCapture?: boolean;
} = {}) {
  const calls: unknown[] = [];
  const contents = new EventEmitter();
  const debuggerPort = new EventEmitter();
  let opener: ((input: { url: string }) => unknown) | null = null;

  type Network = (details: { url: string }, callback: (value: { cancel: boolean }) => void) => void;

  let network: Network | null = null;
  let visible = false;
  let attached = false;
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
    setZoomFactor: (factor: number) => {
      zoom = factor;
      calls.push(['zoom', factor]);
    },
    getZoomFactor: () => zoom,
    capturePage: async (...args: unknown[]) => {
      calls.push(['capture', ...args]);

      if (options.failedCapture) {
        throw new Error('Failed to capture page');
      }

      return options.emptyCapture ? { isEmpty: () => true } as NativeImage : nativeImage;
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
    imageFromBuffer: () => nativeImage,
    window: () => window,
    pipeOrigins: () => new Set(['http://pipe.test']),
    events: {
      start: () => calls.push(['start']),
      navigated: (target) => calls.push(['navigated', target]),
      metadata: () => {},
      lost: () => calls.push(['lost']),
      popup: (target) => calls.push(['popup', target]),
      intent: (intent) => calls.push(['intent', intent]),
    },
  });

  return {
    adapter,
    contents,
    debuggerPort,
    calls,
    finishLoad,
    failLoad,
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

  f.focus('guest');
  f.adapter.show(rect);
  assert.equal(f.focused(), 'guest', 'повторный layout сохраняет явный фокус сайта');
  assert.equal(f.calls.filter((call) => JSON.stringify(call) === '["add"]').length, 1);

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
  assert.ok(f.calls.some((call) => JSON.stringify(call)
    === '["capture",null,{"stayHidden":true}]'));
  f.adapter.show({
    x: 5,
    y: 6,
    width: 700,
    height: 500
  });
  assert.equal(f.visible(), true);
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

test('BR-V01D: скрытая вкладка отдаёт JPEG при отказе или пустом native capture', async (t) => {
  for (const options of [{ failedCapture: true }, { emptyCapture: true }]) {
    const f = fixture(options);

    t.after(() => f.adapter.destroy());
    assert.equal(await f.adapter.screenshot(f.adapter.send), Buffer.from('fixture').toString('base64'));
    assert.equal(f.visible(), false);

    const capture = f.calls.find((call) => Array.isArray(call) && call[0] === 'Page.captureScreenshot');

    assert.deepEqual(capture, ['Page.captureScreenshot', {
      format: 'jpeg',
      quality: 75,
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: 20,
        y: 300,
        width: 2000,
        height: 1000,
        scale: 0.64,
      },
    }]);
  }
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
