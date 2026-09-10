import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const CHAT_STORE = webFile('src/stores/chat.js');

async function chatStore(t, api) {
  await installUiBrowser(t, 'http://cockpit.test/#/chats');
  globalThis.__dbApprovalApi = api;
  const module = await compileModule(CHAT_STORE, {
    stubs: {
      '../shared/apiClient.ts': 'export const api = globalThis.__dbApprovalApi;',
      '../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
      '../router.js': 'export const router = { currentRoute: { value: {} }, push() {} };',
      './ui-context.js': 'export const useUiContextStore = () => ({ current: null });',
      './providers.js': 'export const useProvidersStore = () => ({ providers: [] });',
      '../shared/notify.ts': 'export const notify = () => {};',
    },
  });
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  setActivePinia(createPinia());
  const store = module.useChatStore();
  t.after(() => {
    store.$dispose();
    delete globalThis.__dbApprovalApi;
  });
  return store;
}

function dbPending(pid = 'db-pid-1') {
  return {
    pid,
    origin: 'db',
    kind: 'perm',
    chatKey: 'chat-a',
    tool: 'supervised_db',
    profile: { label: 'Прод-заказы', role: 'read' },
    engine: { id: 'mysql', label: 'MySQL' },
    prod: true,
    query: 'SELECT id FROM orders',
    queryClass: 'read',
    tables: ['orders'],
  };
}

test('ответ на DB-карточку идёт только в origin-aware DB endpoint', async (t) => {
  const calls = [];
  const store = await chatStore(t, {
    async post(path, body) {
      calls.push({ path, body });
      return { ok: true };
    },
    async get() {
      return { waiting: [] };
    },
  });
  store.pending['db-pid-1'] = dbPending();
  await store.answerPerm('db-pid-1', true, true, '', 'legacy-choice');

  assert.deepEqual(calls, [{
    path: '/api/db/approvals/db-pid-1',
    body: { allow: true },
  }]);
});

test('после F5 DB-подтверждение восстанавливается вместе с SSH', async (t) => {
  const gets = [];
  const restored = dbPending('db-restored');
  const store = await chatStore(t, {
    async get(path) {
      gets.push(path);
      if (path === '/api/chat/store') {
        return { sessions: [], archived: [], activeId: null };
      }
      if (path === '/api/chat/pending') {
        return { pending: [] };
      }
      if (path === '/api/chat/waiting?include=ssh,db') {
        return { waiting: [restored] };
      }
      if (path === '/api/chat/active') {
        return { active: [] };
      }
      throw new Error(`неожиданный GET ${path}`);
    },
  });
  await store._load();

  assert.deepEqual({
    waitingRequests: gets.filter((path) => path.includes('/api/chat/waiting')),
    pending: store.pending['db-restored'],
  }, {
    waitingRequests: ['/api/chat/waiting?include=ssh,db'],
    pending: restored,
  });
});
