import assert from 'node:assert/strict';
import test from 'node:test';
import { descriptor, pluginCard } from './helpers/pluginModuleContract.js';
import { serviceFixture } from './helpers/pluginModuleServices.js';

/**
 * Док и каталог настоящие, маршрут управляется ref как у Vue Router.
 * Снимок защищает чужой инструмент, включая геометрию и предпочтения разворачивания.
 */
async function panelFixture(t, width) {
  const f = await serviceFixture(t, 'pluginRuntime/panel.ts', {
    docks: 'stores/dock.ts', plugins: 'stores/plugins.ts',
  });

  f.pinia.setActivePinia(f.pinia.createPinia());

  const dock = f.docks.useDockStore();
  const plugins = f.plugins.usePluginsStore();
  const currentRoute = f.vue.ref({
    path: '/chats',
    meta: {},
    params: {}
  });
  const pushed = [];
  const router = { currentRoute, push: async (value) => pushed.push(value) };
  const abort = new AbortController();

  plugins.list = [pluginCard({ entrypoints: { web: descriptor } })];
  dock.open('code');
  dock.setWidth(615);
  dock.setExpanded(true);

  const panel = f.createPluginPanel('ui-module', {
    router,
    dock,
    isAlive: () => !abort.signal.aborted,
    canDock: () => width >= 900,
  });
  const snapshot = () => JSON.parse(JSON.stringify(dock.$state));

  return {
    ...f,
    dock,
    plugins,
    currentRoute,
    router,
    pushed,
    abort,
    panel,
    snapshot
  };
}

for (const width of [390, 899, 900, 1280]) {
  test(`PM-OWN-PANEL: собственный док и /ext, чужая геометрия при ${width}px`, async (t) => {
    const f = await panelFixture(t, width);
    const before = f.snapshot();

    assert.equal(await f.panel.close(), false);
    assert.equal(f.panel.setExpanded(false), false);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(await f.panel.open(), true);

    if (width >= 900) {
      assert.equal(f.dock.activeTool, 'ui-module');
      assert.equal(f.dock.width, before.width);
      assert.equal(f.dock.preferredWidth, before.preferredWidth);
      assert.equal(f.dock.expandedPreferences.code, true);
      assert.equal(f.panel.setExpanded(true), true);
      assert.equal(f.dock.isExpanded, true);
      assert.equal(await f.panel.close(), true);
      assert.equal(f.dock.isOpen, false);
      assert.equal(f.panel.setExpanded(true), false);
    } else {
      assert.deepEqual(f.pushed, ['/ext/ui-module']);
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.panel.setExpanded(true), false);
    }

    f.dock.open('code');
    f.currentRoute.value = {
      path: '/ext/other',
      meta: { tool: 'ext' },
      params: { id: 'other' }
    };

    const other = f.snapshot();

    assert.equal(await f.panel.close(), false);
    assert.equal(f.panel.setExpanded(true), false);
    assert.deepEqual(f.snapshot(), other);
    assert.equal(await f.panel.open(), true);
    assert.equal(f.pushed.at(-1), '/ext/ui-module');
    assert.equal(f.dock.activeTool, 'code');
    f.currentRoute.value = {
      path: '/ext/ui-module',
      meta: { tool: 'ext' },
      params: { id: 'ui-module' }
    };

    const pushesBeforeFocus = f.pushed.length;

    assert.equal(await f.panel.open(), true);
    assert.equal(f.pushed.length, pushesBeforeFocus);

    const own = f.snapshot();

    assert.equal(f.panel.setExpanded(true), false);
    assert.equal(await f.panel.close(), true);
    assert.equal(f.pushed.at(-1), '/chats');
    assert.deepEqual(f.snapshot(), own);
    f.abort.abort();
    assert.equal(await f.panel.open(), false);
    assert.equal(await f.panel.close(), false);
    assert.equal(f.panel.setExpanded(true), false);
    assert.deepEqual(f.snapshot(), own);
  });
}
