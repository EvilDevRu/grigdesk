import assert from 'node:assert/strict';
import test from 'node:test';

import { appWindowStubs } from './helpers/app-window-stubs.js';

import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
const browser = new Window({ url: 'http://127.0.0.1:8140/' });

for (const name of ['window', 'document', 'navigator', 'location', 'localStorage',
  'Node', 'Element', 'HTMLElement', 'SVGElement']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: browser[name] });
}

const { reactive } = await import('../../web/node_modules/vue/index.mjs');
const { mount, flushPromises } = await import(
  '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
);

/**
 * App получает независимые подмены областей, чтобы видеть запуск каждого polling.
 * Подмена режима меняется после mount и проверяет однократный выбор оболочки.
 */
async function fixture(t, mode, authenticated, present = false, options = {}) {
  const h = {
    mode,
    calls: [],
    relays: [],
    channels: [],
    auth: reactive({ ready: true, authenticated }),
    shell: reactive({
      initialized: true,
      present,
      status: present ? 'online' : 'none',
      refresh: async () => h.calls.push('shell.refresh'),
      start: async (options) => h.startOptions = options,
      stop: () => {},
    }),
  };

  h.auth.load = async () => h.calls.push('auth.load');
  h.auth.stopRecovery = () => {};
  h.auth.watchUnauthorized = () => h.calls.push('auth.watch');
  h.store = {
    startPolling: () => h.calls.push('poll'),
    stopPolling: () => { },
    load: () => h.calls.push('seen'),
    start: () => h.calls.push('shelf'),
    stop: () => { },
    clear: () => { },
    stopPoll: () => { },
  };
  h.boardStore = {
    ...h.store,
    load: async () => h.calls.push('board.load'),
    clearSource: () => h.calls.push('board.clear'),
  };
  h.store.$onAction = () => () => {};
  h.store.setMirror = () => {};
  h.store.applySnapshot = () => {};
  Object.assign(h.boardStore, {
    $onAction: h.store.$onAction,
    setMirror: h.store.setMirror,
    applySnapshot: h.store.applySnapshot,
  });
  h.shelfStore = {
    ...h.store,
    setPassive(value) {
      h.passive = value;
      h.calls.push('shelf.passive:' + value);
    },
    async load() {
      h.calls.push('shelf.load');
    },
  };
  h.loadPlugins = async () => {
    h.calls.push('plugins.load');
    await options.pluginsReady;
  };
  globalThis.__settingsApp = h;

  const previousChannel = globalThis.BroadcastChannel;

  globalThis.BroadcastChannel = class {
    constructor(name) {
      this.name = name;
      h.channels.push(this);
    }

    postMessage() {}

    close() {
      this.closed = true;
    }
  };
  t.after(() => {
    globalThis.BroadcastChannel = previousChannel;
  });

  const marker = (name) => `import { h } from 'vue';
    export const __esModule = true;
    export default { setup(_props, { slots }) {
      return () => h('div', { 'data-app': '${name}' }, slots.default?.());
    }};`;
  const stubs = {
    ...appWindowStubs,
    './shared/layout/DesktopExitHost.vue': marker('exit'),
    './shared/tools/toolWindowRelay.ts':
      'export const startToolShelfRelay = () => () => {};',
    './views/ToolWindowPage.vue': marker('tool'),
    './views/TaskWindowPage.vue': `import { h } from 'vue';
      export default {
        props: ['target', 'ready'],
        setup: (props) => () => h('div', {
          'data-app': 'surface',
          'data-task-id': props.target?.id,
          'data-ready': String(props.ready),
        }),
      };`,
    './stores/plugins.ts': 'export const usePluginsStore = () => globalThis.__settingsApp.plugins;',
    './shared/windowRelay.ts': `
      export const startShellRelay = (options) => {
        globalThis.__settingsApp.relays.push('shell:' + options.role);
        return () => options.channel.close();
      };
      export const startBoardRelay = (options) => {
        globalThis.__settingsApp.relays.push('board:' + options.role);
        return () => options.channel.close();
      };
      export const startShelfRelay = (options) => () => options.channel.close();`,
    './stores/settings.ts': `export const useSettingsStore = () => ({
      isOpen: false, setAuthenticated() {}, dispose() {},
    });`,
    './views/settings/SettingsModal.vue': 'export default { render: () => null };',
    './shared/desktopSettings.ts': 'export const currentDesktopMode = () => globalThis.__settingsApp.mode;',
    './shared/layout/AppShell.vue': marker('main'),
    './views/LoginView.vue': marker('login'),
    './views/NoAccessView.vue': marker('noaccess'),
    './views/ConnectionsView.vue': marker('machines'),
    './shared/layout/LockOverlay.vue': marker('lock'),
    './features/speech/provider.ts': `import { h } from 'vue';
      export const SpeechProvider = {
        setup(_props, { slots }) { return () => h('div', slots.default?.()); }
      };`,
    './views/TaskModal.vue': marker('task'),
    './views/DiffModal.vue': marker('diff'),
    './views/DocumentModal.vue': marker('document'),
    './views/MediaViewer.vue': marker('media'),
    './ui': `import { h } from 'vue';
      export { t, uiLocale } from './src/services/locale.ts';
      const Host = { render: () => h('div') };
      export const UiDialogHost = Host;
      export const UiDesktopContextMenu = Host;
      export const UiTooltipHost = Host;
      export const UiToastHost = Host;
      export const UiInlineMessage = Host;
      export const UiLoadingState = Host;
      export const UiSpinner = Host;`,
    './shared/alerts.ts': `
      export const clearAlertHistory = () => {};
      export const dismissAllAlerts = () => {};`,
    './stores/auth.ts': 'export const useAuthStore = () => globalThis.__settingsApp.auth;',
    './stores/shell.ts': 'export const useShellStore = () => globalThis.__settingsApp.shell;',
  };

  for (const [file, name] of [
    ['board.js', 'useBoardStore'], ['system.js', 'useSystemStore'],
    ['task-favorites.js', 'useTaskFavoritesStore'], ['taskShelf.ts', 'useTaskShelfStore'],
    ['task-seen.js', 'useTaskSeenStore'], ['videoSession.ts', 'useVideoSessionStore'],
  ]) {
    stubs['./stores/' + file] = `export const ${name} = () => globalThis.__settingsApp.store;`;
  }

  stubs['./stores/board.ts'] =
    'export const useBoardStore = () => globalThis.__settingsApp.boardStore;';

  h.plugins = { load: h.loadPlugins, enabled: () => true };
  stubs['./stores/taskShelf.ts'] =
    'export const useTaskShelfStore = () => globalThis.__settingsApp.shelfStore;';

  const component = await compileVue(webFile('src/App.vue'), { stubs });
  const wrapper = mount(component, { global: { stubs: { RouterView: true } } });

  let mounted = true;
  const unmount = () => {
    if (mounted) {
      wrapper.unmount();
      mounted = false;
    }
  };

  t.after(() => {
    unmount();
    delete globalThis.__settingsApp;
  });
  await flushPromises();
  await flushPromises();

  return {
    h,
    wrapper,
    unmount,
  };
}

for (const mode of ['main', 'page']) {
  test('SW-U07/' + mode + ' прежняя оболочка и polling', async (t) => {
    const { h, wrapper } = await fixture(t, mode, true);

    assert.equal(wrapper.find('[data-app=main]').exists(), true);
    assert.equal(h.calls.filter((call) => call === 'poll').length, 2);
    assert.equal(h.calls.filter((call) => call === 'seen').length, 1);
    assert.equal(h.calls.filter((call) => call === 'shelf').length, 1);
  });

  test('SW-U07/' + mode + ' нет входа без polling', async (t) => {
    const { h, wrapper } = await fixture(t, mode, false);

    assert.equal(wrapper.find('[data-app=noaccess]').exists(), true);
    assert.equal(wrapper.find('[data-app=version]').exists(), false);
    assert.deepEqual(h.calls, ['auth.watch', 'auth.load']);
  });
}

test('SP-01: документ карточки без AppShell и без системного polling', async (t) => {
  browser.location.href = 'http://127.0.0.1:8140/?surface=task&id=42#/surface';
  t.after(() => {
    browser.location.href = 'http://127.0.0.1:8140/';
  });

  const { h, wrapper } = await fixture(t, 'surface', true);

  assert.equal(wrapper.find('[data-app=main]').exists(), false);
  assert.equal(wrapper.find('[data-app=surface]').attributes('data-task-id'), '42');
  assert.equal(h.calls.includes('poll'), false);
  assert.equal(h.passive, true);
  assert.equal(h.calls.indexOf('shelf.passive:true') < h.calls.indexOf('shelf.load'), true);
  assert.equal(h.calls.indexOf('shelf.passive:true') < h.calls.indexOf('plugins.load'), true);
  assert.equal(h.calls.includes('plugins.load'), true);
  assert.equal(h.calls.includes('shelf'), false);
  assert.equal(h.calls.filter((call) => call === 'shelf.load').length, 1);
  browser.location.href = 'http://127.0.0.1:8140/';
});

test('SP-02: старый каталог не запускает полку после выхода или размонтирования', async (t) => {
  for (const transition of ['logout', 'unmount', 'reauth']) {
    await t.test(transition, async (t) => {
      browser.location.href = 'http://127.0.0.1:8140/?surface=task&id=42#/surface';
      t.after(() => {
        browser.location.href = 'http://127.0.0.1:8140/';
      });

      const ready = Promise.withResolvers();
      const { h, unmount } = await fixture(t, 'surface', true, false, {
        pluginsReady: ready.promise,
      });

      assert.equal(h.calls.includes('plugins.load'), true);
      assert.equal(h.calls.includes('shelf.load'), false);

      if (transition === 'unmount') {
        unmount();
      }
      else {
        h.auth.authenticated = false;
        await flushPromises();

        if (transition === 'reauth') {
          h.auth.authenticated = true;
          await flushPromises();
          assert.equal(h.calls.filter((call) => call === 'plugins.load').length, 2);
        }
      }

      ready.resolve();
      await flushPromises();
      await flushPromises();
      assert.equal(
        h.calls.filter((call) => call === 'shelf.load').length,
        transition === 'reauth' ? 1 : 0,
      );
    });
  }
});

test('SP-03: окно карточки не держит long-poll и слушает ретрансляцию оболочки', async (t) => {
  browser.location.href = 'http://127.0.0.1:8140/?surface=task&id=42#/surface';
  t.after(() => {
    browser.location.href = 'http://127.0.0.1:8140/';
  });

  const { h } = await fixture(t, 'surface', true);

  assert.deepEqual(h.startOptions, { poll: false });
  assert.deepEqual(h.relays.filter((name) => name.startsWith('shell:')), ['shell:mirror']);
});
test('SP-04: главное окно держит long-poll и ретранслирует оболочку', async (t) => {
  const { h } = await fixture(t, 'main', true);

  assert.equal(h.startOptions, undefined);
  assert.deepEqual(h.relays.filter((name) => name.startsWith('shell:')), ['shell:source']);
});
test('SP-05: браузер и Android не создают межоконных каналов', async (t) => {
  const { h } = await fixture(t, 'page', true);

  assert.equal(h.startOptions, undefined);
  assert.deepEqual(h.relays, []);
  assert.deepEqual(h.channels, []);
  assert.equal(h.passive, undefined);
});

test('SP-06: окно карточки получает доску снимком и не опрашивает дашборд', async (t) => {
  browser.location.href = 'http://127.0.0.1:8140/?surface=task&id=42#/surface';
  t.after(() => {
    browser.location.href = 'http://127.0.0.1:8140/';
  });

  const { h } = await fixture(t, 'surface', true);

  assert.equal(h.calls.filter((call) => call === 'seen').length, 1);
  assert.deepEqual(h.relays.filter((name) => name.startsWith('board:')), ['board:mirror']);
});
test('SP-07: главное окно — источник снимка доски', async (t) => {
  const { h } = await fixture(t, 'main', true);

  assert.deepEqual(h.relays.filter((name) => name.startsWith('board:')), ['board:source']);
});
test('SP-08: карточка монтируется только после запуска синхронизации', async (t) => {
  browser.location.href = 'http://127.0.0.1:8140/?surface=task&id=42#/surface';
  t.after(() => {
    browser.location.href = 'http://127.0.0.1:8140/';
  });

  const { h, wrapper } = await fixture(t, 'surface', false, true);
  const page = () => wrapper.find('[data-app=surface]');

  assert.equal(page().attributes('data-ready'), 'false');
  assert.deepEqual(h.relays.filter((name) => name.startsWith('board:')), []);
  h.auth.authenticated = true;
  await flushPromises();
  assert.equal(page().attributes('data-ready'), 'true');
  assert.deepEqual(h.relays.filter((name) => name.startsWith('board:')), ['board:mirror']);

  const element = page().element;

  h.auth.authenticated = false;
  await flushPromises();
  assert.equal(page().element === element, true);
  assert.equal(page().attributes('data-ready'), 'true');
  assert.equal(h.passive, true);
  h.auth.authenticated = true;
  await flushPromises();
  assert.equal(page().element === element, true);
  assert.equal(page().attributes('data-ready'), 'true');
  assert.equal(h.passive, true);
});


test.after(() => browser.close());
test('SOURCE-APP: смена машины, auth scope и потеря входа очищают снимок', async (t) => {
  const { h } = await fixture(t, 'main', true, true);
  const before = h.calls.filter((call) => call === 'board.clear').length;

  h.shell.profile = { id: 'another-machine', name: 'Fixture' };
  await flushPromises();
  h.auth.clientScope = 'another-owner';
  await flushPromises();
  h.auth.authenticated = false;
  await flushPromises();
  assert.equal(h.calls.filter((call) => call === 'board.clear').length, before + 3);
});
