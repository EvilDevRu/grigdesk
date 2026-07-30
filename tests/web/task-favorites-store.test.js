import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STORE_PATH = fileURLToPath(new URL('../../web/src/stores/task-favorites.js', import.meta.url));
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;

const apiHarness = {};
globalThis.__taskFavoritesApi = apiHarness;
let actualStoreModule;

async function loadActualStore() {
  if (actualStoreModule) return actualStoreModule;
  let code = await readFile(STORE_PATH, 'utf8');
  code = code
    .replace("import { defineStore } from 'pinia';", `import { defineStore } from "${PINIA_URL}";`)
    .replace(
      "import { api } from '../shared/api-client.js';",
      'const api = globalThis.__taskFavoritesApi;',
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

async function fixture() {
  const [{ createPinia, setActivePinia }, { useTaskFavoritesStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    loadActualStore(),
  ]);
  setActivePinia(createPinia());
  return useTaskFavoritesStore();
}

test('WEB-01: load применяет server snapshot', async () => {
  const store = await fixture();
  apiHarness.get = async () => ({ scope: 'scope-a', revision: 2, taskIds: ['11', 22, '11'] });

  assert.equal(await store.load(), true);
  assert.equal(store.scope, 'scope-a');
  assert.equal(store.revision, 2);
  assert.deepEqual(store.taskIds, ['11', '22']);
  assert.equal(store.isFavorite(22), true);
  assert.equal(store.loaded, true);
});

test('WEB-02/03: новый scope заменяет большую revision, stale того же scope игнорируется', async () => {
  const store = await fixture();
  store.applySnapshot({ scope: 'scope-a', revision: 9, taskIds: ['99'] });
  store.applySnapshot({ scope: 'scope-b', revision: 1, taskIds: ['11'] });

  assert.equal(store.scope, 'scope-b');
  assert.equal(store.revision, 1);
  assert.deepEqual(store.taskIds, ['11']);

  assert.equal(store.applySnapshot({ scope: 'scope-b', revision: 0, taskIds: ['22'] }), false);
  assert.equal(store.revision, 1);
  assert.deepEqual(store.taskIds, ['11']);
});

test('WEB-04: PUT меняет звезду только после успешного ответа', async () => {
  const store = await fixture();
  store.applySnapshot({ scope: 'scope-a', revision: 0, taskIds: [] });
  const response = deferred();
  apiHarness.put = async () => response.promise;

  const pending = store.setFavorite(42, true);
  await Promise.resolve();
  assert.equal(store.isFavorite(42), false);
  assert.equal(store.isPending(42), true);

  response.resolve({ scope: 'scope-a', revision: 1, taskIds: ['42'] });
  assert.equal(await pending, true);
  assert.equal(store.isFavorite(42), true);
  assert.equal(store.isPending(42), false);
});

test('WEB-05: DELETE держит звезду до успешного ответа', async () => {
  const store = await fixture();
  store.applySnapshot({ scope: 'scope-a', revision: 1, taskIds: ['42'] });
  const response = deferred();
  apiHarness.del = async () => response.promise;

  const pending = store.setFavorite('42', false);
  await Promise.resolve();
  assert.equal(store.isFavorite(42), true);

  response.resolve({ scope: 'scope-a', revision: 2, taskIds: [] });
  assert.equal(await pending, true);
  assert.equal(store.isFavorite(42), false);
});

test('WEB-06: ошибка мутации сохраняет прежнее состояние', async () => {
  const store = await fixture();
  store.applySnapshot({ scope: 'scope-a', revision: 1, taskIds: ['42'] });
  apiHarness.del = async () => { throw new Error('диск недоступен'); };

  assert.equal(await store.setFavorite(42, false), false);
  assert.equal(store.isFavorite(42), true);
  assert.match(store.error, /диск недоступен/);
});

test('WEB-07: pending id защищён от повторной мутации', async () => {
  const store = await fixture();
  store.applySnapshot({ scope: 'scope-a', revision: 0, taskIds: [] });
  const response = deferred();
  let calls = 0;
  apiHarness.put = async () => {
    calls += 1;
    return response.promise;
  };

  const first = store.setFavorite(42, true);
  const second = store.setFavorite(42, true);
  assert.equal(await second, false);
  assert.equal(calls, 1);

  response.resolve({ scope: 'scope-a', revision: 1, taskIds: ['42'] });
  await first;
});

test('WEB-08: clear удаляет account-scoped состояние из памяти', async () => {
  const store = await fixture();
  store.applySnapshot({ scope: 'scope-a', revision: 3, taskIds: ['42'] });
  store.error = 'ошибка';

  store.clear();

  assert.equal(store.scope, '');
  assert.equal(store.revision, -1);
  assert.deepEqual(store.taskIds, []);
  assert.equal(store.loaded, false);
  assert.equal(store.error, null);
});

test('WEB-09: поздний ответ старого scope не возвращает аккаунт после новой загрузки', async () => {
  const store = await fixture();
  store.applySnapshot({ scope: 'scope-a', revision: 1, taskIds: ['11'] });
  const oldMutation = deferred();
  apiHarness.put = async () => oldMutation.promise;
  apiHarness.get = async () => ({ scope: 'scope-b', revision: 0, taskIds: [] });

  const mutation = store.setFavorite(22, true);
  await Promise.resolve();
  assert.equal(await store.load(true), true);
  assert.equal(store.scope, 'scope-b');

  oldMutation.resolve({ scope: 'scope-a', revision: 2, taskIds: ['11', '22'] });
  await mutation;
  assert.equal(store.scope, 'scope-b');
  assert.deepEqual(store.taskIds, []);
});
