// Состояние триажа и его операции разведены: стор держит снимок, операции ходят в сеть.
// Тест проверяет обе стороны границы — и поведение, и то, что стор её не переступает.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { compileModule, renamedSpecifier, webFile } from './helpers/compile-vue.js';

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
      './apiClient.ts': 'export const api = globalThis.__analysisStoreHarness.api;',
      './plugins.ts': (
        'export const usePluginsStore = () => globalThis.__analysisStoreHarness.plugins;'
      ),
      '../../stores/plugins.ts': (
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

  assert.deepEqual(imports.map(renamedSpecifier)
    .filter((from) => from !== '../../../shared/tasks/taskReference.ts').sort(), [
    '../../../shared/pipeline/analysisContracts.ts',
    './plugins.ts',
    'pinia',
  ]);
  assert.equal(/\/api\//u.test(source), false, 'адреса API живут в слое операций');
});

/**
 * Recorder отвечает валидными DTO существующих ручек и сохраняет параметры сети.
 * Контекст берётся из того же адресного endpoint, который читает resolveTrackerTarget.
 */
function sourceRecorder({ rejected = false, rows = [] } = {}) {
  const calls = [];
  const source = `fixture-a@${'a'.repeat(64)}`;
  const api = {
    /**
     * Возвращает DTO именно запрошенной ручки, включая адресный context.
     * Тест видит исходный URL до декодирования ответа общим API.
     */
    async get(url, options) {
      calls.push({
        method: 'GET',
        url,
        options,
      });

      const pathname = new URL(url, 'http://fixture.test').pathname;

      if (pathname === '/api/trackers') {
        return { enabledIds: ['fixture-a', 'fixture-b'] };
      }

      if (pathname.endsWith('/context')) {
        return { source, generation: 7 };
      }

      if (pathname === '/api/analysis') {
        return rows;
      }

      if (pathname.endsWith('/clarifications')) {
        return { text: '', entries: [] };
      }

      return {
        task: 42,
        analysis: null,
        status: null,
        note: null,
        stale: null,
      };
    },
    /**
     * Отказ моделирует ответ выбранной доски до optimistic обновления.
     * Успешные ручки возвращают свои штатные конверты.
     */
    async post(url, body, options) {
      calls.push({
        method: 'POST',
        url,
        body,
        options,
      });

      if (rejected) {
        throw Object.assign(new Error('Цель отклонена'), { status: 409 });
      }

      if (url.includes('/clarifications')) {
        return { text: '', entries: [] };
      }

      if (url.includes('/arbitrate')) {
        return {
          ok: true,
          outcome: 'nothing_to_do',
          answered: 0,
        };
      }

      return { outcome: 'queued', position: 1 };
    },
    async del(url) {
      calls.push({ method: 'DELETE', url });

      return { outcome: 'dismissed' };
    },
  };

  return {
    api,
    calls,
    source,
  };
}

test('SOURCE-ACTIONS-01: sourced строки и optimistic queued разделены по паре', async (t) => {
  const { taskReferenceKey } = await import('../../shared/tasks/taskReference.ts');
  const a = `fixture-a@${'a'.repeat(64)}`;
  const b = `fixture-b@${'b'.repeat(64)}`;
  const recorder = sourceRecorder({ rows: [
    {
      task: 42,
      source: a,
      analysis: { risk: 1 },
      status: { task: 42, state: 'failed' },
    },
    {
      task: 42,
      source: b,
      analysis: { risk: 5 },
      status: { task: 42, state: 'interrupted' },
    },
    {
      task: 7,
      analysis: { risk: 2 },
      status: null,
    },
  ] });
  const { module, store } = await analysisFixture(t, recorder.api, { pluginEnabled: true });

  await module.loadAnalysis();

  const keyA = taskReferenceKey({ source: a, id: '42' });
  const keyB = taskReferenceKey({ source: b, id: '42' });

  assert.equal(store.byReference?.[keyA]?.analysis.risk, 1, 'Decoder/store сохраняет source A');
  assert.equal(store.byReference?.[keyB]?.analysis.risk, 5);
  assert.equal(store.byTask['7'].analysis.risk, 2);
  assert.equal(store.issues.length, 2);
  assert.equal(new URL(recorder.calls[0].url, 'http://fixture.test').searchParams.get('sources'), '1');

  await module.analyzeTask('42', { source: a });

  assert.equal(store.byReference[keyA].status.state, 'queued');
  assert.equal(store.byReference[keyB].status.state, 'interrupted');
  assert.equal(store.active, true);

  const post = recorder.calls.find((call) => call.url.endsWith('/analyze'));

  assert.equal(post.body.source, a);
  assert.equal(post.options.headers['x-grigdesk-tracker-generation'], '7');

  await module.dismissAnalysis('42', a);

  assert.equal(store.byReference[keyA].status, null);
  assert.equal(store.byReference[keyB].status.state, 'interrupted');
});

test('SOURCE-ACTIONS-01: detail, clarify, answer, arbitrate и dismiss передают source', async (t) => {
  const recorder = sourceRecorder();
  const { module } = await analysisFixture(t, recorder.api, { pluginEnabled: true });
  const { analysisApi } = await compileModule(webFile('src/shared/analysisApi.ts'), {
    stubs: { './apiClient.ts': 'export const api = globalThis.__analysisStoreHarness.api;' },
  });

  await module.readAnalysisDetail('42', recorder.source);
  await analysisApi.clarifications('42', recorder.source);
  await analysisApi.answer('42', [], 'Ответ', recorder.source);
  await analysisApi.arbitrate('42', recorder.source);
  await module.dismissAnalysis('42', recorder.source);

  assert.equal(recorder.calls.length, 5);

  for (const call of recorder.calls) {
    const url = new URL(call.url, 'http://fixture.test');

    assert.equal(url.searchParams.get('source'), recorder.source, `${call.method} ${url.pathname}`);
  }
});

test('SOURCE-ALIAS-01: POST дублирует taskSource, отказ не создаёт optimistic очередь', async (t) => {
  for (const rejected of [false, true]) {
    await t.test(rejected ? 'HTTP 409' : 'успешная очередь', async (st) => {
      const recorder = sourceRecorder({ rejected });
      const { module, store } = await analysisFixture(st, recorder.api, { pluginEnabled: true });
      let queued = 0;
      let shelved = 0;
      const unsubscribe = store.$onAction(({ name }) => {
        if (name === 'markQueued') {
          queued += 1;
        }
      });

      st.after(unsubscribe);
      globalThis.__analysisStoreHarness.shelf = {
        forSource() {
          return this;
        },
        async autoAdd() {
          shelved += 1;
        },
      };

      const action = module.analyzeTask('42', { source: recorder.source });

      if (rejected) {
        await assert.rejects(action, /Цель отклонена/);
        assert.equal(queued, 0);
        assert.equal(shelved, 0);
      } else {
        await action;
        assert.equal(queued, 1);
      }

      const post = recorder.calls.find((call) => call.url.endsWith('/analyze'));

      assert.equal(post.body.source, recorder.source);
      assert.equal(post.body.taskSource, recorder.source, 'Старый сервер должен отвергнуть чужую цель');
    });
  }
});
