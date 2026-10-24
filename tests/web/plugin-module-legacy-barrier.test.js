import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { loadProductModule } from './helpers/compile-vue.js';
import { pluginCard, registryModule } from './helpers/pluginModuleContract.js';
import { api } from '../../web/src/shared/apiClient.ts';

const { usePluginsStore } = await loadProductModule('src/stores/plugins.ts');
const { pluginTools } = await registryModule();

test('PM-LEGACY-01: три api1 страницы и каталог без webModule сохраняют iframe и порядок', async (t) => {
  setActivePinia(createPinia());

  const ids = ['install-demo', 'performance-audit', 's2-emulator'];
  const cards = ids.map((id, order) => pluginCard({
    id,
    web: `/api/ext/${id}/web/`,
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
    assert.deepEqual(tool.panelProps, { src: cards[index].web, label: ids[index] });
    assert.ok(tool.component);
    assert.notEqual(tool.detachable, false);
  }
});

test('PM-LEGACY-02: web строка/null и прежний отбор enabled/system/nav', async (t) => {
  setActivePinia(createPinia());

  const store = usePluginsStore();
  const valid = pluginCard({ id: 'legacy', web: '/api/ext/legacy/web/' });

  t.mock.method(api, 'get', async () => ({ plugins: [
    valid,
    pluginCard({ id: 'empty', web: null }),
    pluginCard({
       id: 'off', 
      web: '/off/', 
      enabled: false 
    }),
    pluginCard({
       id: 'sys', 
      web: '/sys/', 
      system: true 
    }),
    pluginCard({
       id: 'nonav', 
      web: '/nonav/', 
      nav: null 
    }),
  ] }));
  await store.load();
  assert.equal(store.loadError, null);
  assert.deepEqual(store.webPages.map((item) => item.id), ['legacy']);

  const before = store.list.map((item) => item.id);

  api.get.mock.mockImplementation(async () => ({ plugins: [pluginCard({ web: { entry: 'bad.js' } })] }));
  await store.load();
  assert.ok(store.loadError);
  assert.deepEqual(store.list.map((item) => item.id), before);
});
