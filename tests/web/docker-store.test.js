import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import {
  groupComposeProjects,
  normalizeContainers,
  summarizeDiskUsage,
} from '../../server/src/lib/docker/inventory.ts';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const STORE_PATH = webFile('src/stores/docker.ts');

const HEALTH = {
  available: true,
  version: '29.5.2',
  apiVersion: '1.54',
  socketPath: '/var/run/docker.sock',
};

const CONTAINERS = normalizeContainers([
  {
    Id: 'a',
    Names: ['/app-1'],
    State: 'running',
    Labels: { 'com.docker.compose.project': 'proj' },
  },
  { Id: 'b', Names: ['/db-1'], State: 'exited' },
]);

const OVERVIEW = {
  containers: CONTAINERS,
  projects: groupComposeProjects(CONTAINERS),
  images: [],
  volumes: [],
  networks: [],
  counts: { containers: 2, running: 1, images: 0, volumes: 0, networks: 0 },
};

const USAGE = {
  ...summarizeDiskUsage({ containers: CONTAINERS }),
  cached: false,
  computedAt: '2026-09-07T01:00:00.000Z',
};

const STATS = {
  cpuPercent: 12,
  memoryUsed: 1024,
  memoryLimit: 4096,
  memoryPercent: 25,
  networkRx: 0,
  networkTx: 0,
  blockRead: 0,
  blockWrite: 0,
  pids: 1,
};

/**
 * Двойник WebSocket: считает открытые соединения и запоминает отправленное —
 * именно это проверяется у наблюдателя статистики, а не факт «что-то вызвалось».
 */
function socketFactory() {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  return { sockets, FakeSocket };
}

async function storeFixture(t, api) {
  globalThis.__dockerStoreHarness = { api };
  const module = await compileModule(STORE_PATH, {
    stubs: {
      './api-client.js': (
        'export const api = globalThis.__dockerStoreHarness.api;'
      ),
    },
  });
  setActivePinia(createPinia());
  const store = module.useDockerStore();
  t.after(() => {
    store.stopStats();
    delete globalThis.__dockerStoreHarness;
  });
  return { store, module };
}

test('недоступный демон не оставляет на экране прошлый список контейнеров', async (t) => {
  let available = true;
  const { store } = await storeFixture(t, {
    base: '',
    wsUrl: (path) => `ws://test${path}`,
    async get(path) {
      if (path === '/api/docker/health') {
        return available
          ? HEALTH
          : {
            available: false,
            error: 'docker_error',
            message: 'сокет Docker не найден',
            socketPath: '/var/run/docker.sock',
          };
      }
      return OVERVIEW;
    },
  });

  await store.load();
  assert.equal(store.containers.length, 2);

  available = false;
  await store.load();

  assert.equal(store.health.available, false);
  assert.equal(store.containers.length, 0, 'мёртвый демон не должен показывать вчерашнее состояние');
  assert.equal(store.error, '', 'недоступность демона — это состояние, а не ошибка запроса');
});

test('уборка передаёт выбор человека и обновляет обзор вместе со сводкой', async (t) => {
  const posted = [];
  const requested = [];
  const { store } = await storeFixture(t, {
    base: '',
    wsUrl: (path) => `ws://test${path}`,
    async get(path) {
      requested.push(path);
      if (path === '/api/docker/health') return HEALTH;
      if (path.startsWith('/api/docker/usage')) return USAGE;
      return OVERVIEW;
    },
    async post(path, body) {
      posted.push([path, body]);
      return { ok: true, report: { images: { removed: 3, freed: 1024 } } };
    },
  });

  const result = await store.prune({ targets: ['images'], allImages: true });

  assert.equal(result.ok, true);
  assert.deepEqual(posted[0], ['/api/docker/prune', { targets: ['images'], allImages: true }]);
  assert.ok(requested.includes('/api/docker/usage?force=1'), 'после уборки сводка считается заново');
  assert.deepEqual(result.report.images, { removed: 3, freed: 1024 });
});

test('отказ сервера возвращается сообщением, а не рушит панель', async (t) => {
  const error = new Error('HTTP 403');
  error.data = { error: 'volumes_forbidden', message: 'удаление томов запрещено настройками плагина' };
  const { store } = await storeFixture(t, {
    base: '',
    wsUrl: (path) => `ws://test${path}`,
    async get() { return HEALTH; },
    async del() { throw error; },
  });

  const result = await store.removeVolume('data');

  assert.equal(result.ok, false);
  assert.match(result.message, /запрещено/u);
  assert.equal(store.busyIds.length, 0, 'пометка занятости снимается и после отказа');
});

test('наблюдатель статистики держит одно соединение и переспрашивает только новый список', async (t) => {
  const { sockets, FakeSocket } = socketFactory();
  const { store } = await storeFixture(t, {
    base: '',
    wsUrl: (path) => `ws://test${path}`,
    async get() { return HEALTH; },
  });
  globalThis.WebSocket = FakeSocket;
  t.after(() => { delete globalThis.WebSocket; });
  store.stopStats();

  store.watchStats(['a', 'b']);
  store.watchStats(['a', 'b']);

  assert.equal(sockets.length, 1, 'повторный вызов с тем же списком не открывает второе соединение');
  sockets[0].onopen?.();
  assert.deepEqual(sockets[0].sent.at(-1), { t: 'watch', ids: ['a', 'b'] });

  store.watchStats(['a']);
  assert.equal(sockets.length, 1);
  assert.deepEqual(sockets[0].sent.at(-1), { t: 'watch', ids: ['a'] });

  sockets[0].onmessage?.({
    data: JSON.stringify({ t: 'stats', at: '2026-09-07T01:00:00.000Z', items: { a: STATS } }),
  });
  assert.equal(store.stats.a.cpuPercent, 12);

  sockets[0].onmessage?.({ data: JSON.stringify({ t: 'stats', items: { a: { cpuPercent: '12' } } }) });
  assert.deepEqual(store.stats.a, STATS, 'повреждённый кадр не заменяет последний корректный срез');

  store.stopStats();
  assert.equal(sockets[0].readyState, 3);
  assert.deepEqual(store.stats, {});

  sockets[0].onmessage?.({
    data: JSON.stringify({ t: 'stats', at: '2026-09-07T01:00:00.000Z', items: { a: STATS } }),
  });
  assert.deepEqual(store.stats, {}, 'запоздалый кадр закрытого соединения не восстанавливает статистику');
});

test('некорректный обзор не обновляет списки частично и сообщает об ошибке', async (t) => {
  let overview = OVERVIEW;
  const { store } = await storeFixture(t, {
    async get(path) {
      return path === '/api/docker/health' ? HEALTH : overview;
    },
  });

  await store.load();
  assert.equal(store.error, '');
  assert.deepEqual(store.projectsWithContainers[0].items, [CONTAINERS[0]]);
  assert.deepEqual(store.looseContainers, [CONTAINERS[1]]);

  overview = { ...OVERVIEW, containers: [], images: 'сломанный список' };
  await store.load();

  assert.deepEqual(store.containers, CONTAINERS, 'список контейнеров обновляется вместе со всем обзором');
  assert.deepEqual(store.counts, OVERVIEW.counts);
  assert.match(store.error, /Docker/u);
  assert.equal(store.loading, false);
});

test('невалидная доступность Docker не заменяет подтверждённое состояние демона', async (t) => {
  let health = HEALTH;
  const { store } = await storeFixture(t, {
    async get(path) {
      return path === '/api/docker/health' ? health : OVERVIEW;
    },
  });

  await store.load();
  health = { ...HEALTH, available: 'да' };
  await store.load();

  assert.deepEqual(store.health, HEALTH);
  assert.deepEqual(store.containers, CONTAINERS);
  assert.match(store.error, /Docker/u);
  assert.equal(store.loading, false);
});

test('повреждённая сводка места сохраняет прошлые цифры и снимает загрузку', async (t) => {
  let usage = USAGE;
  const { store } = await storeFixture(t, {
    async get() {
      return usage;
    },
  });

  await store.loadUsage();
  assert.equal(store.usageError, '');

  usage = { ...USAGE, images: { ...USAGE.images, reclaimable: 'много' } };
  await store.loadUsage();

  assert.deepEqual(store.usage, USAGE);
  assert.match(store.usageError, /Docker/u);
  assert.equal(store.usageLoading, false);
});

test('некорректное подтверждение действия не объявляется успехом', async (t) => {
  let overviewRequests = 0;
  const { store } = await storeFixture(t, {
    async get() {
      overviewRequests += 1;
      return HEALTH;
    },
    async post() {
      return { ok: 'true' };
    },
  });

  const result = await store.containerAction('a', 'stop');

  assert.equal(result.ok, false);
  assert.match(result.message, /Docker/u);
  assert.equal(overviewRequests, 0, 'неподтверждённое действие не запускает обновление обзора');
  assert.deepEqual(store.busyIds, []);
});

test('частичный отказ проекта сохраняет результаты его контейнеров', async (t) => {
  const response = {
    ok: false,
    project: 'proj',
    action: 'stop',
    results: [
      { id: 'a', name: 'app-1', ok: true },
      { id: 'b', name: 'db-1', ok: false, message: 'контейнер занят' },
    ],
  };
  const { store } = await storeFixture(t, {
    async get(path) {
      return path === '/api/docker/health' ? HEALTH : OVERVIEW;
    },
    async post() {
      return response;
    },
  });

  const result = await store.projectAction('proj', 'stop');

  assert.equal(result.ok, false);
  assert.deepEqual(result.results, response.results);
  assert.deepEqual(store.busyIds, []);
  assert.equal(store.error, '');
});
