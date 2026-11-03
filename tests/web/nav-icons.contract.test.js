import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { NAV_ICONS, navIconPath, pluginIconPath } from '../../web/src/shared/navIcons.ts';
import { TOOL_CATALOG } from '../../web/src/shared/tools/catalog.ts';
import { SYSTEM } from '../../server/src/lib/pluginsRegistry.ts';

const root = new URL('../../', import.meta.url);

test('соседи по правой рейке не делят иконку', () => {
  const used = TOOL_CATALOG.map((tool) => tool.icon);

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
  const byPlugin = new Map(TOOL_CATALOG
    .filter((tool) => tool.plugin)
    .map((tool) => [tool.plugin, tool.icon]));
  const mismatched = SYSTEM
    .filter((plugin) => byPlugin.has(plugin.id))
    .filter((plugin) => plugin.nav?.icon !== byPlugin.get(plugin.id))
    .map((plugin) => plugin.id);

  assert.deepEqual(mismatched, []);
});

test('каждый системный пункт навигации имеет рисунок в общей карте', () => {
  const missing = SYSTEM
    .filter((plugin) => plugin.nav)
    .filter((plugin) => !NAV_ICONS[plugin.nav.icon])
    .map((plugin) => plugin.id);

  assert.deepEqual(missing, []);
});

// Список и страницы берут controls и иконки из общей границы UI.
// После переноса формы не поддерживают собственные карты рисунков.
test('страницы плагинов используют общую границу UI без собственной карты', async () => {
  for (const name of ['PluginPage', 'PluginWorkspacePage', 'PluginCatalogPanel']) {
    const source = await readFile(new URL(`web/src/views/settings/pages/${name}.vue`, root), 'utf8');

    assert.doesNotMatch(source, /const PLUGIN_ICON_PATHS/);
    assert.match(source, /from '\.\.\/\.\.\/\.\.\/ui\.ts'/);
  }
});


test('плагин задаёт собственный контур, сохраняя именованные и запасные иконки', () => {
  const path = 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3z M8.5 12l2.5 2.5 4.5-5';

  assert.equal(navIconPath(`svg:${path}`), path);
  assert.equal(pluginIconPath({ id: 'custom', nav: { icon: `svg: ${path} ` } }), path);
  assert.equal(navIconPath('search'), NAV_ICONS.search);
  assert.equal(pluginIconPath({ id: 'github', nav: { icon: 'unknown' } }), NAV_ICONS.github);
  assert.equal(pluginIconPath(null), NAV_ICONS.plugin);

  for (const icon of [
    'constructor', '__proto__', 'unknown', null, undefined, 'svg:', 'svg:M',
    'svg:L1 1', 'svg:M0 0<script>alert(1)</script>',
    'svg:M0 0" onload="alert(1)', 'svg:https://example.invalid/icon.svg',
    'svg:data:image/svg+xml,<svg/>', `svg:M0 0${' L1 1'.repeat(1000)}`,
  ]) {
    assert.equal(navIconPath(icon), NAV_ICONS.plugin, String(icon).slice(0, 80));
  }
});
