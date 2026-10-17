// Состояние раздела SSH и его операции разведены: стор держит снимок, операции ходят
// в сеть и владеют каналом терминала. Тест проверяет обе стороны границы — и поведение,
// и то, что стор её не переступает.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const ACTIONS_PATH = webFile('src/actions/ssh/index.ts');
const STORE_PATH = webFile('src/stores/ssh.ts');

function session(overrides = {}) {
  return {
    id: 'session-a',
    connectionId: 'connection-a',
    projectId: 'cockpit',
    label: 'Боевой код',
    role: 'code',
    host: 'server.internal',
    port: 22,
    user: 'deploy',
    agentAllowed: false,
    generation: 1,
    openedAt: '2026-09-08T08:00:00.000Z',
    ...overrides,
  };
}

function connection(overrides = {}) {
  return {
    id: 'connection-a',
    projectId: 'cockpit',
    label: 'Боевой код',
    role: 'code',
    host: 'server.internal',
    port: 22,
    user: 'deploy',
    ...overrides,
  };
}

async function sshSection(t, api, sockets = []) {
  await installUiBrowser(t, 'http://cockpit.test/#/ssh');
  globalThis.__sshStoreApi = api;
  globalThis.__sshStoreSocket = class {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.sent = [];
      sockets.push(this);
    }

    close() {
      this.closed = true;
    }

    send(payload) {
      this.sent.push(payload);
    }
  };

  const module = await compileModule(ACTIONS_PATH, {
    stubs: {
      './apiClient.ts': 'export const api = globalThis.__sshStoreApi;',
      '../../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
    },
  });
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );

  setActivePinia(createPinia());
  const store = module.useSshStore();

  module.useSshSocketFactory(globalThis.__sshStoreSocket);
  t.after(() => {
    store.$dispose();
    delete globalThis.__sshStoreApi;
    delete globalThis.__sshStoreSocket;
  });

  return { module, store };
}

test('пароль отправляется байтами без JSON-сериализации', async (t) => {
  const calls = [];
  const { module } = await sshSection(t, {
    async postBytes(path, body) {
      calls.push({ path, body, type: body.constructor.name });

      return { session: session() };
    },
  });

  await module.connectSshSession('connection-a', 'SSH_PASSWORD_SENTINEL_91006');

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

  const { api } = await import(`../../web/src/shared/apiClient.ts?ssh-raw=${Date.now()}`);
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
  const { module, store } = await sshSection(t, {
    async get(path) {
      if (path === '/api/projects') {
        throw new Error('Профиль проекта повреждён');
      }
      if (path === '/api/ssh/connections') {
        return { connections: [connection()] };
      }
      if (path === '/api/ssh/sessions') {
        return { sessions: [session()] };
      }

      return { items: [{ at: '2026-08-28T00:00:00.000Z', command: 'id' }], nextCursor: null };
    },
  });

  await Promise.all([module.loadSsh(), module.loadSshProjects()]);

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

test('повреждённая сводка не становится списком серверов на экране', async (t) => {
  const { module, store } = await sshSection(t, {
    async get(path) {
      if (path === '/api/ssh/connections') {
        return { connections: [{ id: 'connection-a', port: 'двадцать два' }] };
      }

      return { sessions: [], items: [] };
    },
  });

  await module.loadSsh();

  assert.deepEqual(store.connections, []);
  assert.match(store.error, /Некорректный ответ SSH/u);
});

test('переключение вкладки держит только один attach WebSocket', async (t) => {
  const sockets = [];
  const { module, store } = await sshSection(t, {
    wsUrl: (path) => `ws://cockpit.test${path}`,
  }, sockets);

  store.sessions = [session(), session({ id: 'session-b', label: 'База', role: 'db' })];
  module.activateSshSession('session-a');
  module.activateSshSession('session-b');

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
  const { module } = await sshSection(t, {
    wsUrl: (path) => `ws://cockpit.test${path}`,
  }, sockets);

  module.activateSshSession('session-a');
  sockets[0].readyState = 0;
  module.resizeSshTerminal(132, 41);

  assert.deepEqual(sockets[0].sent, []);

  sockets[0].readyState = 1;
  sockets[0].onopen();

  assert.deepEqual(sockets[0].sent, [JSON.stringify({ t: 'resize', cols: 132, rows: 41 })]);
});

test('detach панели не удаляет server-owned сессию', async (t) => {
  const calls = [];
  const { module, store } = await sshSection(t, {
    wsUrl: (path) => `ws://cockpit.test${path}`,
    async del(path) {
      calls.push(path);
    },
  });

  store.sessions = [session()];
  module.activateSshSession('session-a');
  module.detachSshTerminal();

  assert.deepEqual({ calls, sessions: store.sessions.length }, { calls: [], sessions: 1 });
});

test('явное закрытие вкладки удаляет server-owned сессию', async (t) => {
  const calls = [];
  const { module, store } = await sshSection(t, {
    async del(path) {
      calls.push(path);

      return { ok: true };
    },
  });

  store.sessions = [session()];
  await module.closeSshSession('session-a');

  assert.deepEqual({ calls, sessions: store.sessions.length }, {
    calls: ['/api/ssh/sessions/session-a'],
    sessions: 0,
  });
});

test('потерянная сессия не подменяет собой строку списка при смене доступа', async (t) => {
  const { module, store } = await sshSection(t, {
    async put() {
      return { ok: false, error: 'session_lost' };
    },
  });

  store.sessions = [session({ agentAllowed: true })];
  await module.setSshAgentAccess('session-a', false);

  assert.deepEqual(store.sessions, [session({ agentAllowed: true })]);
});

test('стор SSH не знает ни путей API, ни транспорта', async () => {
  const source = await readFile(STORE_PATH, 'utf8');
  const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map(([, from]) => from);

  assert.deepEqual(imports.sort(), ['../../../shared/plugins/ssh/sshContracts.ts', 'pinia']);
  assert.equal(/\/api\//u.test(source), false, 'адреса API живут в слое операций');
  assert.equal(/WebSocket/u.test(source), false, 'канал терминала живёт в слое операций');
});
