import assert from 'node:assert/strict';
import test from 'node:test';

import { loadProductModule } from './helpers/compile-vue.js';
import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';

const ownId = '100000000000';
const ownTask = {
  id: ownId,
  source: 'grigdesk',
  title: 'Своя',
  description: '',
  projectId: 'demo',
  projectTitle: 'Демо',
  sourceUrl: `http://example.test/#/board?openTask=${ownId}`,
  createdAt: '2026-11-02T00:00:00.000Z',
};

/**
 * Настоящие stores работают с раздельными серверными снимками и обычным транспортом.
 * Фикстура фиксирует только HTTP-намерения, не повторяя логику базовой линии клиента.
 */
async function fixture(t) {
  const calls = [];
  const api = {
    /**
     * Снимок собственных задач подтверждает поддержку личного пространства.
     * Внешние ответы имеют отдельный scope и не смешиваются с own baseline.
     */
    async get(url) {
      calls.push(['get', url]);

      if (url === '/api/grigdesk-tasks') {
        return {
          tasks: [ownTask],
          revision: 1,
          trackerConfigured: false,
          personalStateVersion: 1
        };
      }

      return {
        scope: url.includes('grigdesk-tasks') ? 'grigdesk' : 'external',
        revision: 0,
        taskIds: [],
        initialized: false
      };
    },
    async post(url, body) {
      calls.push(['post', url, structuredClone(body)]);

      if (url === '/api/grigdesk-tasks?sources=1') {
        return { task: { ...ownTask, id: '100000000001' }, revision: 2 };
      }

      return {
        scope: 'grigdesk',
        revision: 1,
        taskIds: body.taskIds,
        initialized: body.baseline
      };
    },
  };

  globalThis.__ownStoresApi = api;
  t.after(() => delete globalThis.__ownStoresApi);
  setActivePinia(createPinia());

  const module = await loadProductModule('src/stores/grigdeskTasks.ts', {
    '../shared/apiClient.ts': `
      export const api = globalThis.__ownStoresApi;
      export const failureText = (error) => error.message;
    `,
  });

  return {
    store: module.useGrigdeskTasksStore(),
    api,
    calls
  };
}

test('baseline первого снимка не поглощает созданную позже задачу', async (t) => {
  const { store, calls } = await fixture(t);

  await store.create({
    title: 'Своя',
    description: '',
    projectId: 'demo',
    clientOrigin: 'http://example.test'
  });
  await store.markBaselineSeen();

  const baseline = calls.filter(([method, url]) => method === 'post' && url.endsWith('/task-seen'));

  assert.equal(baseline.length > 0, true);
  assert.equal(baseline.every(([, , body]) => body.taskIds.every((id) => id === ownId)), true);
  assert.deepEqual(store.baselineIds, [ownId]);
  assert.equal(store.tasks.length, 2);
});

test('поздний снимок другой установки не восстанавливает own список', async (t) => {
  const { store, api } = await fixture(t);
  const pending = Promise.withResolvers();

  api.get = () => pending.promise;

  const loading = store.load();

  store.clear();
  pending.resolve({
    tasks: [ownTask],
    revision: 1,
    trackerConfigured: false,
    personalStateVersion: 1
  });
  await loading;
  assert.equal(store.loaded, false);
  assert.deepEqual(store.tasks, []);
});

test('большая baseline отправляется последовательными порциями, initialized только в конце', async (t) => {
  const { store, api, calls } = await fixture(t);
  const initialGet = api.get;

  api.get = async (url) => url === '/api/grigdesk-tasks'
    ? {
      tasks: Array.from({ length: 1001 }, (_, index) => ({
        ...ownTask, id: String(BigInt(ownId) + BigInt(index)),
      })),
      revision: 1,
      trackerConfigured: false,
      personalStateVersion: 1,
    }
    : initialGet(url);

  await store.load();
  await store.markBaselineSeen();

  const parts = calls.filter(([method, url]) => method === 'post' && url.endsWith('/task-seen'));

  assert.equal(parts.length >= 2, true);
  assert.equal(parts.every(([, , body]) => body.taskIds.length <= 1000), true);
  assert.equal(parts.some(([, , body]) => body.baseline === false && body.taskIds.length === 1000), true);
  assert.equal(parts.some(([, , body]) => body.baseline === true && body.taskIds.length === 1), true);
});
