import { pluginCard } from './helpers/pluginModuleContract.js';
import { loadProductModule } from './helpers/compile-vue.js';
// Страница пользовательского плагина в рейке: стор превращает включённый плагин с папкой
// web и пунктом навигации в страницу по /ext/<id>, реестр — в инструмент с общей
// панелью-iframe; выключенный или без страницы в рейку не попадает.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';

const { normalizeNavItem, usePluginsStore } = await loadProductModule('src/stores/plugins.ts');

import { pluginPageRoute } from '../../web/src/shared/tools/catalog.ts';
import { compileModule, webFile } from './helpers/compile-vue.js';

const { TOOL_REGISTRY, pluginTools, toolById, toolsOf } = await compileModule(
  webFile('src/shared/tools/registry.ts'), {
    stubs: {
      '../asyncView.ts': 'export const asyncView = (loader) => ({ __asyncLoader: loader });',
      ...Object.fromEntries([
        'code/CodePanel', 'shelf/TaskShelfPanel', 'studio3d/Studio3dPanel', 'terminal/TerminalPanel',
        'ssh/SshPanel', 'db/DbPanel', 'docker/DockerPanel', 'ext/PluginModulePanel',
      ].map((name) => [`../../views/${name}.vue`, 'export default {};'])),
    },
  },
);

/**
 * Публичная карточка содержит только модульную панель из деклараций.
 * Путь навигации намеренно чужой: нормализатор должен выбрать собственный /ext.
 */
function plugin(overrides = {}) {
  return pluginCard({
    id: 'viewer',
    name: 'Обзор',
    entrypoints: { web: {
      entry: '/api/ext/viewer/module/panel.js',
      css: [],
      locales: {},
    } },
    nav: {
      path: '/anything',
      label: 'Обзор',
      group: 'dock',
      order: 5,
    },
    ...overrides,
  });
}

test('пункт навигации модуля ведёт на /ext/<id>', () => {
  assert.equal(normalizeNavItem(plugin()).to, pluginPageRoute('viewer'));
  assert.equal(normalizeNavItem(plugin({ entrypoints: {} })).to, '/anything');
  assert.equal(normalizeNavItem(plugin({ system: true })).to, '/anything');
});

test('стор отдаёт только включённые объявленные панели', () => {
  setActivePinia(createPinia());

  const store = usePluginsStore();

  store.list = [plugin(), plugin({ id: 'off', enabled: false }),
    plugin({ id: 'noweb', entrypoints: {} }), plugin({ id: 'nonav', nav: null }),
    plugin({ id: 'sys', system: true })];
  store.loaded = true;
  assert.deepEqual(store.modulePages.map((item) => item.id), ['viewer']);
  assert.equal(store.modulePages[0].descriptor.entry, '/api/ext/viewer/module/panel.js');
  assert.equal(store.dockNav.find((item) => item.id === 'viewer')?.to, '/ext/viewer');
});

test('реестр добавляет модульную панель поверх встроенных', () => {
  const plugins = { modulePages: [{
    id: 'viewer',
    label: 'Обзор',
    icon: '',
    order: 5,
  }] };
  const tools = pluginTools(plugins);

  assert.equal(tools.length, 1);
  assert.equal(tools[0].route, '/ext/viewer');
  assert.equal(tools[0].plugin, 'viewer');
  assert.equal(tools[0].hotkey, '');
  assert.equal(tools[0].panelProps.pluginId, 'viewer');
  assert.equal('src' in tools[0].panelProps, false);
  assert.ok(tools[0].component);
  assert.equal(tools[0].detachable, false);
  assert.equal(toolsOf(plugins).length, TOOL_REGISTRY.length + 1);
  assert.equal(toolById(plugins, 'viewer')?.route, '/ext/viewer');
  assert.equal(toolById(plugins, 'code')?.id, 'code');
  assert.equal(toolById(plugins, 'nobody'), null);
  assert.equal(toolById({ modulePages: [] }, 'viewer'), null);
});
