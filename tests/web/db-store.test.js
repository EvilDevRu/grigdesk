import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const STORE_PATH = webFile('src/stores/db.js');

async function dbStore(t, api) {
  await installUiBrowser(t, 'https://cockpit.test/#/db');
  globalThis.__dbStoreApi = api;
  let module;
  try {
    module = await compileModule(STORE_PATH, {
      stubs: {
        '../shared/api-client.js': 'export const api = globalThis.__dbStoreApi;',
        '../composables/useSse.js': 'export const sseSubscribe = () => () => {};',
      },
    });
  } catch (error) {
    assert.fail(`клиентский DB store ещё не реализован: ${error.message}`);
  }
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  setActivePinia(createPinia());
  const store = module.useDbStore();
  t.after(() => {
    store.$dispose();
    delete globalThis.__dbStoreApi;
  });
  return store;
}

test('пароль DB-сессии отправляется raw bytes и не попадает в JSON', async (t) => {
  const calls = [];
  const store = await dbStore(t, {
    async postBytes(path, body, options) {
      calls.push({ path, body: new TextDecoder().decode(body), options });
      return { session: { id: 'session-a' } };
    },
  });
  await store.openSession('fixture', 'DB_PASSWORD_SENTINEL_91012', {
    sshSessionId: 'ssh-session-a',
  });

  assert.deepEqual(calls, [{
    path: '/api/db/profiles/fixture/sessions',
    body: 'DB_PASSWORD_SENTINEL_91012',
    options: { headers: { 'x-cockpit-ssh-session-id': 'ssh-session-a' } },
  }]);
});

test('DB store получает движки профили сессии запросы и журнал общим API', async (t) => {
  const paths = [];
  const store = await dbStore(t, {
    async get(path) {
      paths.push(path);
      if (path.endsWith('/engines')) return { engines: [] };
      if (path.endsWith('/profiles')) return { profiles: [] };
      if (path.endsWith('/sessions')) return { sessions: [] };
      if (path.endsWith('/queries')) return { queries: [] };
      return { items: [] };
    },
  });
  await store.load();

  assert.deepEqual(paths, [
    '/api/db/engines',
    '/api/db/profiles',
    '/api/db/sessions',
    '/api/db/queries',
    '/api/db/audit',
  ]);
});

test('DB store получает проекты отдельно от общего обновления панели', async (t) => {
  const store = await dbStore(t, {
    async get(path) {
      assert.equal(path, '/api/projects');
      return { projects: [{ id: 'cockpit' }, { id: 'shop' }] };
    },
  });

  await store.loadProjects();

  assert.deepEqual(store.projects, [{ id: 'cockpit' }, { id: 'shop' }]);
  assert.equal(store.projectsLoading, false);
  assert.equal(store.projectsError, '');
});

test('консоль человека отправляет серверный контракт text и params', async (t) => {
  const calls = [];
  const store = await dbStore(t, {
    async post(path, body) {
      calls.push({ path, body });
      return { queryId: 'query-a' };
    },
    async get(path) {
      assert.equal(path, '/api/db/queries');
      return { queries: [] };
    },
  });
  await store.runQuery('session-a', 'SELECT id FROM orders WHERE id = ?', [42]);

  assert.deepEqual(calls, [{
    path: '/api/db/sessions/session-a/query',
    body: { text: 'SELECT id FROM orders WHERE id = ?', params: [42] },
  }]);
});

test('raw API сохраняет заголовок выбранной SSH-сессии', async (t) => {
  await installUiBrowser(t, 'https://cockpit.test/#/db');
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ session: { id: 'db-session-a' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const { api } = await import(`../../web/src/shared/api-client.js?db-raw=${Date.now()}`);
  await api.postBytes(
    '/api/db/profiles/fixture/sessions',
    new TextEncoder().encode('secret'),
    { headers: { 'x-cockpit-ssh-session-id': 'ssh-session-a' } },
  );

  assert.deepEqual(requests[0].options.headers, {
    'x-cockpit-ssh-session-id': 'ssh-session-a',
    'Content-Type': 'application/octet-stream',
  });
});

test('панель объясняет исход прерывания вместо молчания', async (t) => {
  const outcomes = [
    { ok: false, error: 'cancel_not_supported' },
    { ok: true, method: 'connection' },
    { ok: true, method: 'query' },
  ];
  const store = await dbStore(t, {
    async post() {
      return outcomes.shift();
    },
    async get() {
      return { queries: [] };
    },
  });
  const notices = [];
  await store.cancelQuery('query-a');
  notices.push(store.cancelNotice);
  await store.cancelQuery('query-b');
  notices.push(store.cancelNotice);
  await store.cancelQuery('query-c');
  notices.push(store.cancelNotice);

  assert.deepEqual(notices, [
    'Команда уже выполняется на сервере и прервать её нечем — дождитесь ответа.',
    'Запрос снят вместе с соединением — сессия закрыта, откройте её заново.',
    '',
  ]);
});
