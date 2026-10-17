import assert from 'node:assert/strict';
import test from 'node:test';

import catalog from '../fixtures/executor-settings/synthetic-catalog.json' with { type: 'json' };
import { compileSettingsView } from './helpers/settings-view.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('карточка загружает нативную схему только при раскрытии', async (t) => {
  globalThis.__COCKPIT_VERSION__ = '0.0.0-test';
  globalThis.__COCKPIT_SHA__ = 'testsha';

  const browser = await installUiBrowser(t, 'http://cockpit.test/#/settings');

  browser.localStorage.setItem('cockpit-settings-tab', 'providers');

  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const loads = [];
  const providers = ['future-provider', 'neighbor'].map((id) => ({
    id,
    name: id,
    available: true,
    installed: true,
    settingsCatalog: true,
    settings: [],
    models: [],
  }));
  const prov = reactive({
    providers,
    usage: {},
    mcp: {},
    loaded: true,
    visibleModels: () => [],
    async load() {},
    async loadUsage() {},
    async loadMcp() {},
  });

  globalThis.__nativeSettingsPageStores = {
    useProvidersStore: () => prov,
    useAuthStore: () => ({ login: 'me' }),
    usePluginsStore: () => ({
      loaded: true,
      list: [],
      enabled: () => true,
      async load() {},
    }),
    useChatStore: () => ({ compactWindow: 0 }),
    useDeviceStore: () => ({ canInstall: false, wakeLock: false }),
    useCockpitUpdateStore: () => ({ state: null, async load() {} }),
  };
  globalThis.__nativeSettingsPageApi = {
    async get() {
      return {};
    },
    async post() {
      return {};
    },
  };
  globalThis.__nativeSettingsPageNativeStore = {
    panel: () =>
      reactive({
        catalog,
        loading: false,
        saving: false,
        drafts: {},
        errors: {},
      }),
    async load(id) {
      loads.push(id);
    },
    async save() {},
    async reset() {},
  };

  const Component = await compileSettingsView({ prefix: '__nativeSettingsPage', nativeSettings: true });
  const wrapper = mount(Component, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__nativeSettingsPageApi;
    delete globalThis.__nativeSettingsPageStores;
    delete globalThis.__nativeSettingsPageNativeStore;
  });
  await flushPromises();
  assert.equal(loads.length, 0);
  await wrapper.get('#provider-toggle-future-provider').trigger('click');
  await flushPromises();

  assert.deepEqual(loads, ['future-provider']);
  assert.equal(wrapper.get('[data-provider-id="future-provider"]').find('[role="switch"]').exists(), true);
  await wrapper.get('#provider-toggle-neighbor').trigger('click');
  await flushPromises();
  assert.deepEqual(loads, ['future-provider', 'neighbor']);
});
