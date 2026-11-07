import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { loadProductModule } from './helpers/compile-vue.js';
import { api } from '../../web/src/shared/apiClient.ts';
import { registryModule } from './helpers/pluginModuleContract.js';

import { cardV1, webEntryV1 as descriptor } from './helpers/pluginV1.js';

const { usePluginsStore, normalizeNavItem } = await loadProductModule('src/stores/plugins.ts');
const { pluginTools } = await registryModule();

test('PM-TOOLS: DTO модуля, /ext, выключение и единственный вид панели', async (t) => {
  setActivePinia(createPinia());

  const store = usePluginsStore();
  const card = cardV1();

  t.mock.method(api, 'get', async () => ({ plugins: [card] }));
  await store.load();
  assert.equal(store.loadError, null);
  assert.ok(Array.isArray(store.modulePages), 'Каталог должен проецировать модульные панели');
  assert.equal(store.modulePages.length, 1);
  assert.equal(normalizeNavItem(cardV1()).to, '/ext/ui-module');

  const tools = pluginTools(store);

  assert.equal(tools.length, 1);
  assert.equal(tools[0].route, '/ext/ui-module');
  assert.equal(tools[0].detachable, false);
  assert.equal(tools[0].panelProps.pluginId, 'ui-module');
  assert.deepEqual(tools[0].panelProps.descriptor, descriptor);
  assert.equal(tools[0].panelProps.label, card.name);
  assert.equal('src' in tools[0].panelProps, false);

  store.list[0].enabled = false;
  assert.equal(store.modulePages.length, 0);
  assert.equal(pluginTools(store).length, 0);
});

test('PM-TOOLS: неверный DTO/чужой URL не публикуется; старый каталог принимается', async (t) => {
  setActivePinia(createPinia());

  const store = usePluginsStore();

  t.mock.method(api, 'get', async () => ({ plugins: [cardV1({ entrypoints: {} })] }));
  await store.load();
  assert.equal(store.loadError, null);

  for (const webModule of [
    { ...descriptor, entry: 'https://other.invalid/panel.js' },
    { ...descriptor, entry: '/api/ext/another/module/panel.js' },
    { ...descriptor, css: 'panel.css' },
    { ...descriptor, locales: { ru: '/api/secrets' } },
  ]) {
    api.get.mock.mockImplementation(async () => ({ plugins: [cardV1({ entrypoints: { web: webModule } })] }));
    await store.load();
    assert.ok(store.loadError, 'Невалидный модуль не должен заменять принятый каталог');
    assert.equal(store.list[0].entrypoints.web, undefined);
  }
});

test('PM-LAUNCH-MODULE-ONLY: module-only, недоступный id и фокус своей /ext', async (t) => {
  const { compileModule, webFile } = await import('./helpers/compile-vue.js');

  setActivePinia(createPinia());

  const store = usePluginsStore();
  const calls = [];
  const dock = {
    runtime: {},
    enqueue: (...args) => calls.push(['intent', ...args]),
    open: (id) => calls.push(['open', id]),
    setRuntime: (id, value) => calls.push(['focus', id, value]),
  };

  store.list = [cardV1()];
  globalThis.__pluginLauncherStore = store;
  t.after(() => delete globalThis.__pluginLauncherStore);

  const { launchTool } = await compileModule(webFile('src/shared/tools/launcher.ts'), {
    stubs: {
      '../../stores/plugins.ts': 'export const usePluginsStore = () => globalThis.__pluginLauncherStore;',
      '../../stores/toolWindows.ts': 'export const getToolWindowCoordinator = () => null;',
    },
  });
  const context = {
    route: {
      path: '/chats',
      meta: {},
      params: {}
    },
    router: { push: async (value) => calls.push(['push', value]) },
    dock,
    canDock: () => true,
  };

  assert.equal(await launchTool(context, 'ui-module', { type: 'probe' }), true);
  assert.deepEqual(calls.slice(0, 2), [['intent', 'ui-module', { type: 'probe' }], ['open', 'ui-module']]);
  assert.equal(await launchTool(context, 'unknown'), false);
  store.list[0].enabled = false;
  assert.equal(await launchTool(context, 'ui-module'), false);
  store.list[0].enabled = true;
  context.route = {
    path: '/ext/ui-module',
    meta: { tool: 'ext' },
    params: { id: 'ui-module' }
  };
  calls.length = 0;
  assert.equal(await launchTool(context, 'ui-module'), true);
  assert.deepEqual(calls.map((call) => call[0]), ['focus']);
});

test('V1-PANELS: настоящий store открывает только объявленную совместимую панель', async (t) => {
  setActivePinia(createPinia());

  const store = usePluginsStore();
  let card = cardV1();

  t.mock.method(api, 'get', async () => ({ plugins: [card] }));
  await store.load();
  assert.equal(store.loadError, null);
  assert.equal(store.modulePages.length, 1);

  const [tool] = pluginTools(store);

  assert.equal(tool.route, '/ext/ui-module');
  assert.equal(tool.detachable, false);
  assert.deepEqual(tool.panelProps.descriptor, descriptor);
  assert.equal('src' in tool.panelProps, false);

  for (const overrides of [
    { contributes: {
      panels: [],
      slots: [],
      commands: [],
      themes: []
    } },
    { enabled: false },
    { compatibility: {
      status: 'incompatible',
      code: 'manifest_incompatible',
      reason: 'Старый формат'
    } },
  ]) {
    card = cardV1(overrides);
    await store.load();
    assert.equal(store.loadError, null);
    assert.equal(pluginTools(store).length, 0);
  }
});
