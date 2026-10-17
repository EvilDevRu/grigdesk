import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { useHotkeysStore, HOTKEYS_KEY, DEFAULT_HOTKEYS } from '../../web/src/stores/hotkeys.js';
import { useDeviceStore, WAKE_LOCK_KEY } from '../../web/src/stores/device.js';

/**
 * Два документа видят одну память устройства, но имеют независимые Pinia.
 * Прямая смена Map воспроизводит запись другого окна без собственного setItem.
 */
function storageFixture(t) {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const data = new Map();
  let writes = 0;

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => data.get(key) ?? null,
      setItem(key, value) {
        writes += 1;
        data.set(key, value);
      },
    },
  });
  t.after(() => {
    if (old) {
      Object.defineProperty(globalThis, 'localStorage', old);
    } else {
      delete globalThis.localStorage;
    }
  });

  return { data, writes: () => writes };
}

test('SW-D01 сочетания другого окна применяются без записи', (t) => {
  const f = storageFixture(t);
  const a = useHotkeysStore(createPinia());
  const b = useHotkeysStore(createPinia());

  b.startRecording('code');

  for (const action of [
    () => a.assign('terminal', 'Ctrl+Shift+Digit9'), () => a.disable('terminal'),
    () => a.restore('terminal'), () => a.resetAll(),
  ]) {
    action();

    const before = f.writes();

    b.reload();
    assert.equal(b.comboOf('terminal'), a.comboOf('terminal'));
    assert.deepEqual(b.toolByCombo, a.toolByCombo);
    assert.equal(f.writes(), before);
    assert.equal(b.recording, 'code');
  }
});

test('SW-D02 выключено и по умолчанию различаются', (t) => {
  const f = storageFixture(t);
  const store = useHotkeysStore(createPinia());

  f.data.set(HOTKEYS_KEY, JSON.stringify({ terminal: '', unknown: 'Ctrl+Shift+Digit9' }));
  store.reload();
  assert.equal(store.comboOf('terminal'), '');
  assert.equal(store.isDefault('terminal'), false);
  assert.equal('unknown' in store.overrides, false);
  f.data.set(HOTKEYS_KEY, '{}');
  store.reload();
  assert.equal(store.comboOf('terminal'), DEFAULT_HOTKEYS.terminal);
  assert.equal(store.isDefault('terminal'), true);
  f.data.set(HOTKEYS_KEY, 'не JSON');
  store.reload();
  assert.deepEqual(store.overrides, {});
});

test('SW-D03 удержание экрана по событию другого окна', async (t) => {
  const f = storageFixture(t);
  const descriptors = new Map(['navigator', 'document'].map((key) => [
    key, Object.getOwnPropertyDescriptor(globalThis, key),
  ]));
  let requests = 0;
  let released = 0;
  const lock = new EventTarget();

  lock.released = false;
  lock.release = async () => {
    lock.released = true;
    released += 1;
    lock.dispatchEvent(new Event('release'));
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      wakeLock: {
        request: async () => {
          requests += 1;

          return lock;
        }
      }
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { visibilityState: 'visible' },
  });

  const store = useDeviceStore(createPinia());

  t.after(async () => {
    await store.releaseWakeLock();

    for (const [key, old] of descriptors) {
      if (old) {
        Object.defineProperty(globalThis, key, old);
      } else {
        delete globalThis[key];
      }
    }
  });
  f.data.set(WAKE_LOCK_KEY, '1');
  await store.reloadWakeLock();
  assert.equal(store.wakeLockActive, true);
  await store.reloadWakeLock();
  assert.equal(requests, 1);
  f.data.set(WAKE_LOCK_KEY, '0');
  await store.reloadWakeLock();
  assert.equal(released, 1);
  assert.equal(store.wakeLockActive, false);
  assert.equal(f.writes(), 0);
});

/**
 * Минимальный renderer запускает настоящий lifecycle Vue без раннего document.
 * Подменная шина и storage принадлежат этому mount и освобождаются в cleanup.
 */
async function syncFixture(t, prefs = Promise.resolve({ chatAutoCompactWindow: 64000 })) {
  const { compileModule, webFile } = await import('./helpers/compile-vue.js');
  const { createRenderer } = await import('../../web/node_modules/vue/index.mjs');
  const { channelHub } = await import('./helpers/settings-window-channel.js');
  const { createSettingsWindowChannel } = await import('../../web/src/shared/settingsWindowChannel.ts');
  const calls = [];
  const hub = channelHub();
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const win = new EventTarget();
  const h = {
    calls,
    plugins: { load: async () => calls.push(['plugins']) },
    providers: { load: async () => calls.push(['providers']) },
    chat: { compactWindow: 0, setActive: (key) => calls.push(['chat', key]) },
    board: { error: null, load: async (force) => calls.push(['board', force]) },
    hotkeys: { reload: () => calls.push(['hotkeys']) },
    device: { reloadWakeLock: () => calls.push(['wake']) },
    launcher: {
      openTerminal: async (target) => {
        calls.push(['terminal', target]);

        return true;
      }
    },
    router: { push: async (route) => calls.push(['route', route]) },
    api: { get: () => prefs },
  };

  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  globalThis.__settingsSync = h;

  const stubs = {
    '../shared/tools/launcher.ts': 'export const useToolLauncher = () => globalThis.__settingsSync.launcher;',
    'vue-router': 'export const useRouter = () => globalThis.__settingsSync.router;',
    '../shared/apiClient.ts': 'export const api = globalThis.__settingsSync.api;',
    '../shared/windowControl.ts': 'export const reloadCurrentWindow = () => {};',
  };

  for (const [file, name, key, extra] of [
    ['plugins.js', 'usePluginsStore', 'plugins', ''],
    ['providers.js', 'useProvidersStore', 'providers', ''],
    ['chat.js', 'useChatStore', 'chat', ''],
    ['board.js', 'useBoardStore', 'board', ''],
    ['hotkeys.js', 'useHotkeysStore', 'hotkeys', "export const HOTKEYS_KEY = 'cockpit-tool-hotkeys';"],
    ['device.js', 'useDeviceStore', 'device', "export const WAKE_LOCK_KEY = 'cockpit-screen-wake-lock';"],
  ]) {
    stubs['../stores/' + file] = `export const ${name} = () => globalThis.__settingsSync.${key}; ${extra}`;
  }

  const module = await compileModule(webFile('src/composables/useDesktopSettingsSync.ts'), { stubs });
  const renderer = createRenderer({
    createElement: () => ({ children: [] }),
    createText: () => ({}),
    createComment: () => ({}),
    insert: () => { },
    remove: () => { },
    setText: () => { },
    setElementText: () => { },
    patchProp: () => { },
    parentNode: () => null,
    nextSibling: () => null,
  });
  const app = renderer.createApp({
    setup() {
      module.useDesktopSettingsSync({ channelFactory: hub.factory });

      return () => null;
    },
  });

  app.mount({ children: [] });

  const sender = createSettingsWindowChannel(hub.factory);

  t.after(() => {
    app.unmount();
    sender.close();
    delete globalThis.__settingsSync;

    if (oldWindow) {
      Object.defineProperty(globalThis, 'window', oldWindow);
    } else {
      delete globalThis.window;
    }
  });

  return {
    h,
    hub,
    sender,
    app,
    win
  };
}

async function flushSync() {
  await new Promise((resolve) => setImmediate(resolve));
}

function storageEvent(win, key) {
  const event = new Event('storage');

  Object.assign(event, { key });
  win.dispatchEvent(event);
}

test('SW-A01 перечитывание фиксированного набора', async (t) => {
  const { h, sender } = await syncFixture(t);

  sender.post({ version: 1, type: 'settings-changed' });
  await flushSync();
  assert.deepEqual(h.calls, [['plugins'], ['providers']]);
  assert.equal(h.chat.compactWindow, 64000);
  h.board.error = 'Нет подключения';
  sender.post({ version: 1, type: 'settings-changed' });
  await flushSync();
  assert.deepEqual(h.calls.at(-1), ['board', true]);
});

test('SW-A02 намерения в основном окне', async (t) => {
  const { h, sender } = await syncFixture(t);
  const replies = [];

  sender.subscribe((message) => replies.push(message));
  sender.post({
    version: 1,
    type: 'terminal-request',
    requestId: 't',
    insert: 'command'
  });
  sender.post({
    version: 1,
    type: 'open-chat-request',
    requestId: 'c',
    chatKey: 'chat'
  });
  await flushSync();
  assert.deepEqual(h.calls, [['terminal', { insert: 'command' }], ['chat', 'chat'], ['route', '/chats']]);
  assert.deepEqual(replies.map((reply) => reply.ok), [true, true]);
});

test('SW-A03 storage другого окна', async (t) => {
  const { h, win } = await syncFixture(t);

  storageEvent(win, HOTKEYS_KEY);
  storageEvent(win, WAKE_LOCK_KEY);
  storageEvent(win, null);
  storageEvent(win, 'other');
  assert.deepEqual(h.calls, [['hotkeys'], ['wake'], ['hotkeys'], ['wake']]);
});

test('SW-A04 размонтирование снимает всё', async (t) => {
  const pending = Promise.withResolvers();
  const { h, sender, hub, app, win } = await syncFixture(t, pending.promise);

  sender.post({ version: 1, type: 'settings-changed' });
  await flushSync();
  app.unmount();
  assert.equal(hub.ports[0]?.closed, 1);
  pending.resolve({ chatAutoCompactWindow: 64000 });
  storageEvent(win, null);
  await flushSync();
  assert.equal(h.chat.compactWindow, 0);
  assert.equal(h.calls.some((call) => call[0] === 'hotkeys' || call[0] === 'wake'), false);
});
