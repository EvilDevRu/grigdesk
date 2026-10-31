import assert from 'node:assert/strict';
import test from 'node:test';

import { appWindowStubs } from './helpers/app-window-stubs.js';

import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('оболочка: интерфейс открыт до сервера, машины появляются только по явному запросу',
  async (t) => {
    await installUiBrowser(t);

    const { reactive, nextTick } = await import('../../web/node_modules/vue/index.mjs');
    const { mount } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
    const noop = () => {};
    const authLoads = [];

    globalThis.__gateAuth = reactive({
      ready: true,
      authenticated: false,
      load: async (reason) => authLoads.push(reason),
      watchUnauthorized: noop,
    });
    globalThis.__gateShell = reactive({
      present: true,
      initialized: true,
      status: 'offline',
      profile: { id: 'machine' },
      everOnline: false,
      showConnections: false,
      start: async () => {},
      stop: noop,
    });
    globalThis.__gateOther = {
      load: noop,
      startPolling: noop,
      stopPolling: noop,
      start: noop,
      stop: noop,
      clear: noop,
      stopPoll: noop,
      clearSource: () => {},
    };

    const stubs = {
    ...appWindowStubs,
      './stores/settings.ts': `export const useSettingsStore = () => ({
        isOpen: false, setAuthenticated() {}, dispose() {},
      });`,
      './views/settings/SettingsModal.vue': 'export default { render: () => null };',
      './stores/auth.ts': 'export const useAuthStore = () => globalThis.__gateAuth;',
      './stores/shell.ts': 'export const useShellStore = () => globalThis.__gateShell;',
      './shared/desktopSettings.ts': "export const currentDesktopMode = () => 'main';",
      './shared/alerts.ts': [
        'export const clearAlertHistory = () => {};',
        'export const dismissAllAlerts = () => {};',
      ].join('\n'),
      './features/speech/provider.ts': 'export const SpeechProvider = { template: `<div><slot /></div>` };',
      './shared/layout/AppShell.vue': 'export default { template: `<div data-app-shell><slot /></div>` };',
      './views/ConnectionsView.vue': 'export default { template: `<div data-machines>Машины</div>` };',
      './shared/layout/LockOverlay.vue': 'export default { template: `<div data-lock>Замок</div>` };',
    };

    for (const [file, name] of [
      ['board.js', 'useBoardStore'], ['system.js', 'useSystemStore'],
      ['task-favorites.js', 'useTaskFavoritesStore'], ['taskShelf.ts', 'useTaskShelfStore'],
      ['task-seen.js', 'useTaskSeenStore'], ['videoSession.ts', 'useVideoSessionStore'],
    ]) {
      stubs[`./stores/${file}`] = `export const ${name} = () => globalThis.__gateOther;`;
    }

    for (const name of ['TaskModal', 'DiffModal', 'DocumentModal', 'MediaViewer']) {
      stubs[`./views/${name}.vue`] = 'export default { template: `<div />` };';
    }

    const component = await compileVue(webFile('src/App.vue'), { stubs });
    const wrapper = mount(component, {
      attachTo: document.body,
      global: { stubs: { RouterView: { template: '<div data-route />' } } },
    });

    t.after(() => wrapper.unmount());
    await nextTick();
    assert.equal(wrapper.find('[data-machines]').exists(), false);
    assert.equal(wrapper.find('[data-app-shell]').exists(), true);
    assert.equal(wrapper.find('[data-route]').exists(), false);
    assert.deepEqual(authLoads, []);

    globalThis.__gateShell.showConnections = true;
    await nextTick();
    assert.equal(wrapper.find('[data-machines]').exists(), true);
    globalThis.__gateShell.showConnections = false;
    globalThis.__gateShell.status = 'connecting';
    await nextTick();
    assert.equal(wrapper.find('[data-app-shell]').exists(), true);
    assert.equal(wrapper.find('[data-machines]').exists(), false);

    globalThis.__gateShell.everOnline = true;
    globalThis.__gateShell.status = 'online';
    globalThis.__gateAuth.authenticated = true;
    await nextTick();
    assert.deepEqual(authLoads, ['shell-online']);
    assert.equal(wrapper.find('[data-route]').exists(), true);

    const app = wrapper.find('[data-app-shell]').element;

    globalThis.__gateShell.status = 'offline';
    await nextTick();
    assert.equal(wrapper.find('[data-app-shell]').element === app, true);
    assert.equal(globalThis.__gateAuth.authenticated, false);
    globalThis.__gateShell.status = 'locked';
    await nextTick();
    assert.equal(wrapper.find('[data-lock]').exists(), true);
    assert.equal(wrapper.find('[inert]').exists(), true);

    for (const status of ['unpaired', 'revoked', 'identityMismatch', 'incompatible']) {
      globalThis.__gateShell.status = status;
      await nextTick();
      assert.equal(wrapper.find('[data-machines]').exists(), false);
      assert.equal(wrapper.find('[data-app-shell]').element === app, true);
    }

    globalThis.__gateShell.profile = null;
    globalThis.__gateShell.everOnline = false;
    globalThis.__gateShell.status = 'none';
    await nextTick();
    assert.equal(wrapper.find('[data-app-shell]').element === app, true);
    assert.equal(wrapper.find('[data-machines]').exists(), false);
    globalThis.__gateShell.present = false;
    globalThis.__gateAuth.authenticated = false;
    await nextTick();
    assert.match(wrapper.text(), /GrigDesk/);
    assert.equal(wrapper.find('[data-machines]').exists(), false);
  });

test('оболочка: 401 обновляет состояние связи, обычный вход сохраняет reload', async (t) => {
  const { createPinia, setActivePinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const previous = globalThis.location;
  const storage = globalThis.sessionStorage;
  let reloads = 0;
  let refreshes = 0;

  globalThis.location = { reload: () => reloads += 1 };
  globalThis.sessionStorage = { getItem: () => null, setItem() {} };
  globalThis.__authShell = {
    present: true,
    refresh: async () => refreshes += 1,
  };
  t.after(() => {
    globalThis.location = previous;
    globalThis.sessionStorage = storage;
  });

  const module = await compileModule(webFile('src/stores/auth.ts'), {
    stubs: {
      './shell.ts': 'export const useShellStore = () => globalThis.__authShell;',
      '../shared/apiClient.ts': 'export const api = {};',
    },
  });

  setActivePinia(createPinia());

  const store = module.useAuthStore();

  store.authenticated = true;
  store.handleUnauthorized();
  assert.equal(store.authenticated, false);
  assert.equal(refreshes, 1);
  assert.equal(reloads, 0);
  globalThis.__authShell.present = false;
  store.handleUnauthorized();
  assert.equal(reloads, 1);
});
