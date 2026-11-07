import { migrationUrl } from './helpers/compile-vue.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * Контракт читает конечный TS-путь с переходным выбором входа до BUILD.
 * Отсутствие исходника сообщает причину отказа проверяемой регистрации.
 */
async function source(relative, contract) {
  try {
    return await readFile(migrationUrl(relative.slice(4)), 'utf8');
  } catch (error) {
    assert.fail(`${contract}: ${error.message}`);
  }
}

test('SSH зарегистрирован одной встроенной панелью ToolHost', async () => {
  const [catalog, registry, shell, view] = await Promise.all([
    source('web/src/shared/tools/catalog.ts', 'SSH отсутствует в паспорте инструментов'),
    source('web/src/shared/tools/registry.ts', 'SSH отсутствует в реестре ToolHost'),
    source('web/src/shared/layout/AppShell.vue', 'единый AppShell недоступен'),
    source('web/src/views/SshView.vue', 'route-adapter SSH ещё не реализован'),
  ]);
  const registrations = [...catalog.matchAll(/id:\s*['"]ssh['"]/g)].length;
  const hosts = [...shell.matchAll(/<ToolHost\b/g)].length + [...view.matchAll(/<ToolHost\b/g)].length;

  assert.deepEqual({
    registrations,
    hosts,
    routeAdapter: /data-tool-route=["']ssh["']/.test(view),
    panel: /views\/ssh\/SshPanel\.vue/.test(registry),
  }, {
    registrations: 1,
    hosts: 1,
    routeAdapter: true,
    panel: true,
  });
});

test('маршрут SSH делегирует единственному ToolHost', async () => {
  const router = await source('web/src/router.ts', 'маршрут SSH ещё не реализован');

  assert.equal(
    /path:\s*['"]\/ssh['"][\s\S]*?component:\s*\(\)\s*=>\s*import\(['"]\.\/views\/SshView\.vue['"]\)[\s\S]*?tool:\s*['"]ssh['"]/.test(router),
    true,
  );
});
