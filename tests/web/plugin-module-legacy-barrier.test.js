import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { loadProductModule } from './helpers/compile-vue.js';
import { pluginCard, registryModule } from './helpers/pluginModuleContract.js';
import { api } from '../../web/src/shared/apiClient.ts';

const { usePluginsStore } = await loadProductModule('src/stores/plugins.ts');
const { pluginTools } = await registryModule();

test('PM-LEGACY-01: три v1 панели сохраняют порядок', async (t) => {
  setActivePinia(createPinia());

  const ids = ['install-demo', 'performance-audit', 's2-emulator'];
  const cards = ids.map((id, order) => pluginCard({
    id,
    entrypoints: { web: {
      entry: `/api/ext/${id}/module/panel.js`,
      css: [],
      locales: {},
    } },
    nav: {
       path: '/old', 
      label: id, 
      group: 'dock', 
      order 
    },
  }));

  t.mock.method(api, 'get', async () => ({ plugins: cards }));

  const store = usePluginsStore();

  await store.load();
  assert.equal(store.loadError, null);
  assert.equal(store.loaded, true);
  assert.deepEqual(store.dockNav.map((item) => item.to), ids.map((id) => `/ext/${id}`));

  const tools = pluginTools(store);

  assert.deepEqual(tools.map((item) => item.id), ids);

  for (const [index, tool] of tools.entries()) {
    assert.equal(tool.route, `/ext/${ids[index]}`);
    assert.equal(tool.panelProps.pluginId, ids[index]);
    assert.deepEqual(tool.panelProps.descriptor, cards[index].entrypoints.web);
    assert.equal('src' in tool.panelProps, false);
    assert.ok(tool.component);
    assert.equal(tool.detachable, false);
  }
});

test('PM-LEGACY-02: declared module и прежний отбор enabled/system/nav', async (t) => {
  setActivePinia(createPinia());

  const store = usePluginsStore();
  const valid = pluginCard();

  t.mock.method(api, 'get', async () => ({ plugins: [valid,
    pluginCard({ id: 'empty', entrypoints: {} }),
    pluginCard({ id: 'off', enabled: false }),
    pluginCard({ id: 'sys', system: true }),
    pluginCard({ id: 'nonav', nav: null }),
  ] }));
  await store.load();
  assert.equal(store.loadError, null);
  assert.deepEqual(store.modulePages.map((item) => item.id), ['ui-module']);

  const before = store.list.map((item) => item.id);

  api.get.mock.mockImplementation(async () => ({ plugins: [
    pluginCard({ entrypoints: { web: { entry: 'https://other.invalid/bad.js' } } }),
  ] }));
  await store.load();
  assert.ok(store.loadError);
  assert.deepEqual(store.list.map((item) => item.id), before);
});
