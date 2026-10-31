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
function fixture() {
  const calls: unknown[] = [];
  const contents = new EventEmitter();
  const debuggerPort = new EventEmitter();
  let opener: ((input: { url: string }) => unknown) | null = null;

  type Network = (details: { url: string }, callback: (value: { cancel: boolean }) => void) => void;

  let network: Network | null = null;
  let visible = false;
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
  const nativeImage = {
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
      sendCommand: async () => ({}),
    }),
    setWindowOpenHandler: (value: typeof opener) => {
      opener = value;
    },
    loadURL: async (value: string) => {
      url = value;
      calls.push(['load', value]);
    },
    getURL: () => url,
    setZoomFactor: (factor: number) => {
      zoom = factor;
      calls.push(['zoom', factor]);
    },
    getZoomFactor: () => zoom,
    capturePage: async (...args: unknown[]) => {
      calls.push(['capture', ...args]);

      return nativeImage;
    },
    close: () => calls.push(['close']),
    isDestroyed: () => false,
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
    contentView: {
      addChildView: () => calls.push(['add']), removeChildView: () => calls.push(['remove']),
    },
  } as unknown as BrowserWindow;
  const adapter = createNativeBrowserView({
    machine: 'fixture-machine',
    scope: 'fixture-owner',
    create: () => view,
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
    visible: () => visible,
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
  await f.adapter.screenshot();
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
