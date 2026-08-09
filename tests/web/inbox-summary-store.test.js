import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';

const storePath = new URL('../../web/src/stores/inbox.js', import.meta.url);
const piniaUrl = pathToFileURL(new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url).pathname).href;

async function loadStore() {
  const source = (await readFile(storePath, 'utf8'))
    .replace("import { defineStore } from 'pinia';", `import { defineStore } from '${piniaUrl}';`)
    .replace("import { api } from '../shared/api-client.js';", 'const api = globalThis.__inboxSummaryApi;')
    .replace("import { sseSubscribe } from '../composables/useSse.js';", 'const sseSubscribe = globalThis.__inboxSummarySubscribe;');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

test('Inbox summary использует один SSE, минутный poll и очищается при выключенном плагине', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let resolveInitial;
  const initial = new Promise((resolve) => { resolveInitial = resolve; });
  const responses = [initial, { newCount: 5, mixedCount: 2, reviewCount: 8 }];
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
    const { useInboxStore } = await loadStore();
    setActivePinia(createPinia());
    const store = useInboxStore();

    store.start();
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
    resolveInitial({ newCount: 3, mixedCount: 1, reviewCount: 6 });
    await flush();
    assert.equal(store.reviewCount, 8, 'server учитывает ещё созревающие new');
    assert.equal(calls.length, 2);

    responses.push({ newCount: 0, mixedCount: 3 });
    intervals[0].callback();
    await flush();
    assert.equal(store.reviewCount, 3, 'до рестарта старого server сохраняется совместимый fallback');

    const disabled = new Error('disabled');
    disabled.data = { error: 'plugin_disabled' };
    responses.push(disabled);
    intervals[0].callback();
    await flush();
    assert.equal(store.reviewCount, 0);
    assert.equal(store.loaded, false);
    assert.equal(store.started, false);
    assert.equal(unsubscribed, 1);
    assert.deepEqual(cleared, [intervals[0]]);

    store.stop();
    assert.equal(unsubscribed, 1);
    assert.deepEqual(cleared, [intervals[0]]);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    delete globalThis.__inboxSummaryApi;
    delete globalThis.__inboxSummarySubscribe;
  }
});
