import assert from 'node:assert/strict';
import test from 'node:test';

import { pluginCard } from './helpers/pluginModuleContract.js';
import { serviceFixture } from './helpers/pluginModuleServices.js';

test('PM-ROUTE-INTENTS: непринятый query ждёт доступного каталога и попадает в dock один раз', async (t) => {
  const f = await serviceFixture(t, 'shared/alertDeepLinks.ts', {
    view: 'views/PluginView.vue',
    docks: 'stores/dock.ts',
    plugins: 'stores/plugins.ts',
  }, {
    '../pluginRuntime/bootstrap.ts': `
      export const pluginRuntimeAccessFor = () => ({ value: { status: 'ready' } });
    `,
  });
  const previousHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');

  Object.defineProperty(globalThis, 'history', { value: f.browser.history, configurable: true });
  t.after(() => {
    if (previousHistory) {
      Object.defineProperty(globalThis, 'history', previousHistory);
    } else {
      delete globalThis.history;
    }
  });

  const { createRouter, createMemoryHistory } =
    await import('../../web/node_modules/vue-router/dist/vue-router.mjs');
  const pinia = f.pinia.createPinia();
  const plugins = f.plugins.usePluginsStore(pinia);
  const dock = f.docks.useDockStore(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/ext/:id', component: { render: () => null } }],
  });

  await router.push({ path: '/ext/ui-module', query: { model: 'модель 1', version: 'β' } });
  await router.isReady();

  const host = document.createElement('div');
  const app = f.vue.createApp(f.view.default);

  document.body.append(host);
  app.use(pinia).use(router).mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
  });
  assert.equal(router.currentRoute.value.query.model, 'модель 1');
  assert.equal(dock.intents['ui-module'], undefined);
  plugins.list = [pluginCard({ enabled: false })];
  plugins.loaded = true;
  await f.vue.nextTick();
  assert.equal(router.currentRoute.value.query.model, 'модель 1');
  plugins.list[0].enabled = true;
  await f.vue.nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(dock.intents['ui-module'], [{
    id: 1,
    type: 'open',
    params: { model: 'модель 1', version: 'β' },
  }]);
  assert.deepEqual(router.currentRoute.value.query, {});
  dock.consume('ui-module', 1);
  plugins.list = [pluginCard()];
  await f.vue.nextTick();
  assert.equal(dock.intents['ui-module'], undefined);
  await router.push('/ext/ui-module?model=first&model=second');
  await f.vue.nextTick();
  assert.deepEqual(router.currentRoute.value.query.model, ['first', 'second']);
  assert.equal(dock.intents['ui-module'], undefined);
});
