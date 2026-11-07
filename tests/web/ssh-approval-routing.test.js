import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const CHAT_STORE = webFile('src/stores/chat.ts');
let nonce = 0;

async function chatStore(t, api) {
  await installUiBrowser(t, 'http://grigdesk.test/#/chats');
  globalThis.__sshApprovalApi = api;
  const module = await compileModule(CHAT_STORE, {
    stubs: {
      '../shared/apiClient.ts': 'export const api = globalThis.__sshApprovalApi;',
      '../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
      '../router.ts': 'export const router = { currentRoute: { value: {} }, push() {} };',
      './uiContext.ts': 'export const useUiContextStore = () => ({ current: null });',
      './providers.ts': 'export const useProvidersStore = () => ({ providers: [] });',
      '../shared/alerts.ts': 'export const alertUser = () => true; export const dismissAlert = () => {};'
        + ' export const dismissAlertScope = () => {};',
    },
  });
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  setActivePinia(createPinia());
  const store = module.useChatStore();
  store.$id += `-${nonce += 1}`;
  t.after(() => { delete globalThis.__sshApprovalApi; });
  return store;
}

function sshPending(pid = 'ssh-pid-1') {
  return {
    pid,
    origin: 'ssh',
    kind: 'perm',
    chatKey: 'chat-a',
    tool: 'supervised_ssh',
    server: { label: 'Боевой код', host: 'server.internal', port: 22 },
    user: 'deploy',
    command: 'sudo systemctl restart app',
  };
}

test('ответ на SSH-карточку идёт только в origin-aware SSH endpoint', async (t) => {
  const calls = [];
  const store = await chatStore(t, {
    async post(path, body) {
      calls.push({ path, body });
      return { ok: true };
    },
    async get() { return { waiting: [] }; },
  });
  store.pending['ssh-pid-1'] = sshPending();
  await store.answerPerm('ssh-pid-1', false, true, 'сейчас идёт выкладка', 'legacy-choice');

  assert.deepEqual(calls, [{
    path: '/api/ssh/approvals/ssh-pid-1',
    body: { allow: false, comment: 'сейчас идёт выкладка' },
  }]);
});

test('неоднозначный SSH POST и недоступная пересверка сохраняют карточку', async (t) => {
  const store = await chatStore(t, {
    async post() { throw new TypeError('network changed'); },
    async get() { throw new TypeError('network changed'); },
  });
  store.pending['ssh-pid-1'] = sshPending();
  await store.answerPerm('ssh-pid-1', true);

  assert.equal(store.pending['ssh-pid-1']?.pid, 'ssh-pid-1');
});

test('потерянный ответ POST снимается только авторитетным waiting snapshot', async (t) => {
  const getPaths = [];
  const store = await chatStore(t, {
    async post() { throw new TypeError('lost response'); },
    async get(path) {
      getPaths.push(path);
      return { waiting: [] };
    },
  });
  store.pending['ssh-pid-1'] = sshPending();
  await store.answerPerm('ssh-pid-1', true);

  assert.deepEqual({ pending: store.pending['ssh-pid-1'], getPaths }, {
    pending: undefined,
    getPaths: ['/api/chat/waiting?include=ssh,db'],
  });
});

test('после F5 SSH-подтверждение восстанавливается в общий chat.pending', async (t) => {
  const gets = [];
  const restored = sshPending('ssh-restored');
  const store = await chatStore(t, {
    async post(path) {
      assert.equal(path, '/api/chat/store/reconcile');

      return {
        pending: [],
        heads: [],
        gone: [],
        deliveries: [],
      };
    },
    /**
     * После F5 список и waiting проходят через прежний сценарий восстановления.
     * Полная история не нужна для показа карточки разрешения.
     */
    async get(path) {
      gets.push(path);

      if (path === '/api/chat/store/list') {
        return {
          listProtocol: 1,
          sessions: [],
          archived: [],
          activeId: null,
        };
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
    pending: store.pending['ssh-restored'],
  }, {
    waitingRequests: ['/api/chat/waiting?include=ssh,db'],
    pending: restored,
  });
});

test('обычное разрешение сохраняет прежний generic endpoint', async (t) => {
  const calls = [];
  const store = await chatStore(t, {
    async post(path, body) {
      calls.push({ path, body });
      return { ok: true };
    },
  });
  store.pending['chat-pid-1'] = {
    pid: 'chat-pid-1', kind: 'perm', chatKey: 'chat-a', tool: 'Bash', input: { command: 'npm test' },
  };
  await store.answerPerm('chat-pid-1', true, true);

  assert.deepEqual(calls, [{
    path: '/api/chat/permission/chat-pid-1',
    body: { allow: true, remember: true },
  }]);
});
