import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

/**
 * Встроенный паспорт не регистрирует продукт внешнего пакета даже при старых prefs.
 * Настоящие mounted consumers и пакет проверяются отдельным full ToolHost integration.
 */
test('studio3d отсутствует во встроенном каталоге инструментов', async () => {
  const { TOOL_CATALOG } = await compileModule(webFile('src/shared/tools/catalog.ts'));

  assert.equal(TOOL_CATALOG.some((item) => item.id === 'studio3d'), false);
});

test('общий ToolHost остаётся единственным render-site внешних панелей', async () => {
  const [registry, shell, view, loading] = await Promise.all([
    readFile(webFile('src/shared/tools/registry.ts'), 'utf8'),
    readFile(webFile('src/shared/layout/AppShell.vue'), 'utf8'),
    readFile(webFile('src/views/PluginView.vue'), 'utf8'),
    readFile(webFile('src/shared/tools/panelLoading.ts'), 'utf8'),
  ]);

  assert.equal([...shell.matchAll(/<ToolHost\b/g)].length, 1);
  assert.equal([...view.matchAll(/<ToolHost\b/g)].length, 0);
  assert.match(registry, /views\/ext\/PluginModulePanel\.vue/);
  assert.doesNotMatch(registry, /views\/studio3d\/|\bstudio3d\s*:/);
  assert.doesNotMatch(loading, /Studio3dLoading|\bstudio3d\s*:/);
  assert.doesNotMatch(shell, /useStudio3dStore|studio3d\.start|studio3d\.stop/);
  assert.match(shell, /arbiterConversations\.start/);
  assert.match(shell, /arbiterConversations\.stop/);
});

test('продуктовые UI файлы отсутствуют, прежний URL имеет только redirect', async () => {
  for (const relative of ['src/views/Studio3dView.vue', 'src/views/studio3d',
    'src/stores/studio3d.ts', 'src/features/studio3d', 'src/shared/viewer3d']) {
    await assert.rejects(access(webFile(relative)), { code: 'ENOENT' });
  }

  const router = await readFile(webFile('src/router.ts'), 'utf8');

  assert.doesNotMatch(router, /Studio3dView\.vue/);
  assert.match(router, /path:\s*['"]\/3d['"][\s\S]*?redirect:/);
  assert.match(router, /path:\s*['"]\/ext\/studio3d['"]/);
});
