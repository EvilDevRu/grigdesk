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

test('SSH зарегистрирован одной встроенной панелью ToolHost', async () => {
  const [registry, shell, view] = await Promise.all([
    source('web/src/shared/tools/registry.js', 'SSH отсутствует в реестре ToolHost'),
    source('web/src/shared/layout/AppShell.vue', 'единый AppShell недоступен'),
    source('web/src/views/SshView.vue', 'route-adapter SSH ещё не реализован'),
  ]);
  const registrations = [...registry.matchAll(/id:\s*['"]ssh['"]/g)].length;
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
  const router = await source('web/src/router.js', 'маршрут SSH ещё не реализован');

  assert.equal(
    /path:\s*['"]\/ssh['"][\s\S]*?component:\s*\(\)\s*=>\s*import\(['"]\.\/views\/SshView\.vue['"]\)[\s\S]*?tool:\s*['"]ssh['"]/.test(router),
    true,
  );
});
