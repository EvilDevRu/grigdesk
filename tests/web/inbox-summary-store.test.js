// Счётчик очереди во внешней оболочке: состояние живёт в сторе, а запрос, таймер
// перепроверки и подписка на события — в операциях раздела. Тест проверяет обе
// стороны границы: и поведение, и то, что стор её не переступает.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

const ACTIONS_PATH = webFile('src/actions/inbox/index.ts');
const STORE_PATH = webFile('src/stores/inbox.ts');

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

async function loadSection() {
  return compileModule(ACTIONS_PATH, {
    stubs: {
      './api-client.js': 'export const api = globalThis.__inboxSummaryApi;',
      '../../composables/useSse.js': (
        'export const sseSubscribe = (...args) => globalThis.__inboxSummarySubscribe(...args);'
      ),
    },
  });
}

test('Inbox summary использует один SSE, минутный poll и очищается при выключенном плагине', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let resolveInitial;
  const initial = new Promise((resolve) => { resolveInitial = resolve; });
  const responses = [initial, {
    newCount: 5, mixedCount: 2, reviewCount: 8, truncated: false,
  }];
  const calls = [];
  const intervals = [];
  const cleared = [];
  const subscribers = [];
  let unsubscribed = 0;

  globalThis.__inboxSummaryApi = {
    async get(path) {
      calls.push(path);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
  globalThis.__inboxSummarySubscribe = (callback) => {
    subscribers.push(callback);
    return () => { unsubscribed += 1; };
  };
  globalThis.setInterval = (callback, delay) => {
    const handle = { callback, delay, unref() {} };
    intervals.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => cleared.push(handle);

  try {
    const module = await loadSection();
    setActivePinia(createPinia());
    const store = module.useInboxStore();

    module.startInboxSummary();
    assert.equal(store.loaded, false);
    assert.deepEqual(calls, ['/api/inbox/summary']);
    assert.equal(subscribers.length, 1);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].delay, 60_000);

    subscribers[0]('unrelated-event');
    assert.equal(calls.length, 1);

    // Событие во время initial fetch не запускает параллельный запрос, но
    // гарантирует одну повторную сверку после его завершения.
    subscribers[0]('inbox-changed');
    assert.equal(calls.length, 1);
    resolveInitial({
      newCount: 3, mixedCount: 1, reviewCount: 6, truncated: false,
    });
    await flush();
    assert.equal(store.reviewCount, 8, 'server учитывает ещё созревающие new');
    assert.equal(calls.length, 2);

    responses.push({ newCount: 0, mixedCount: 3, truncated: false });
    intervals[0].callback();
    await flush();
    assert.equal(store.reviewCount, 3, 'до рестарта старого server сохраняется совместимый fallback');

    const disabled = new Error('disabled');
    disabled.status = 404;
    disabled.data = { error: 'plugin_disabled' };
    responses.push(disabled);
    intervals[0].callback();
    await flush();
    assert.equal(store.reviewCount, 0);
    assert.equal(store.loaded, false);
    assert.equal(store.started, false);
    assert.equal(unsubscribed, 1);
    assert.deepEqual(cleared, [intervals[0]]);

    module.stopInboxSummary();
    assert.equal(unsubscribed, 1);
    assert.deepEqual(cleared, [intervals[0]]);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    delete globalThis.__inboxSummaryApi;
    delete globalThis.__inboxSummarySubscribe;
  }
});

test('повреждённая сводка не становится счётчиком очереди в шапке', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  globalThis.__inboxSummaryApi = {
    async get() {
      return { newCount: 'много', mixedCount: 0, truncated: false };
    },
  };
  globalThis.__inboxSummarySubscribe = () => () => {};
  globalThis.setInterval = () => ({ unref() {} });
  globalThis.clearInterval = () => {};

  try {
    const module = await loadSection();
    setActivePinia(createPinia());
    const store = module.useInboxStore();

    module.startInboxSummary();
    await flush();

    assert.deepEqual({ reviewCount: store.reviewCount, loaded: store.loaded }, {
      reviewCount: 0,
      loaded: false,
    });

    module.stopInboxSummary();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    delete globalThis.__inboxSummaryApi;
    delete globalThis.__inboxSummarySubscribe;
  }
});

test('стор входящих не знает ни путей API, ни таймера', async () => {
  const source = await readFile(STORE_PATH, 'utf8');
  const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map(([, from]) => from);

  assert.deepEqual(imports, ['pinia']);
  assert.equal(/\/api\//u.test(source), false, 'адреса API живут в слое операций');
  assert.equal(/setInterval/u.test(source), false, 'таймер живёт в слое операций');
});
