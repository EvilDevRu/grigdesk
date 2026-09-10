import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(relative, contract) {
  try {
    return await readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');
  } catch (error) {
    assert.fail(`${contract}: ${error.message}`);
  }
}

test('«Базы» зарегистрированы одной встроенной панелью ToolHost', async () => {
  const [catalog, registry, shell, view] = await Promise.all([
    source('web/src/shared/tools/catalog.ts', 'DB отсутствует в паспорте инструментов'),
    source('web/src/shared/tools/registry.ts', 'DB отсутствует в реестре ToolHost'),
    source('web/src/shared/layout/AppShell.vue', 'единый AppShell недоступен'),
    source('web/src/views/DbView.vue', 'route-adapter DB ещё не реализован'),
  ]);
  const registrations = [...catalog.matchAll(/id:\s*['"]db['"]/g)].length;
  const hosts = [...shell.matchAll(/<ToolHost\b/g)].length + [...view.matchAll(/<ToolHost\b/g)].length;

  assert.deepEqual({
    registrations,
    hosts,
    routeAdapter: /data-tool-route=["']db["']/.test(view),
    panel: /views\/db\/DbPanel\.vue/.test(registry),
  }, {
    registrations: 1,
    hosts: 1,
    routeAdapter: true,
    panel: true,
  });
});

test('маршрут DB делегирует единственному ToolHost', async () => {
  const router = await source('web/src/router.js', 'маршрут DB ещё не реализован');

  assert.equal(
    /path:\s*['"]\/db['"][\s\S]*?component:\s*\(\)\s*=>\s*import\(['"]\.\/views\/DbView\.vue['"]\)[\s\S]*?tool:\s*['"]db['"]/.test(router),
    true,
  );
});
