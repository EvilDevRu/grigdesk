// Страница пользовательского плагина в рейке: стор превращает включённый плагин с папкой
// web и пунктом навигации в страницу по /ext/<id>, реестр — в инструмент с общей
// панелью-iframe; выключенный или без страницы в рейку не попадает.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { normalizeNavItem, usePluginsStore } from '../../web/src/stores/plugins.js';
import { pluginPageRoute } from '../../web/src/shared/tools/catalog.ts';
import { compileModule, webFile } from './helpers/compile-vue.js';

const { TOOL_REGISTRY, pluginTools, toolById, toolsOf } = await compileModule(
  webFile('src/shared/tools/registry.ts'), {
    stubs: {
      '../asyncView.ts': 'export const asyncView = (loader) => ({ __asyncLoader: loader });',
      ...Object.fromEntries([
        'code/CodePanel', 'shelf/TaskShelfPanel', 'studio3d/Studio3dPanel', 'terminal/TerminalPanel',
        'ssh/SshPanel', 'db/DbPanel', 'docker/DockerPanel', 'ext/PluginFramePanel',
      ].map((name) => [`../../views/${name}.vue`, 'export default {};'])),
    },
  },
);

function plugin(overrides = {}) {
  return {
    id: 'viewer',
    name: 'Обзор',
    version: '0.1.0',
    description: '',
    system: false,
    enabled: true,
    nav: { path: '/anything', label: 'Обзор', icon: 'plugin', group: 'dock', order: 5 },
    web: '/api/ext/viewer/web/',
    settings: [],
    values: {},
    placements: [],
    ...overrides,
  };
}

test('пункт навигации плагина со страницей ведёт на /ext/<id>, а не на nav.path манифеста', () => {
  assert.equal(normalizeNavItem(plugin()).to, pluginPageRoute('viewer'));
  assert.equal(normalizeNavItem(plugin({ web: null })).to, '/anything');
  assert.equal(normalizeNavItem(plugin({ system: true, web: '/x' })).to, '/anything');
});

test('стор отдаёт страницы только включённых плагинов с папкой web и навигацией', () => {
  setActivePinia(createPinia());
  const store = usePluginsStore();

  store.list = [
    plugin(),
    plugin({ id: 'off', enabled: false }),
    plugin({ id: 'noweb', web: null }),
    plugin({ id: 'nonav', nav: null }),
    plugin({ id: 'sys', system: true }),
  ];
  store.loaded = true;

  assert.deepEqual(store.webPages, [{
    id: 'viewer', src: '/api/ext/viewer/web/', label: 'Обзор', icon: 'plugin', order: 5, group: 'dock',
  }]);
  // Навигация по-прежнему считает всех включённых с nav — мёртвые ссылки отсеивает AppShell
  // по роутеру; у страницы плагина адрес живой.
  assert.deepEqual(store.dockNav.find((item) => item.id === 'viewer')?.to, '/ext/viewer');
});

test('реестр добавляет страницу плагина инструментом с панелью-iframe поверх встроенных', () => {
  const plugins = {
    webPages: [{
      id: 'viewer', src: '/api/ext/viewer/web/', label: 'Обзор', icon: 'plugin', order: 5, group: 'dock',
    }],
  };
  const tools = pluginTools(plugins);

  assert.equal(tools.length, 1);
  assert.equal(tools[0].id, 'viewer');
  assert.equal(tools[0].route, '/ext/viewer');
  assert.equal(tools[0].plugin, 'viewer', 'владелец панели — сам плагин: тумблер гасит её');
  assert.equal(tools[0].hotkey, '');
  assert.deepEqual(tools[0].panelProps, { src: '/api/ext/viewer/web/', label: 'Обзор' });
  assert.ok(tools[0].component, 'панель-iframe подставлена');

  assert.equal(toolsOf(plugins).length, TOOL_REGISTRY.length + 1);
  assert.equal(toolById(plugins, 'viewer')?.route, '/ext/viewer');
  assert.equal(toolById(plugins, 'code')?.id, 'code');
  assert.equal(toolById(plugins, 'nobody'), null);
  assert.equal(toolById({ webPages: [] }, 'viewer'), null);
});
