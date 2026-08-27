import assert from 'node:assert/strict';
import test from 'node:test';

import { compileSettingsView } from './helpers/settings-view.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('числовая настройка SSH рисуется с границами схемы и сохраняется числом', async (t) => {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/settings');
  browser.localStorage.setItem('cockpit-settings-tab', 'plugins');
  globalThis.__COCKPIT_VERSION__ = '0.0.0-test';
  globalThis.__COCKPIT_SHA__ = 'testsha';
  globalThis.__pluginNumberApi = { async get() { return {}; }, async post() { return {}; } };
  const saves = [];
  const plugins = {
    loaded: true,
    list: [{
      id: 'ssh', name: 'SSH', version: '1.0.0', system: true, enabled: true,
      description: 'Надзорный SSH', nav: { label: 'SSH', icon: 'terminal' },
      needsRestart: false,
      settings: [{
        key: 'outputLimitKiB', label: 'Лимит вывода, KiB', type: 'number',
        min: 4, max: 1024, step: 4, default: 64,
      }],
      values: { outputLimitKiB: 64 },
    }],
    enabled: () => true,
    async load() {},
    async toggle() {},
    async saveSettings(id, values) { saves.push([id, structuredClone(values)]); },
  };
  globalThis.__pluginNumberStores = {
    useProvidersStore: () => ({ providers: [], usage: {}, loaded: true, showAllModels: false, visibleModels: () => [], async load() {}, async loadUsage() {} }),
    useUiContextStore: () => ({ set() {}, clear() {} }),
    useAuthStore: () => ({ login: 'me', async logoutAll() {} }),
    usePluginsStore: () => plugins,
    useChatStore: () => ({ compactWindow: 0 }),
    useCompanionStore: () => ({ deviceEnabled: true, setDeviceEnabled() {} }),
    usePwaStore: () => ({ canInstall: false, wakeLock: false, async install() {} }),
    useCockpitUpdateStore: () => ({ state: null, async load() {} }),
  };
  const [{ mount, flushPromises }, SettingsView] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileSettingsView({ prefix: '__pluginNumber' }),
  ]);
  const wrapper = mount(SettingsView, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__pluginNumberApi;
    delete globalThis.__pluginNumberStores;
    delete globalThis.__COCKPIT_VERSION__;
    delete globalThis.__COCKPIT_SHA__;
  });
  await flushPromises();
  const input = wrapper.find('input[type="number"]');
  if (input.exists()) {
    await input.setValue('68');
    await wrapper.get('.plugin-save').trigger('click');
    await flushPromises();
  }

  assert.deepEqual({
    min: input.exists() ? input.attributes('min') : null,
    max: input.exists() ? input.attributes('max') : null,
    step: input.exists() ? input.attributes('step') : null,
    save: saves[0],
  }, {
    min: '4',
    max: '1024',
    step: '4',
    save: ['ssh', { outputLimitKiB: 68 }],
  });
});
