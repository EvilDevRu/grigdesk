import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type * as Pinia from 'pinia';

const { createPinia, setActivePinia }: typeof Pinia = await import(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url).href
);

import { loadMigrationModule, migrationHarness } from './helpers/compile-vue.js';

interface Baseline {
  stores: Record<string, { id: string; state: Record<string, unknown> }>;
  routes: Array<{ path: string; component?: string }>;
}

const baseline: Baseline = JSON.parse(await readFile(
  new URL('../fixtures/webRuntimeBaseline.json', import.meta.url), 'utf8',
));
const scope: { pairs: Record<string, string> } = JSON.parse(await readFile(
  new URL('../fixtures/webMigrationScope.json', import.meta.url), 'utf8',
));

test('RUNTIME-store-shapes', async () => {
  for (const [oldPath, newPath] of Object.entries(scope.pairs)) {
    const expected = baseline.stores[newPath];

    if (!expected) {
      continue;
    }

    setActivePinia(createPinia());

    const module = await loadMigrationModule(oldPath.slice(4), newPath.slice(4));
    const factory = Object.values(module).find((value) => (
      typeof value === 'function' && '$id' in value
    ));

    assert.ok(factory && typeof factory === 'function', newPath);

    const store = factory();

    assert.equal(store.$id, expected.id, newPath);
    assert.deepEqual(JSON.parse(JSON.stringify(store.$state)), expected.state, newPath);
    store.$dispose();
  }
});

test('RUNTIME-release-lifecycle', async (t) => {
  setActivePinia(createPinia());

  const calls: string[] = [];
  let reply = { job: null as { id: string; status: string } | null, latest: null };

  migrationHarness.api = {
    async get(url: string) {
      calls.push(url);

      return reply;
    },
  };

  const { useGrigDeskUpdateStore } = await loadMigrationModule(
    'src/stores/grigdesk-update.js', 'src/stores/grigdeskUpdate.ts',
  );
  const store = useGrigDeskUpdateStore();

  t.mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => store.stop());
  store.start();
  store.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(calls.length, 3, 'повторный start не создаёт второго status timer');

  reply = { job: { id: 'job', status: 'building' }, latest: null };
  await store.load();
  store.startJobPolling();
  calls.length = 0;
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(calls, ['/api/system/update-job']);
  store.stopJobPolling();
  calls.length = 0;
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, []);
  store.stop();
  t.mock.timers.tick(120_000);
  assert.deepEqual(calls, []);
});

test('RUNTIME-legacy-plugins', async () => {
  const { normalizeNavItem, pluginCategoryOf, sortNavItems } = await loadMigrationModule(
    'src/stores/plugins.js', 'src/stores/plugins.ts',
  );
  const system = {
    id: 'code',
    system: true,
    nav: { path: '/code', label: 'Код' }
  };
  const custom = {
    id: 'custom',
    system: false,
    nav: { path: '/custom', label: 'Свой' }
  };

  assert.equal(normalizeNavItem(system).group, 'dock');
  assert.equal(normalizeNavItem(system).order, 10);
  assert.equal(pluginCategoryOf(system), 'dev');
  assert.equal(normalizeNavItem(custom).group, 'rail');
  assert.deepEqual(sortNavItems([
    normalizeNavItem(custom), normalizeNavItem(system),
  ]).map((item: { id: string }) => item.id), ['code', 'custom']);
});

test('RUNTIME-router', async () => {
  const stubs: Record<string, string> = {
    'vue-router': `
      export const createWebHashHistory = () => ({ kind: 'hash' });
      export const createRouter = (options) => options;
    `,
    './views/settings/settingsRouteStub.ts': 'export default {name: "settings-stub"};',
  };

  for (const route of baseline.routes) {
    if (route.component?.endsWith('.vue')) {
      stubs[route.component] = `export default {name: ${JSON.stringify(route.component)}};`;
    }
  }

  const { router } = await loadMigrationModule('src/router.js', 'src/router.ts', stubs);
  const routes = [];

  for (const route of router.routes) {
    const { component, ...rest } = route;
    let componentName = component?.name;

    if (typeof component === 'function') {
      componentName = (await component()).default.name;
    } else if (component && typeof component.render === 'function') {
      assert.equal(component.render(), null, route.path);
      componentName = 'inline-empty';
    }

    routes.push({
      ...rest,
      ...(component ? { component: componentName } : {}),
    });
  }

  assert.deepEqual(router.history, { kind: 'hash' });
  assert.deepEqual(routes, baseline.routes);
});
