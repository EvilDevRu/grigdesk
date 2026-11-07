import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPinia } from '../../web/node_modules/pinia/dist/pinia.mjs';

import { createWebLogRuntime } from '../../web/src/shared/webLogRuntime.ts';

test('runtime создаёт app.start первым и ручную отметку без AppShell', () => {
  const win = new EventTarget();
  const doc = new EventTarget();
  Object.defineProperty(doc, 'visibilityState', { value: 'visible' });
  const app = { config: { errorHandler: null } };
  const router = { currentRoute: { value: { path: '/chats' } },
    beforeEach: () => () => {}, afterEach: () => () => {}, onError: () => () => {} };
  const pinia = { use: () => {} };
  const runtime = createWebLogRuntime({ app, router, pinia, win, doc,
    fetch: async () => { throw new Error('offline'); }, url: '/api/web-log',
    storage: null, beacon: () => false });
  const start = runtime.log.snapshot().entries[0];
  assert.equal(start.ev, 'app.start');
  assert.equal(start.data.sw, 'unsupported');
  assert.ok(runtime.mark('Сбой'));
  assert.deepEqual(runtime.log.snapshot().entries.at(-1).data, { text: 'Сбой' });
  runtime.dispose();
});

test('отказ API записывается шаблоном из каталога сервера, каталог переживает F5', async () => {
  const values = new Map();
  const storage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: (name) => values.delete(name),
  };
  const options = () => {
    const doc = new EventTarget();
    Object.defineProperty(doc, 'visibilityState', { value: 'visible' });

    return {
      app: { config: { errorHandler: null } },
      router: { currentRoute: { value: { path: '/chats' } },
        beforeEach: () => () => {}, afterEach: () => () => {}, onError: () => () => {} },
      pinia: createPinia(),
      win: new EventTarget(),
      doc,
      fetch: async (url) => {
        assert.equal(url, '/api/web-log/routes');
        return new Response(JSON.stringify({ routes: ['/api/tasks/:id/graph', '/api/tasks'] }));
      },
      url: '/api/web-log',
      routesUrl: '/api/web-log/routes',
      storage,
      beacon: () => false,
    };
  };
  const auth = {
    ready: true, authenticated: true, logEpoch: 0, logConfirmation: 1, logReason: 'load',
    $subscribe: () => () => {},
  };
  const fail = (runtime, path) => runtime.recordApi('api.fail', { method: 'GET', path, status: 502,
    ms: 5, attempt: 1, willRetry: false });
  const runtime = createWebLogRuntime(options());

  fail(runtime, '/api/tasks/7/graph');
  assert.equal(runtime.log.snapshot().entries.at(-1).data.path, 'other', 'до каталога шаблона нет');
  runtime.attachAuthStore(auth);
  await runtime.loadApiRoutes();
  fail(runtime, '/api/tasks/8/graph');
  fail(runtime, '/api/auth/state');
  const paths = runtime.log.snapshot().entries.filter((entry) => entry.ev === 'api.fail')
    .map((entry) => entry.data.path);
  assert.deepEqual(paths, ['other', '/api/tasks/:id/graph', '/api/auth/state']);
  runtime.dispose();

  const reloaded = createWebLogRuntime(options());
  fail(reloaded, '/api/tasks/9/graph');
  assert.equal(reloaded.log.snapshot().entries.at(-1).data.path, '/api/tasks/:id/graph');
  assert.doesNotMatch(JSON.stringify(reloaded.log.snapshot().entries), /\/7\/|\/8\/|\/9\//u);
  reloaded.dispose();
});

test('срок уровня соблюдается до и после F5 без связи с сервером', async () => {
  const key = 'grigdesk-diagnostic-level-v2';
  const values = new Map([[key, JSON.stringify({
    level: 'verbose', expiresAt: Math.floor(Date.now() / 1000) - 1,
  })]]);
  const storage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: (name) => values.delete(name),
  };
  const win = new EventTarget();
  const doc = new EventTarget();
  Object.defineProperty(doc, 'visibilityState', { value: 'visible' });
  const app = { config: { errorHandler: null } };
  const router = { currentRoute: { value: { path: '/chats' } },
    beforeEach: () => () => {}, afterEach: () => () => {}, onError: () => () => {} };
  const options = {
    app, router, pinia: { use: () => {} }, win, doc,
    fetch: async () => { throw new Error('offline'); },
    url: '/api/web-log', policyUrl: '/api/settings/factory-debug?scope=global',
    storage, beacon: () => false,
  };
  const runtime = createWebLogRuntime(options);

  assert.equal(runtime.log.level(), 'off');
  assert.equal(runtime.mark('После срока действия'), null);
  runtime.applyPolicy('errors');
  assert.equal(runtime.log.level(), 'errors');
  assert.equal(JSON.parse(values.get(key)).expiresAt, 0);
  const future = Math.floor(Date.now() / 1000) + 60;
  runtime.applyPolicy('decisions', future);
  assert.equal(JSON.parse(values.get(key)).expiresAt, future);
  runtime.applyPolicy('verbose', Math.floor(Date.now() / 1000) - 1);
  assert.equal(runtime.log.level(), 'off');
  assert.equal(JSON.parse(values.get(key)).level, 'off');
  runtime.dispose();

  values.set(key, JSON.stringify({
    level: 'decisions', expiresAt: Math.floor(Date.now() / 1000) + 1,
  }));
  const reloaded = createWebLogRuntime(options);
  assert.equal(reloaded.log.level(), 'decisions');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(reloaded.log.level(), 'off');
  assert.equal(reloaded.mark('После локального истечения'), null);
  reloaded.dispose();
});
