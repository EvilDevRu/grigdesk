import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const STORE_PATH = webFile('src/stores/ssh.js');

async function sshStore(t, api, sockets = []) {
  await installUiBrowser(t, 'http://cockpit.test/#/ssh');
  globalThis.__sshStoreApi = api;
  globalThis.__sshStoreSocket = class {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.sent = [];
      sockets.push(this);
    }

    close() { this.closed = true; }
    send(payload) { this.sent.push(payload); }
  };
  let module;
  try {
    module = await compileModule(STORE_PATH, {
      stubs: {
        '../shared/api-client.js': 'export const api = globalThis.__sshStoreApi;',
        '../composables/useSse.js': 'export const sseSubscribe = () => () => {};',
      },
    });
  } catch (error) {
    assert.fail(`клиентский SSH store ещё не реализован: ${error.message}`);
  }
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  setActivePinia(createPinia());
  const store = module.useSshStore({ WebSocket: globalThis.__sshStoreSocket });
  t.after(() => {
    store.$dispose();
    delete globalThis.__sshStoreApi;
    delete globalThis.__sshStoreSocket;
  });
  return store;
}

test('пароль отправляется байтами без JSON-сериализации', async (t) => {
  const calls = [];
  const store = await sshStore(t, {
    async postBytes(path, body) {
      calls.push({ path, body, type: body.constructor.name });
      return { session: { id: 'session-a', label: 'Боевой код', role: 'code' } };
    },
  });
  await store.connect('connection-a', 'SSH_PASSWORD_SENTINEL_91006');

  assert.deepEqual(calls, [{
    path: '/api/ssh/connections/connection-a/sessions',
    body: new TextEncoder().encode('SSH_PASSWORD_SENTINEL_91006'),
    type: 'Uint8Array',
  }]);
});

test('raw API не ставит JSON Content-Type на парольный connect', async (t) => {
  await installUiBrowser(t, 'https://cockpit.test/#/ssh');
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ session: { id: 'session-a' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const { api } = await import(`../../web/src/shared/api-client.js?ssh-raw=${Date.now()}`);
  const password = new TextEncoder().encode('SSH_PASSWORD_SENTINEL_91006');
  if (typeof api.postBytes !== 'function') {
    throw new Error('api-client ещё не предоставляет raw octet-stream transport для пароля');
  }
  await api.postBytes('/api/ssh/connections/connection-a/sessions', password);

  assert.deepEqual({
    contentType: requests[0].options.headers?.['Content-Type'],
    bodyIsBytes: requests[0].options.body instanceof Uint8Array,
    body: new TextDecoder().decode(requests[0].options.body),
  }, {
    contentType: 'application/octet-stream',
    bodyIsBytes: true,
    body: 'SSH_PASSWORD_SENTINEL_91006',
  });
});

test('ошибка каталога проектов не скрывает SSH-соединения и сессии', async (t) => {
  const store = await sshStore(t, {
    async get(path) {
      if (path === '/api/projects') {
        throw new Error('Профиль проекта повреждён');
      }
      if (path === '/api/ssh/connections') {
        return { connections: [{ id: 'connection-a', projectId: 'cockpit' }] };
      }
      if (path === '/api/ssh/sessions') {
        return { sessions: [{ id: 'session-a', label: 'Боевой код' }] };
      }

      return { items: [{ at: '2026-08-28T00:00:00.000Z', command: 'id' }] };
    },
  });

  await Promise.all([store.load(), store.loadProjects()]);

  assert.deepEqual({
    connections: store.connections.map((item) => item.id),
    sessions: store.sessions.map((item) => item.id),
    audit: store.audit.map((item) => item.command),
    error: store.error,
    projectsError: store.projectsError,
  }, {
    connections: ['connection-a'],
    sessions: ['session-a'],
    audit: ['id'],
    error: '',
    projectsError: 'Профиль проекта повреждён',
  });
});

test('переключение вкладки держит только один attach WebSocket', async (t) => {
  const sockets = [];
  const store = await sshStore(t, {
    wsUrl: (path) => `ws://cockpit.test${path}`,
  }, sockets);
  store.sessions = [
    { id: 'session-a', label: 'Код', role: 'code' },
    { id: 'session-b', label: 'База', role: 'db' },
  ];
  store.activate('session-a');
  store.activate('session-b');

  assert.deepEqual({
    created: sockets.map((socket) => socket.url),
    closed: sockets.map((socket) => socket.closed),
  }, {
    created: [
      'ws://cockpit.test/api/ssh/sessions/session-a/terminal',
      'ws://cockpit.test/api/ssh/sessions/session-b/terminal',
    ],
    closed: [true, false],
  });
});

test('последний размер PTY отправляется после открытия WebSocket', async (t) => {
  const sockets = [];
  const store = await sshStore(t, {
    wsUrl: (path) => `ws://cockpit.test${path}`,
  }, sockets);
  store.activate('session-a');
  sockets[0].readyState = 0;
  store.resize(132, 41);

  assert.deepEqual(sockets[0].sent, []);

  sockets[0].readyState = 1;
  sockets[0].onopen();

  assert.deepEqual(sockets[0].sent, [JSON.stringify({ t: 'resize', cols: 132, rows: 41 })]);
});

test('detach панели не удаляет server-owned сессию', async (t) => {
  const calls = [];
  const store = await sshStore(t, {
    wsUrl: (path) => `ws://cockpit.test${path}`,
    async del(path) { calls.push(path); },
  });
  store.sessions = [{ id: 'session-a', label: 'Код', role: 'code' }];
  store.activate('session-a');
  store.detach();

  assert.deepEqual(calls, []);
});

test('явное закрытие вкладки удаляет server-owned сессию', async (t) => {
  const calls = [];
  const store = await sshStore(t, {
    async del(path) { calls.push(path); },
  });
  store.sessions = [{ id: 'session-a', label: 'Код', role: 'code' }];
  await store.closeSession('session-a');

  assert.deepEqual(calls, ['/api/ssh/sessions/session-a']);
});
