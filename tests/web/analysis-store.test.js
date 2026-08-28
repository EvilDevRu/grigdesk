import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const STORE_PATH = webFile('src/stores/analysis.js');

async function storeFixture(t, api) {
  globalThis.__analysisStoreHarness = {
    api,
    plugins: {
      enabled: (id) => id !== 'analysis',
      byId: (id) => (id === 'analysis' ? { id, enabled: false } : null),
    },
  };
  const module = await compileModule(STORE_PATH, {
    stubs: {
      '../shared/api-client.js': 'export const api = globalThis.__analysisStoreHarness.api;',
      './task-shelf.js': 'export const useTaskShelfStore = () => ({ async autoAdd() {} });',
      './plugins.js': (
        'export const usePluginsStore = () => globalThis.__analysisStoreHarness.plugins;'
      ),
    },
  });
  setActivePinia(createPinia());
  const store = module.useAnalysisStore();
  t.after(() => {
    clearTimeout(store._timer);
    delete globalThis.__analysisStoreHarness;
  });

  return store;
}

test('plugin_disabled сохраняет снимок и не становится красной ошибкой или новым polling', async (t) => {
  const error = new Error('plugin_disabled');
  error.code = 'plugin_disabled';
  error.data = { error: 'plugin_disabled' };
  const store = await storeFixture(t, {
    async get() {
      throw error;
    },
  });
  store.byTask = {
    42: { task: 42, analysis: { complexity: 3 } },
  };
  store.loadedAt = 123;

  await store.load();

  assert.deepEqual({
    snapshot: store.byTask,
    loadedAt: store.loadedAt,
    error: store.error,
    polling: Boolean(store._timer),
  }, {
    snapshot: {
      42: { task: 42, analysis: { complexity: 3 } },
    },
    loadedAt: 123,
    error: null,
    polling: false,
  });
});

test('действия выключенного триажа завершаются штатно без сетевого запроса', async (t) => {
  let posts = 0;
  const store = await storeFixture(t, {
    async get() { return []; },
    async post() {
      posts += 1;
      return { outcome: 'queued' };
    },
  });
  const result = await store.analyze(42);

  assert.deepEqual({ result, posts, error: store.error }, {
    result: { outcome: 'plugin_disabled' },
    posts: 0,
    error: null,
  });
});
