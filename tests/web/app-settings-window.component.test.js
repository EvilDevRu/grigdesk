import assert from 'node:assert/strict';
import test from 'node:test';

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
async function fixture(t, mode, authenticated, present = false) {
  const h = {
    mode,
    calls: [],
    auth: reactive({ ready: true, authenticated }),
    shell: reactive({
      initialized: true,
      present,
      status: 'none',
      start: async (options) => h.startOptions = options,
      stop: () => {},
    }),
  };

  h.auth.load = async () => h.calls.push('auth.load');
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
  globalThis.__settingsApp = h;

  const marker = (name) => `import { h } from 'vue';
    export const __esModule = true;
    export default { setup(_props, { slots }) {
      return () => h('div', { 'data-app': '${name}' }, slots.default?.());
    }};`;
  const stubs = {
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
    './features/speech/provider.js': `import { h } from 'vue';
      export const SpeechProvider = {
        setup(_props, { slots }) { return () => h('div', slots.default?.()); }
      };`,
    './views/TaskModal.vue': marker('task'),
    './views/DiffModal.vue': marker('diff'),
    './views/DocumentModal.vue': marker('document'),
    './ui': `import { h } from 'vue';
      const Host = { render: () => h('div') };
      export const UiDialogHost = Host;
      export const UiTooltipHost = Host;
      export const UiToastHost = Host;`,
    './shared/alerts.ts': `
      export const clearAlertHistory = () => {};
      export const dismissAllAlerts = () => {};`,
    './stores/auth.js': 'export const useAuthStore = () => globalThis.__settingsApp.auth;',
    './stores/shell.ts': 'export const useShellStore = () => globalThis.__settingsApp.shell;',
  };

  for (const [file, name] of [
    ['board.js', 'useBoardStore'], ['system.js', 'useSystemStore'],
    ['task-favorites.js', 'useTaskFavoritesStore'], ['taskShelf.ts', 'useTaskShelfStore'],
    ['task-seen.js', 'useTaskSeenStore'], ['videoSession.ts', 'useVideoSessionStore'],
  ]) {
    stubs['./stores/' + file] = `export const ${name} = () => globalThis.__settingsApp.store;`;
  }

  const component = await compileVue(webFile('src/App.vue'), { stubs });
  const wrapper = mount(component, { global: { stubs: { RouterView: true } } });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__settingsApp;
  });
  await flushPromises();
  await flushPromises();

  return { h, wrapper };
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
