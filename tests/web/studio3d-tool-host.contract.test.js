import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkUiBoundary } from '../../web/scripts/check-ui-boundary.mjs';

test('перенесённая панель 3D соблюдает общую границу UiPressable', () => {
  const { errors } = checkUiBoundary();

  assert.deepEqual(errors.filter((error) => error.includes('studio3d/Studio3dPanel.vue')), []);
});

/**
 * Контракт читает только исходники панели, без живого состояния приложения.
 * Отсутствующий файл даёт понятную причину отказа конкретного требования.
 */
async function source(relative, contract) {
  try {
    return await readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');
  } catch (error) {
    assert.fail(`${contract}: ${error.message}`);
  }
}

test('«3D» зарегистрированы одной встроенной панелью ToolHost', async () => {
  const [catalog, registry, shell, view] = await Promise.all([
    source('web/src/shared/tools/catalog.ts', '3D отсутствует в паспорте инструментов'),
    source('web/src/shared/tools/registry.ts', '3D отсутствует в реестре ToolHost'),
    source('web/src/shared/layout/AppShell.vue', 'единый AppShell недоступен'),
    source('web/src/views/Studio3dView.vue', 'route-adapter 3D ещё не реализован'),
  ]);
  const registrations = [...catalog.matchAll(/id:\s*['"]studio3d['"]/g)].length;
  const hosts = [...shell.matchAll(/<ToolHost\b/g)].length + [...view.matchAll(/<ToolHost\b/g)].length;

  assert.deepEqual({
    registrations,
    hosts,
    routeAdapter: /data-tool-route=["']studio3d["']/.test(view),
    panel: /views\/studio3d\/Studio3dPanel\.vue/.test(registry),
  }, {
    registrations: 1,
    hosts: 1,
    routeAdapter: true,
    panel: true,
  });
});

test('маршрут 3D делегирует единственному ToolHost', async () => {
  const router = await source('web/src/router.js', 'маршрут 3D ещё не реализован');

  const route = /path:\s*['"]\/3d['"][\s\S]*?component:\s*/;
  const panel = /\(\)\s*=>\s*import\(['"]\.\/views\/Studio3dView\.vue['"]\)/;
  const tool = /[\s\S]*?tool:\s*['"]studio3d['"]/;

  assert.equal(new RegExp(route.source + panel.source + tool.source).test(router), true);

});
