import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  emptyReviewsSummary,
  normalizeReviewsSnapshot,
  refreshReviewsFromSignal,
  reviewRefreshTarget,
} from '../../web/src/shared/review-chip.js';

const STORE_PATH = fileURLToPath(new URL('../../web/src/stores/reviews.js', import.meta.url));
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;
const REVIEW_CHIP_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/shared/review-chip.js', import.meta.url),
)).href;
const apiHarness = {};
globalThis.__reviewsStoreApi = apiHarness;
globalThis.__reviewsStoreSubscribe = () => () => {};

let actualStoreModule;
async function loadActualStore() {
  if (actualStoreModule) return actualStoreModule;
  let code = await readFile(STORE_PATH, 'utf8');
  code = code
    .replace("import { defineStore } from 'pinia';", `import { defineStore } from "${PINIA_URL}";`)
    .replace(
      "import { api } from '../shared/api-client.js';",
      'const api = globalThis.__reviewsStoreApi;',
    )
    .replace(
      "import { sseSubscribe } from '../composables/useSse.js';",
      'const sseSubscribe = globalThis.__reviewsStoreSubscribe;',
    )
    .replace(
      "} from '../shared/review-chip.js';",
      `} from "${REVIEW_CHIP_URL}";`,
    );
  actualStoreModule = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  );
  return actualStoreModule;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('полный снимок нормализуется без локального подсчёта событий', () => {
  const payload = {
    pulls: [{
      id: 'repo:1',
      state: 'open',
      attention: 'blue',
      remarks: [{ id: 'a' }, { id: 'b' }],
    }],
    summary: { count: 1, tone: 'blue', title: 'Один новый PR', version: 8 },
    repositories: [{
      projectId: 'project',
      repoKey: 'app',
      repoSlug: 'example/app',
      canFix: false,
      configurationError: { code: 'REVIEW_EXECUTOR_UNAVAILABLE', message: 'Исправление отключено' },
    }],
  };

  assert.deepEqual(normalizeReviewsSnapshot(payload), {
    pulls: payload.pulls,
    summary: payload.summary,
    repositories: payload.repositories,
  });
  assert.deepEqual(normalizeReviewsSnapshot(null), {
    pulls: [],
    summary: emptyReviewsSummary(),
    repositories: [],
  });
});

test('UI-07: SSE и reconnect выбирают канонический snapshot, а не increment', () => {
  assert.equal(reviewRefreshTarget('reviews-change', true), 'full');
  assert.equal(reviewRefreshTarget('reviews-change', false), 'summary');
  assert.equal(reviewRefreshTarget('hello', true), 'full');
  assert.equal(reviewRefreshTarget('state-change', true), '');
});

test('повторные и переставленные SSE каждый раз перечитывают снимок', async () => {
  const calls = [];
  const options = {
    fullLoaded: true,
    loadFull: async () => { calls.push('GET /api/reviews'); },
    loadSummary: async () => { calls.push('GET /api/reviews/summary'); },
  };

  await refreshReviewsFromSignal('reviews-change', options);
  await refreshReviewsFromSignal('hello', options);
  await refreshReviewsFromSignal('reviews-change', options);

  assert.deepEqual(calls, [
    'GET /api/reviews',
    'GET /api/reviews',
    'GET /api/reviews',
  ]);
});

test('до открытия страницы SSE обновляет только лёгкую серверную сводку', async () => {
  const calls = [];
  const target = await refreshReviewsFromSignal('reviews-change', {
    fullLoaded: false,
    loadFull: async () => { calls.push('full'); },
    loadSummary: async () => { calls.push('summary'); },
  });

  assert.equal(target, 'summary');
  assert.deepEqual(calls, ['summary']);
});

test('API-SEC-03: clear не позволяет запоздавшему GET вернуть review-тексты в память', async () => {
  const [{ createPinia, setActivePinia }, { useReviewsStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    loadActualStore(),
  ]);
  setActivePinia(createPinia());
  const response = deferred();
  apiHarness.get = async () => response.promise;
  const store = useReviewsStore();

  const pending = store.load();
  store.clear();
  response.resolve({
    pulls: [{ id: 'private-pr', title: 'Приватный текст', attention: 'blue' }],
    summary: { count: 1, tone: 'blue' },
  });
  await pending;

  assert.deepEqual(store.pulls, []);
  assert.equal(store.summary.count, 0);
  assert.equal(store.fullLoaded, false);
  assert.equal(store.loading, false);
});

test('UI-07: SSE во время первого full GET дочитывает новый full snapshot и не оставляет старые карточки', async () => {
  const [{ createPinia, setActivePinia }, { useReviewsStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    loadActualStore(),
  ]);
  setActivePinia(createPinia());
  const staleFull = deferred();
  const freshFull = deferred();
  const summary = deferred();
  let fullCalls = 0;
  apiHarness.get = async (path) => {
    if (path === '/api/reviews/summary') return summary.promise;
    fullCalls += 1;
    return fullCalls === 1 ? staleFull.promise : freshFull.promise;
  };
  const store = useReviewsStore();

  const fullRequest = store.load();
  const signal = store.onSse('reviews-change');
  summary.resolve({ count: 2, tone: 'yellow', title: 'Новая сводка', version: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fullCalls, 2);
  freshFull.resolve({
    pulls: [{ id: 'pr-2', state: 'open', attention: 'yellow' }],
    summary: { count: 2, tone: 'yellow', title: 'Новая сводка', version: 2 },
  });
  await signal;
  staleFull.resolve({
    pulls: [{ id: 'pr-stale', state: 'open', attention: 'blue' }],
    summary: { count: 1, tone: 'blue', title: 'Старая сводка', version: 1 },
  });
  await fullRequest;

  assert.equal(store.pulls.length, 1);
  assert.equal(store.pulls[0].id, 'pr-2');
  assert.equal(store.fullLoaded, true);
  assert.deepEqual(store.summary, {
    count: 2,
    tone: 'yellow',
    title: 'Новая сводка',
    version: 2,
  });
});

test('API-SEC-03: logout отменяет дополнительный full GET после SSE-гонки', async () => {
  const [{ createPinia, setActivePinia }, { useReviewsStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    loadActualStore(),
  ]);
  setActivePinia(createPinia());
  const full = deferred();
  const summary = deferred();
  let fullCalls = 0;
  apiHarness.get = async (path) => {
    if (path === '/api/reviews/summary') return summary.promise;
    fullCalls += 1;
    return full.promise;
  };
  const store = useReviewsStore();

  const pending = store.load();
  const signal = store.onSse('reviews-change');
  store.clear();
  summary.resolve({ count: 1, tone: 'blue', version: 2 });
  await signal;
  assert.equal(fullCalls, 1);

  full.resolve({
    pulls: [{ id: 'private-pr', title: 'Приватный текст', attention: 'blue' }],
    summary: { count: 1, tone: 'blue', version: 1 },
  });
  await pending;
  assert.deepEqual(store.pulls, []);
  assert.equal(store.fullLoaded, false);
});

test('publication_unknown: сверка не просит новый push, повтор передаёт явный retryUnknown', async () => {
  const [{ createPinia, setActivePinia }, { useReviewsStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    loadActualStore(),
  ]);
  setActivePinia(createPinia());
  const calls = [];
  apiHarness.post = async (...args) => {
    calls.push(structuredClone(args));
    return {
      pulls: [],
      summary: { count: 0, tone: '', title: '', version: 1 },
    };
  };
  const store = useReviewsStore();

  await store.publish('rr/unknown');
  await store.publish('rr/unknown', { retryUnknown: true });

  assert.deepEqual(calls, [
    ['/api/reviews/runs/rr%2Funknown/publish'],
    ['/api/reviews/runs/rr%2Funknown/publish', { retryUnknown: true }],
  ]);
});

test('отказ от VERIFIED/ACCEPTED отправляется отдельной явной мутацией', async () => {
  const [{ createPinia, setActivePinia }, { useReviewsStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    loadActualStore(),
  ]);
  setActivePinia(createPinia());
  const calls = [];
  apiHarness.post = async (...args) => {
    calls.push(structuredClone(args));
    return {
      pulls: [],
      summary: { count: 0, tone: '', title: '', version: 2 },
    };
  };
  const store = useReviewsStore();

  await store.abandon('rr/accepted');

  assert.deepEqual(calls, [
    ['/api/reviews/runs/rr%2Faccepted/abandon', {}],
  ]);
});

test('ручной анализ из карточки отправляет только выбранное замечание', async () => {
  const [{ createPinia, setActivePinia }, { useReviewsStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    loadActualStore(),
  ]);
  setActivePinia(createPinia());
  const calls = [];
  apiHarness.post = async (...args) => {
    calls.push(structuredClone(args));
    return {
      pulls: [],
      repositories: [],
      summary: { count: 0, tone: '', title: '', version: 3 },
    };
  };
  const store = useReviewsStore();

  await store.analyze('pull/id', 'remark/id');

  assert.deepEqual(calls, [[
    '/api/reviews/pulls/pull%2Fid/analyze',
    { remarkId: 'remark/id' },
  ]]);
});
