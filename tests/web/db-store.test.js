import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

function session(overrides = {}) {
  return {
    id: 'session-a',
    profileId: 'fixture',
    projectId: 'cockpit',
    label: 'Боевая',
    role: 'read',
    engine: 'mysql',
    prod: true,
    via: 'ssh',
    agentAllowed: false,
    generation: 1,
    readOnlyActive: true,
    openedAt: '2026-09-08T08:00:00.000Z',
    ...overrides,
  };
}

const ACTIONS_PATH = webFile('src/actions/db/index.ts');
const STORE_PATH = webFile('src/stores/db.ts');

async function dbSection(t, api) {
  await installUiBrowser(t, 'https://cockpit.test/#/db');
  globalThis.__dbStoreApi = api;
  const module = await compileModule(ACTIONS_PATH, {
    stubs: {
      './apiClient.ts': 'export const api = globalThis.__dbStoreApi;',
      '../../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
    },
  });
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );

  setActivePinia(createPinia());
  const store = module.useDbStore();

  t.after(() => {
    store.$dispose();
    delete globalThis.__dbStoreApi;
  });

  return { module, store };
}

test('пароль DB-сессии отправляется raw bytes и не попадает в JSON', async (t) => {
  const calls = [];
  const { module } = await dbSection(t, {
    async postBytes(path, body, options) {
      calls.push({ path, body: new TextDecoder().decode(body), options });

      return { session: session() };
    },
  });

  await module.openDbSession('fixture', 'DB_PASSWORD_SENTINEL_91012', 'ssh-session-a');

  assert.deepEqual(calls, [{
    path: '/api/db/profiles/fixture/sessions',
    body: 'DB_PASSWORD_SENTINEL_91012',
    options: { headers: { 'x-cockpit-ssh-session-id': 'ssh-session-a' } },
  }]);
});

test('DB store получает движки профили сессии запросы и журнал общим API', async (t) => {
  const paths = [];
  const { module } = await dbSection(t, {
    async get(path) {
      paths.push(path);
      if (path.endsWith('/engines')) return { engines: [] };
      if (path.endsWith('/profiles')) return { profiles: [] };
      if (path.endsWith('/sessions')) return { sessions: [] };
      if (path.endsWith('/queries')) return { queries: [] };

      return { items: [] };
    },
  });

  await module.loadDb();

  assert.deepEqual(paths, [
    '/api/db/engines',
    '/api/db/profiles',
    '/api/db/sessions',
    '/api/db/queries',
    '/api/db/audit',
  ]);
});

test('DB store получает проекты отдельно от общего обновления панели', async (t) => {
  const { module, store } = await dbSection(t, {
    async get(path) {
      assert.equal(path, '/api/projects');

      return { projects: [{ id: 'cockpit' }, { id: 'shop' }] };
    },
  });

  await module.loadDbProjects();

  // Признак архива входит в контракт списка: по нему форма решает, кому можно
  // заводить новый профиль базы.
  assert.deepEqual(store.projects, [
    { id: 'cockpit', archivedAt: null },
    { id: 'shop', archivedAt: null },
  ]);
  assert.equal(store.projectsLoading, false);
  assert.equal(store.projectsError, '');
});

test('консоль человека отправляет серверный контракт text и params', async (t) => {
  const calls = [];
  const { module } = await dbSection(t, {
    async post(path, body) {
      calls.push({ path, body });

      return { queryId: 'query-a' };
    },
    async get(path) {
      assert.equal(path, '/api/db/queries');

      return { queries: [] };
    },
  });

  await module.runDbQuery('session-a', 'SELECT id FROM orders WHERE id = ?', [42]);

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
  const { api } = await import(`../../web/src/shared/apiClient.ts?db-raw=${Date.now()}`);
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
  const { module, store } = await dbSection(t, {
    async post() {
      return outcomes.shift();
    },
    async get() {
      return { queries: [] };
    },
  });
  const notices = [];

  await module.cancelDbQuery('query-a');
  notices.push(store.cancelNotice);
  await module.cancelDbQuery('query-b');
  notices.push(store.cancelNotice);
  await module.cancelDbQuery('query-c');
  notices.push(store.cancelNotice);

  assert.deepEqual(notices, [
    'Команда уже выполняется на сервере и прервать её нечем — дождитесь ответа.',
    'Запрос снят вместе с соединением — сессия закрыта, откройте её заново.',
    '',
  ]);
});

test('стор баз не знает ни путей API, ни транспорта', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(STORE_PATH, 'utf8');
  const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map(([, from]) => from);

  assert.deepEqual(imports.sort(), [
    '../../../shared/dbContracts.ts',
    '../../../shared/sshContracts.ts',
    'pinia',
  ]);
  assert.equal(/\/api\//u.test(source), false, 'адреса API живут в слое операций');
});

test('повреждённая сводка не становится списком профилей на экране', async (t) => {
  const { module, store } = await dbSection(t, {
    async get(path) {
      if (path.endsWith('/profiles')) {
        return { profiles: [{ id: 'p1', role: 'админ' }] };
      }
      if (path.endsWith('/engines')) return { engines: [] };
      if (path.endsWith('/sessions')) return { sessions: [] };
      if (path.endsWith('/queries')) return { queries: [] };

      return { items: [] };
    },
  });

  await module.loadDb();

  assert.deepEqual(store.profiles, []);
  assert.match(store.error, /Некорректный ответ баз данных/u);
});

test('потерянная сессия не подменяет собой строку списка при смене доступа', async (t) => {
  const { module, store } = await dbSection(t, {
    async put() {
      return { ok: false, error: 'session_lost' };
    },
  });

  store.sessions = [session({ agentAllowed: true })];
  await module.setDbAgentAccess('session-a', false);

  assert.deepEqual(store.sessions, [session({ agentAllowed: true })]);
});
