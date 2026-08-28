import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { NAV_ICONS } from '../../web/src/shared/nav-icons.js';
import { TOOL_REGISTRY } from '../../web/src/shared/tools/registry.js';
import { SYSTEM } from '../../server/src/lib/plugins-registry.js';

const root = new URL('../../', import.meta.url);

test('соседи по правой рейке не делят иконку', () => {
  const used = TOOL_REGISTRY.map((tool) => tool.icon);

  assert.deepEqual({
    duplicates: used.filter((icon, index) => used.indexOf(icon) !== index),
    missing: used.filter((icon) => !NAV_ICONS[icon]),
  }, {
    duplicates: [],
    missing: [],
  });
});

test('каждый рисунок в карте иконок уникален', () => {
  const seen = new Map();
  const collisions = [];
  for (const [name, path] of Object.entries(NAV_ICONS)) {
    const twin = seen.get(path);
    if (twin) {
      collisions.push(`${twin} = ${name}`);
    } else {
      seen.set(path, name);
    }
  }

  assert.deepEqual(collisions, []);
});

test('иконка плагина в манифесте совпадает с иконкой его панели', () => {
  const byPlugin = new Map(TOOL_REGISTRY
    .filter((tool) => tool.plugin)
    .map((tool) => [tool.plugin, tool.icon]));
  const mismatched = SYSTEM
    .filter((plugin) => byPlugin.has(plugin.id))
    .filter((plugin) => plugin.nav?.icon !== byPlugin.get(plugin.id))
    .map((plugin) => plugin.id);

  assert.deepEqual(mismatched, []);
});

// Вторая копия карты иконок уже расходилась с первой: у SSH её просто не было, и
// карточка плагина падала на запасную «деталь пазла».
test('настройки берут иконки из общей карты, а не из своей копии', async () => {
  const settings = await readFile(new URL('web/src/views/SettingsView.vue', root), 'utf8');

  assert.deepEqual({
    ownMap: settings.includes('const PLUGIN_ICON_PATHS = {'),
    sharedImport: settings.includes("from '../shared/nav-icons.js'"),
  }, {
    ownMap: false,
    sharedImport: true,
  });
});
