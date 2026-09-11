import assert from 'node:assert/strict';
import test from 'node:test';

import { compilePluginsCatalog } from './helpers/plugins-catalog.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('числовая настройка SSH рисуется с границами схемы и сохраняется числом', async (t) => {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/settings');
  const saves = [];
  const plugins = {
    loaded: true,
    list: [{
      id: 'ssh', name: 'SSH', version: '1.0.0', system: true, enabled: true,
      category: 'dev', description: 'Надзорный SSH', nav: { label: 'SSH', icon: 'terminal' },
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
    usePluginsStore: () => plugins,
    useProvidersStore: () => ({
      providers: [],
      visibleModels: () => [],
      modelOf: () => ({ id: '', provider: null, model: null }),
    }),
  };

  const [{ mount, flushPromises }, PluginsCatalog] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compilePluginsCatalog({ prefix: '__pluginNumber' }),
  ]);
  const wrapper = mount(PluginsCatalog, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__pluginNumberStores;
  });
  await flushPromises();

  await wrapper.get('[data-plugin-id="ssh"] .plugin-tile-open').trigger('click');
  await flushPromises();

  const input = wrapper.get('.ui-dialog input[type="number"]');
  await input.setValue('68');
  await wrapper.get('.plugin-save').trigger('click');
  await flushPromises();

  assert.deepEqual({
    min: input.attributes('min'),
    max: input.attributes('max'),
    step: input.attributes('step'),
    save: saves[0],
  }, {
    min: '4',
    max: '1024',
    step: '4',
    save: ['ssh', { outputLimitKiB: 68 }],
  });
});
