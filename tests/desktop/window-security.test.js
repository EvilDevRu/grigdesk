import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_PARTITION,
  configureSession,
  externalUrl,
  guardContents,
  navigationDecision,
  openDecision,
  permissionAllowed,
  sameOrigin,
  serviceWorkerBlocked,
  windowOptions,
  settingsWindowOptions,
} from '../../desktop/src/windowSecurity.ts';

const origin = 'http://127.0.0.1:8140';
const size = {
  width: 900,
  height: 700,
  maximized: false,
};

test('DC-26/externalUrl: прежняя проверка внешних HTTP(S)-ссылок сохранена', () => {
  assert.equal(externalUrl('https://example.org/a'), 'https://example.org/a');

  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'cockpit-media://media/x',
    'https://user:password@example.org/',
    'не url',
    'https://example.org/' + 'a'.repeat(8192),
  ]) {
    assert.equal(externalUrl(url), null);
  }
});

test('DW-12: окно получает безопасные опции', () => {
  const options = windowOptions('/app/icon.png', true, size);

  assert.equal(options.webPreferences.partition, LOCAL_PARTITION);
  assert.equal(LOCAL_PARTITION, 'persist:cockpit-local');
  assert.equal(options.width, 900);
  assert.equal(options.height, 700);
  assert.equal(options.minWidth, 600);
  assert.equal(options.minHeight, 600);
  assert.equal(options.title, 'Кокпит');
  assert.equal(options.show, false);
  assert.equal(options.autoHideMenuBar, false);
  assert.equal(options.backgroundColor, '#0b0d11');
  assert.equal(options.icon, '/app/icon.png');
  assert.deepEqual(options.webPreferences, {
    partition: LOCAL_PARTITION,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    webviewTag: false,
    spellcheck: false,
    devTools: false,
  });
  assert.equal('preload' in options.webPreferences, false);
  assert.equal(windowOptions('/app/icon.png', false, size).webPreferences.devTools, true);
});

test('DW-13: свой HTTP разрешён, внешний отдан браузеру, другие схемы запрещены', () => {
  for (const target of [origin, origin + '/', origin + '/chats?x=1#/tasks']) {
    assert.equal(sameOrigin(target, origin), true);
    assert.equal(navigationDecision(target, origin), 'allow');
  }

  assert.equal(sameOrigin('http://127.0.0.1:80/path', 'http://127.0.0.1'), true);

  for (const target of ['https://example.org/', 'http://127.0.0.1:9000/', 'https://127.0.0.1:8140/']) {
    assert.equal(sameOrigin(target, origin), false);
    assert.equal(navigationDecision(target, origin), 'external');
  }

  for (const target of [
    'http://user:pass@127.0.0.1:8140/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hello',
    'about:blank',
    'blob:' + origin + '/id',
    'не url',
  ]) {
    assert.equal(sameOrigin(target, origin), false);
    assert.equal(navigationDecision(target, origin), 'deny');
  }
});

test('DW-14: blob своего origin не создаёт окно', () => {
  for (const target of [
    'blob:' + origin + '/id',
    'data:text/html,hello',
    'file:///etc/passwd',
    'about:blank',
    'javascript:alert(1)',
    'http://user:pass@127.0.0.1:8140/',
  ]) {
    assert.equal(openDecision(target, origin), 'deny');
  }

  assert.equal(openDecision(origin + '/chats#/tasks', origin), 'child');
  assert.equal(openDecision('https://example.org/path', origin), 'external');
  assert.equal(openDecision('http://127.0.0.1:9000/', origin), 'external');
});

test('DW-15: разрешения ограничены origin и audio', () => {
  for (const permission of ['notifications', 'clipboard-sanitized-write', 'fullscreen']) {
    assert.equal(permissionAllowed(permission, origin + '/chats', origin, []), true);

    for (const target of ['https://example.org', 'http://127.0.0.1:9000', 'blob:' + origin + '/id']) {
      assert.equal(permissionAllowed(permission, target, origin, []), false);
    }
  }

  assert.equal(permissionAllowed('media', origin, origin, ['audio']), true);
  assert.equal(permissionAllowed('media', origin, origin, ['audio', 'audio']), true);

  for (const mediaTypes of [[], ['video'], ['audio', 'video'], ['unknown']]) {
    assert.equal(permissionAllowed('media', origin, origin, mediaTypes), false);
  }

  assert.equal(permissionAllowed('media', 'http://127.0.0.1:9000', origin, ['audio']), false);

  for (const permission of ['camera', 'clipboard-read', 'openExternal', 'geolocation', 'unknown']) {
    assert.equal(permissionAllowed(permission, origin, origin, ['audio']), false);
  }
});

test('DW-16: блокируется только свой /sw.js', () => {
  for (const target of [origin + '/sw.js', origin + '/sw.js?version=2']) {
    assert.equal(serviceWorkerBlocked(target, origin), true);
  }

  for (const target of [
    origin + '/assets/probe.js',
    origin + '/notification-sw.js',
    'http://127.0.0.1:9000/sw.js',
    'https://example.org/sw.js',
    'blob:' + origin + '/sw.js',
    'не url',
  ]) {
    assert.equal(serviceWorkerBlocked(target, origin), false);
  }
});

/**
 * Подмена сохраняет callback сессии и управляет завершением очистки без задержек.
 * Cookie-методы отмечаются отдельно, чтобы очистка SW не скрывала потерю входа.
 */
function sessionFixture() {
  const storage = Promise.withResolvers();
  const calls = [];
  const handlers = {};
  const session = {
    webRequest: {
      onBeforeRequest(filter, handler) {
        calls.push(['filter', filter]);
        handlers.before = handler;
      },
    },
    clearStorageData(options) {
      calls.push(['clear', options]);

      return storage.promise;
    },
    setSpellCheckerEnabled(value) {
      calls.push(['enabled', value]);
    },
    setSpellCheckerLanguages(value) {
      calls.push(['languages', value]);
    },
    setSpellCheckerDictionaryDownloadURL(value) {
      calls.push(['dictionary', value]);
    },
    setPermissionRequestHandler(handler) {
      handlers.request = handler;
    },
    setPermissionCheckHandler(handler) {
      handlers.check = handler;
    },
    cookies: {
      get() {
        calls.push(['cookies.get']);
      },
      set() {
        calls.push(['cookies.set']);
      },
    },
  };

  return {
    session,
    handlers,
    storage,
    calls,
  };
}

function requestGranted(handler, permission, details) {
  let granted;

  handler({}, permission, (value) => {
    granted = value;
  }, details);

  return granted;
}

test('DW-17: адаптеры Session соблюдают поля и дождались очистки', async () => {
  const { session, handlers, storage, calls } = sessionFixture();
  let finished = false;
  const pending = configureSession(session, origin).then(() => {
    finished = true;
  });

  await Promise.resolve();
  assert.equal(typeof handlers.before, 'function');
  assert.equal(finished, false);
  assert.deepEqual(calls, [
    ['filter', { urls: ['<all_urls>'] }],
    ['clear', { storages: ['serviceworkers', 'cachestorage'] }],
  ]);

  storage.resolve();
  await pending;
  assert.equal(finished, true);
  assert.equal(typeof handlers.request, 'function');
  assert.equal(typeof handlers.check, 'function');
  assert.deepEqual(calls.slice(2).sort(), [
    ['dictionary', 'http://127.0.0.1:9/'],
    ['enabled', false],
    ['languages', []],
  ]);

  for (const [url, cancel] of [
    [origin + '/sw.js?version=2', true],
    [origin + '/assets/probe.js', false],
    ['https://example.org/sw.js', false],
  ]) {
    let result;

    handlers.before({ url }, (value) => {
      result = value;
    });
    assert.deepEqual(result, { cancel });
  }

  for (const permission of ['notifications', 'clipboard-sanitized-write', 'fullscreen']) {
    assert.equal(requestGranted(handlers.request, permission, {
      requestingUrl: origin + '/chats',
      isMainFrame: true,
    }), true);
    assert.equal(handlers.check(null, permission, origin, { isMainFrame: true }), true);
  }

  for (const [mediaTypes, expected] of [
    [['audio'], true],
    [['video'], false],
    [['audio', 'video'], false],
    [[], false],
    [undefined, false],
  ]) {
    assert.equal(requestGranted(handlers.request, 'media', {
      requestingUrl: origin,
      isMainFrame: true,
      mediaTypes,
    }), expected);
  }

  assert.equal(requestGranted(handlers.request, 'media', {
    requestingUrl: origin,
    isMainFrame: true,
  }), false);
  assert.equal(requestGranted(handlers.request, 'media', {
    requestingUrl: origin,
    securityOrigin: 'http://127.0.0.1:9000',
    isMainFrame: false,
    mediaTypes: ['audio'],
  }), false);
  assert.equal(requestGranted(handlers.request, 'media', {
    requestingUrl: 'http://127.0.0.1:9000',
    securityOrigin: origin,
    isMainFrame: false,
    mediaTypes: ['audio'],
  }), false);
  assert.equal(requestGranted(handlers.request, 'clipboard-read', {
    requestingUrl: origin,
    isMainFrame: true,
  }), false);

  for (const [mediaType, expected] of [
    ['audio', true],
    ['video', false],
    ['unknown', false],
    [undefined, false],
  ]) {
    assert.equal(handlers.check(null, 'media', origin, {
      isMainFrame: true,
      mediaType,
    }), expected);
  }

  assert.equal(handlers.check(null, 'media', 'http://127.0.0.1:9000', {
    requestingUrl: origin,
    securityOrigin: origin,
    isMainFrame: false,
    mediaType: 'audio',
  }), false);
  assert.equal(handlers.check(null, 'media', origin, {
    securityOrigin: 'https://example.org',
    isMainFrame: false,
    mediaType: 'audio',
  }), false);
  assert.equal(handlers.check(null, 'media', origin, {
    securityOrigin: origin,
    isMainFrame: false,
    mediaType: 'audio',
  }), true);
  assert.equal(handlers.check(null, 'openExternal', origin, { isMainFrame: true }), false);
});

test('DW-17/очистка: ошибка clearStorageData не скрывается', async () => {
  const { session, storage } = sessionFixture();

  storage.resolve();
  session.clearStorageData = async () => {
    throw new Error('Тестовый отказ очистки');
  };

  await assert.rejects(configureSession(session, origin), /Тестовый отказ очистки/);
});

/**
 * Подмена отправляет аргументы событий в исходном порядке, как WebContents Electron.
 * Списки обработчиков позволяют обнаружить повторное подключение защиты.
 */
function contentsFixture() {
  const handlers = new Map();

  return {
    handlers,
    open: null,
    on(event, handler) {
      const existing = handlers.get(event) ?? [];

      handlers.set(event, [...existing, handler]);

      return this;
    },
    setWindowOpenHandler(handler) {
      this.open = handler;
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args);
      }
    },
  };
}

/**
 * Отмена наблюдается на самом event, а URL в deprecated аргументах может противоречить ему.
 * Так проверка различает новые поля Electron и прежние позиционные аргументы.
 */
function navigationEvent(url, isMainFrame = true) {
  let prevented = 0;

  return {
    url,
    isMainFrame,
    preventDefault() {
      prevented += 1;
    },
    get prevented() {
      return prevented;
    },
  };
}

test('DW-18: window.open получает безопасный видимый child или отказ', () => {
  const contents = contentsFixture();
  const opened = [];
  const session = { fixture: true };
  const base = windowOptions('/app/icon.png', true, size);
  const childOptions = {
    ...base,
    webPreferences: {
      ...base.webPreferences,
      session,
    },
  };

  guardContents(contents, {
    origin,
    openExternal: async (url) => {
      opened.push(url);
    },
    childOptions,
  });
  assert.equal(typeof contents.open, 'function');

  const response = contents.open({
    url: origin + '/chats#/tasks',
    features: 'nodeIntegration=yes,sandbox=no,webSecurity=no,show=no',
  });

  assert.equal(response.action, 'allow');
  assert.equal(response.overrideBrowserWindowOptions.show, true);
  assert.equal(response.overrideBrowserWindowOptions.titleBarStyle, 'default');
  assert.equal(response.overrideBrowserWindowOptions.titleBarOverlay, false);
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.session, session);
  assert.deepEqual(response.overrideBrowserWindowOptions.webPreferences, childOptions.webPreferences);
  assert.equal(response.overrideBrowserWindowOptions.webPreferences.partition, LOCAL_PARTITION);
  assert.equal(childOptions.show, false);
  assert.deepEqual(contents.open({ url: 'HTTPS://Example.Org:443/a/../b' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.org/b']);

  for (const url of ['blob:' + origin + '/id', 'javascript:alert(1)', 'about:blank']) {
    assert.deepEqual(contents.open({ url }), { action: 'deny' });
  }

  assert.equal(opened.length, 1);
});

test('DW-19: main navigation и redirect охраняются', () => {
  const contents = contentsFixture();
  const opened = [];
  const options = {
    origin,
    openExternal: async () => {
    },
    childOptions: windowOptions('/app/icon.png', true, size),
  };

  guardContents(contents, options);
  options.openExternal = async (url) => {
    opened.push(url);
  };

  for (const name of ['will-navigate', 'will-redirect']) {
    assert.equal(contents.handlers.get(name)?.length, 1);

    const own = navigationEvent(origin + '/chats');
    const external = navigationEvent('HTTPS://Example.Org:443/a/../b');
    const dangerous = navigationEvent('blob:' + origin + '/id');
    const subframe = navigationEvent('https://example.org/subframe', false);

    contents.emit(name, own, 'https://example.org/deprecated');
    contents.emit(name, external, origin);
    contents.emit(name, dangerous, origin);
    contents.emit(name, subframe, origin);

    assert.equal(own.prevented, 0);
    assert.equal(external.prevented, 1);
    assert.equal(dangerous.prevented, 1);
    assert.equal(subframe.prevented, 0);
  }

  assert.deepEqual(opened, ['https://example.org/b', 'https://example.org/b']);

  const webview = navigationEvent(origin);

  contents.emit('will-attach-webview', webview);
  assert.equal(webview.prevented, 1);
});

test('DW-19/shell: синхронный отказ и Promise rejection браузера поглощаются', async () => {
  for (const openExternal of [
    async () => {
      throw new Error('Тестовый отказ браузера');
    },
    () => {
      throw new Error('Тестовое синхронное исключение');
    },
  ]) {
    const contents = contentsFixture();

    guardContents(contents, {
      origin,
      openExternal,
      childOptions: windowOptions('/app/icon.png', true, size),
    });
    assert.equal(contents.handlers.get('will-navigate')?.length, 1);

    const event = navigationEvent('https://example.org/');

    assert.doesNotThrow(() => contents.emit('will-navigate', event));
    assert.equal(event.prevented, 1);
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test('DW-20: созданное окно и его потомок охраняются', () => {
  const contents = contentsFixture();
  const child = { webContents: contentsFixture() };
  const grandchild = { webContents: contentsFixture() };
  const observed = [];
  const options = {
    origin,
    openExternal: async () => {
    },
    childOptions: windowOptions('/app/icon.png', true, size),
    onChild(window) {
      observed.push(window);
      assert.equal(typeof window.webContents.open, 'function');
      assert.equal(window.webContents.handlers.get('will-redirect')?.length, 1);
    },
  };

  guardContents(contents, options);
  guardContents(contents, options);
  assert.equal(contents.handlers.get('did-create-window')?.length, 1);
  contents.emit('did-create-window', child, { url: origin });
  assert.deepEqual(observed, [child]);

  child.webContents.emit('did-create-window', grandchild, { url: origin + '/chats' });
  assert.deepEqual(observed, [child, grandchild]);
  contents.emit('did-create-window', child, { url: origin });
  assert.deepEqual(observed, [child, grandchild]);

  for (const window of [child, grandchild]) {
    guardContents(window.webContents, options);

    for (const handlers of window.webContents.handlers.values()) {
      assert.equal(handlers.length, 1);
    }

    const event = navigationEvent('javascript:alert(1)');

    window.webContents.emit('will-navigate', event);
    assert.equal(event.prevented, 1);
    assert.equal(window.webContents.open({ url: origin }).overrideBrowserWindowOptions.show, true);
  }
});


test('SW-N01 точный адрес открывает настройки и не создаёт popup', () => {
  for (const throws of [false, true]) {
    let calls = 0;
    const contents = contentsFixture();

    guardContents(contents, {
      origin,
      openExternal: async () => {},
      childOptions: windowOptions('', true, size),
      onSettingsRequest() {
        calls += 1;

        if (throws) {
          throw new Error('отказ callback');
        }
      },
    });
    assert.deepEqual(contents.open({
      url: origin + '/?window=settings#/settings',
      features: 'nodeIntegration=yes',
    }), { action: 'deny' });
    assert.equal(calls, 1);
  }
});

test('SW-N02 похожие адреса — прежняя политика', () => {
  let calls = 0;
  const opened = [];
  const contents = contentsFixture();

  guardContents(contents, {
    origin,
    openExternal: async (url) => opened.push(url),
    childOptions: windowOptions('', true, size),
    onSettingsRequest: () => {
      calls += 1;
    },
  });

  const own = contents.open({ url: origin + '/?window=settings&x=1#/settings' });

  assert.equal(own.action, 'allow');
  assert.equal(own.overrideBrowserWindowOptions.webPreferences.sandbox, true);
  assert.equal(contents.open({ url: 'https://example.org/?window=settings#/settings' }).action, 'deny');
  assert.equal(opened.length, 1);
  assert.equal(calls, 0);
});

test('SW-N03 опции окна настроек', () => {
  const parent = {};
  const session = {};
  const geometry = {
    x: 180,
    y: 70,
    width: 1120,
    height: 820,
    minWidth: 800,
    minHeight: 600,
  };
  const options = settingsWindowOptions({
    icon: '/icon.png',
    packaged: true,
    parent,
    geometry,
    session,
  });

  assert.equal(options.parent === parent, true);
  assert.equal(options.modal, true);
  assert.equal(options.show, false);
  assert.equal(options.minimizable, false);
  assert.equal(options.fullscreenable, false);
  assert.equal(options.title, 'Настройки — Кокпит');

  for (const [key, value] of Object.entries(geometry)) {
    assert.equal(options[key], value);
  }

  assert.deepEqual(options.webPreferences, { ...windowOptions('', true, size).webPreferences, session });
});
