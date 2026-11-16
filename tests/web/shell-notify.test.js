import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, webFile } from './helpers/compile-vue.js';

/**
 * APK-окружение: WebView без Notification API, обнаруженная оболочка с каналом notify.
 * Каждый тест компилирует свежий модуль, поэтому внутренние теги не наследуются.
 */
async function fixture(t, { capabilities = ['notify'], permission = 'granted', shown = true } = {}) {
  const calls = [];
  const window = {
    location: { href: 'http://127.0.0.1:47101/#/chats' },
    focus() {},
  };
  const document = {
    hidden: false,
    title: 'GrigDesk',
    addEventListener() {},
    removeEventListener() {},
  };

  for (const [key, value] of Object.entries({ window, document })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }

  globalThis.__notifyShell = { capabilities };
  t.after(() => {
    for (const key of ['window', 'document']) {
      delete globalThis[key];
    }

    delete globalThis.__notifyShell;
  });

  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });

    if (url === '/__shell/notify') {
      return new Response(JSON.stringify({ shown, permission }));
    }

    if (url === '/__shell/notify-permission') {
      return new Response(JSON.stringify({ permission }));
    }

    return new Response(JSON.stringify({ ok: true }));
  });

  const api = await compileModule(webFile('src/shared/notify.ts'), {
    stubs: {
      '../stores/shell.ts': 'export const useShellStore = () => globalThis.__notifyShell;',
      pinia: 'export const getActivePinia = () => ({});',
    },
  });

  return { api, calls, window };
}

test('APK: без Notification API оповещение показывает нативный канал оболочки', async (t) => {
  const { api, calls } = await fixture(t);
  const url = 'http://127.0.0.1:47101/#/chats?openChat=c1';

  assert.equal(await api.notify('Агент ответил', 'Готово', 'chat-1', url), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/__shell/notify');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.deepEqual(calls[0].body, { title: 'Агент ответил', body: 'Готово', tag: 'chat-1', url });
});

test('отказ нативного канала не считается показом и не трогает браузерный фоллбэк', async (t) => {
  const { api, calls } = await fixture(t, { shown: false, permission: 'denied' });

  assert.equal(await api.notify('t', 'b', 'chat-1'), false);
  assert.equal(calls.length, 1);
});

test('разрешение в APK запрашивается у оболочки и читается без запроса', async (t) => {
  const { api, calls } = await fixture(t, { permission: 'default' });

  assert.equal(await api.readShellNotifyPermission(), 'default');
  assert.equal(calls[0].url, '/__shell/notify-permission');
  assert.equal(calls[0].options.method ?? 'GET', 'GET');

  assert.equal(await api.ensureNotifyPermission(), false);
  assert.equal(calls[1].url, '/__shell/notify-permission');
  assert.equal(calls[1].options.method, 'POST');
});

test('выданное нативное разрешение проходит проверку, мусор читается как unsupported', async (t) => {
  const granted = await fixture(t, { permission: 'granted' });

  assert.equal(await granted.api.ensureNotifyPermission(), true);

  const broken = await fixture(t, { permission: 'unexpected' });

  assert.equal(await broken.api.readShellNotifyPermission(), 'unsupported');
});

test('оболочка без канала notify сохраняет unsupported и не отправляет запросы', async (t) => {
  const { api, calls } = await fixture(t, { capabilities: ['scan', 'save'] });

  assert.equal(api.shellNotifySupported(), false);
  assert.equal(await api.readShellNotifyPermission(), 'unsupported');
  assert.equal(await api.ensureNotifyPermission(), false);
  assert.equal(await api.notify('t', 'b'), false);
  assert.equal(calls.length, 0);
});

test('закрытие тоста гасит только собственные нативные теги', async (t) => {
  const { api, calls } = await fixture(t);

  await api.notify('t', 'b', 'chat-1');
  await api.closeSystemNotification('chat-1');
  await api.closeSystemNotification('chat-2');

  const cancels = calls.filter((call) => call.url === '/__shell/notify-cancel');

  assert.equal(cancels.length, 1);
  assert.deepEqual(cancels[0].body, { tag: 'chat-1' });
});

test('браузерный Notification API сохраняет приоритет над каналом оболочки', async (t) => {
  const { api, calls, window } = await fixture(t);
  const constructed = [];

  window.Notification = class {
    static permission = 'granted';

    constructor(title, options) {
      constructed.push({ title, options });
    }

    close() {}
  };

  assert.equal(await api.notify('t', 'b', 'chat-1'), true);
  assert.equal(constructed.length, 1);
  assert.equal(calls.length, 0);
});
