// Состояние триажа и его операции разведены: стор держит снимок, операции ходят в сеть.
// Тест проверяет обе стороны границы — и поведение, и то, что стор её не переступает.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const ACTIONS_PATH = webFile('src/actions/analysis/index.ts');
const STORE_PATH = webFile('src/stores/analysis.ts');

async function analysisFixture(t, api, { pluginEnabled = false } = {}) {
  globalThis.__analysisStoreHarness = {
    api,
    plugins: {
      enabled: (id) => id !== 'analysis',
      byId: (id) => (id === 'analysis' ? { id, enabled: pluginEnabled } : null),
    },
    shelf: { async autoAdd() {} },
  };
  const module = await compileModule(ACTIONS_PATH, {
    stubs: {
      './api-client.js': 'export const api = globalThis.__analysisStoreHarness.api;',
      './plugins.js': (
        'export const usePluginsStore = () => globalThis.__analysisStoreHarness.plugins;'
      ),
      '../../stores/plugins.js': (
        'export const usePluginsStore = () => globalThis.__analysisStoreHarness.plugins;'
      ),
      '../../stores/taskShelf.ts': (
        'export const useTaskShelfStore = () => globalThis.__analysisStoreHarness.shelf;'
      ),
    },
  });
  setActivePinia(createPinia());
  const store = module.useAnalysisStore();
  t.after(() => {
    module.stopAnalysisPolling();
    delete globalThis.__analysisStoreHarness;
  });

  return { module, store };
}

test('plugin_disabled сохраняет снимок и не становится красной ошибкой или новым polling', async (t) => {
  const error = new Error('plugin_disabled');
  error.code = 'plugin_disabled';
  error.data = { error: 'plugin_disabled' };
  const { module, store } = await analysisFixture(t, {
    async get() {
      throw error;
    },
  });
  store.byTask = {
    42: { task: 42, analysis: { complexity: 3 }, status: null },
  };
  store.loadedAt = 123;

  await module.loadAnalysis();

  assert.deepEqual({
    snapshot: store.byTask,
    loadedAt: store.loadedAt,
    error: store.error,
    polling: module.analysisPolling(),
  }, {
    snapshot: {
      42: { task: 42, analysis: { complexity: 3 }, status: null },
    },
    loadedAt: 123,
    error: null,
    polling: false,
  });
});

test('действия выключенного триажа завершаются штатно без сетевого запроса', async (t) => {
  let posts = 0;
  const { module, store } = await analysisFixture(t, {
    async get() { return []; },
    async post() {
      posts += 1;
      return { outcome: 'queued', position: 1 };
    },
  });
  const result = await module.analyzeTask(42);

  assert.deepEqual({ result, posts, error: store.error }, {
    result: { outcome: 'plugin_disabled', position: null },
    posts: 0,
    error: null,
  });
});

test('живой триаж читает сводку контрактом и продолжает опрос', async (t) => {
  const rows = [{
    task: 42,
    analysis: null,
    status: { task: 42, state: 'running', startedAt: 1 },
  }];
  const { module, store } = await analysisFixture(t, {
    async get() { return rows; },
  }, { pluginEnabled: true });

  await module.loadAnalysis();

  assert.deepEqual({
    task: store.byTask['42']?.task,
    state: store.byTask['42']?.status?.state,
    // Незаявленные поля статуса контракт подставляет пустыми, а не роняет ответ.
    queuedAt: store.byTask['42']?.status?.queuedAt,
    active: store.active,
    polling: module.analysisPolling(),
  }, {
    task: 42,
    state: 'running',
    queuedAt: null,
    active: true,
    polling: true,
  });
});

test('повреждённая сводка не стирает прошлый снимок и остаётся ошибкой на экране', async (t) => {
  const { module, store } = await analysisFixture(t, {
    async get() { return [{ task: 42, status: { task: 42, state: 'сломано' } }]; },
  }, { pluginEnabled: true });
  store.byTask = { 7: { task: 7, analysis: null, status: null } };

  await module.loadAnalysis();

  assert.deepEqual(Object.keys(store.byTask), ['7'], 'прошлый снимок остаётся на экране');
  assert.match(store.error, /Некорректный ответ триажа/u);
});

test('стор триажа не знает ни путей API, ни транспорта', async () => {
  const source = await readFile(STORE_PATH, 'utf8');
  const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map(([, from]) => from);

  assert.deepEqual(imports.sort(), [
    '../../../shared/analysisContracts.ts',
    './plugins.js',
    'pinia',
  ]);
  assert.equal(/\/api\//u.test(source), false, 'адреса API живут в слое операций');
});
