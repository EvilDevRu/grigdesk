import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { NAV_ICONS, navIconPath } from '../../web/src/shared/navIcons.ts';
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

test('каждый системный пункт навигации имеет отдельный файл PNG', async () => {
  const icons = SYSTEM.filter((plugin) => plugin.nav).map((plugin) => plugin.icon);

  assert.equal(new Set(icons).size, icons.length);

  for (const icon of icons) {
    assert.match(icon, /^\/plugin-icons\/[a-z0-9-]+\.png$/u);

    const bytes = await readFile(new URL(`web/public${icon}`, root));

    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
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


test('внутренние имена сохраняют карту, авторские SVG-контуры не принимаются', () => {
  assert.equal(navIconPath('search'), NAV_ICONS.search);
  assert.equal(navIconPath(null), NAV_ICONS.plugin);

  for (const icon of ['constructor', '__proto__', 'unknown', undefined, 'svg:M0 0 L1 1',
    'svg:M0 0<script>alert(1)</script>', 'https://example.invalid/icon.svg']) {
    assert.equal(navIconPath(icon), NAV_ICONS.plugin);
  }
});
