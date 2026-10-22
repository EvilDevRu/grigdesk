import { loadProductModule } from './helpers/compile-vue.js';
import { migrationUrl } from './helpers/compile-vue.js';
// Стор серверных отметок «задачу просмотрели». Проверяется ровно то, чем он
// отличается от избранного: базовая линия (`initialized`), переиспользование идущего
// запроса и молчаливая устойчивость к отказу — метка важна, но показу задачи не мешает.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STORE_PATH = fileURLToPath(migrationUrl('src/stores/taskSeen.ts'));
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;

const apiHarness = {};
globalThis.__taskSeenApi = apiHarness;
let actualStoreModule;

/**
 * Компилятор стирает типы, сохраняя отдельный модуль и прежний транспорт теста.
 * Действия и проверки снимков исполняются из настоящего стора.
 */
async function loadActualStore() {
  if (!actualStoreModule) {
    actualStoreModule = await loadProductModule('src/stores/taskSeen.ts', {
      '../shared/apiClient.ts': 'export const api = globalThis.__taskSeenApi;',
    });
  }

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

function snapshot(patch = {}) {
  return {
    scope: 'scope-a', revision: 1, initialized: true, taskIds: [], ...patch,
  };
}

async function fixture() {
  const [{ createPinia, setActivePinia }, { useTaskSeenStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    loadActualStore(),
  ]);
  setActivePinia(createPinia());
  return useTaskSeenStore();
}

test('SEEN-WEB-01: load применяет снимок сервера и нормализует id', async () => {
  const store = await fixture();
  apiHarness.get = async () => snapshot({ revision: 2, taskIds: ['11', 22, '11', ' '] });

  assert.equal(await store.load(), true);
  assert.equal(store.scope, 'scope-a');
  assert.equal(store.revision, 2);
  assert.deepEqual(store.taskIds, ['11', '22']);
  assert.equal(store.isSeen(22), true);
  assert.equal(store.isSeen(33), false);
  assert.equal(store.count, 2);
  assert.equal(store.loaded, true);
  assert.equal(store.ready, true);
});

test('SEEN-WEB-02: без базовой линии стор загружен, но отвечать про новизну не берётся', async () => {
  const store = await fixture();
  apiHarness.get = async () => snapshot({ revision: 0, initialized: false, taskIds: [] });

  assert.equal(await store.load(), true);
  assert.equal(store.loaded, true);
  // loaded и ready — разные вещи: список отметок пуст и до первой базовой линии
  // означает «ещё не знаем», а не «ни одной задачи не открывали».
  assert.equal(store.initialized, false);
  assert.equal(store.ready, false);
});

test('SEEN-WEB-03: битый ответ сервера не подменяет состояние молча', async () => {
  const store = await fixture();
  store.applySnapshot(snapshot({ revision: 3, taskIds: ['11'] }));

  for (const bad of [
    { scope: '', revision: 4, initialized: true, taskIds: [] },
    { scope: 'scope-a', revision: -1, initialized: true, taskIds: [] },
    { scope: 'scope-a', revision: 4, taskIds: [] },
    { scope: 'scope-a', revision: 4, initialized: true },
  ]) {
    assert.throws(() => store.applySnapshot(bad), /отметки просмотра/i);
  }
  assert.equal(store.revision, 3);
  assert.deepEqual(store.taskIds, ['11']);
});

test('SEEN-WEB-04: новый scope сильнее большой revision, stale того же scope игнорируется', async () => {
  const store = await fixture();
  store.applySnapshot(snapshot({ revision: 9, taskIds: ['99'] }));
  store.applySnapshot(snapshot({ scope: 'scope-b', revision: 1, taskIds: ['11'] }));

  assert.equal(store.scope, 'scope-b');
  assert.deepEqual(store.taskIds, ['11']);

  assert.equal(store.applySnapshot(snapshot({ scope: 'scope-b', revision: 0, taskIds: ['22'] })), false);
  assert.equal(store.revision, 1);
  assert.deepEqual(store.taskIds, ['11']);
});

test('SEEN-WEB-05: идущая загрузка переиспользуется, а не пропускается', async () => {
  const store = await fixture();
  const response = deferred();
  let calls = 0;
  apiHarness.get = async () => {
    calls += 1;
    return response.promise;
  };

  // Доску и чип сайдбара поднимают разные места одновременно: второму «уже гружусь»
  // обязано означать «дождись того же ответа», иначе он уедет работать без базовой линии.
  const first = store.load(true);
  const second = store.load(true);
  assert.equal(calls, 1);

  response.resolve(snapshot({ revision: 5, taskIds: ['11'] }));
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(store.ready, true);
  assert.equal(store.loading, false);
});

test('SEEN-WEB-06: markSeen отмечает задачу и не шлёт уже отмеченное повторно', async () => {
  const store = await fixture();
  store.applySnapshot(snapshot({ revision: 1, taskIds: [] }));
  const sent = [];
  apiHarness.post = async (url, body) => {
    sent.push([url, body]);
    return snapshot({ revision: 2, taskIds: ['42'] });
  };

  assert.equal(await store.markSeen([42]), true);
  assert.deepEqual(sent, [['/api/b24/task-seen', { taskIds: ['42'], baseline: false }]]);
  assert.equal(store.isSeen('42'), true);

  // Открытие уже просмотренной задачи случается постоянно — сеть тут ни при чём.
  assert.equal(await store.markSeen(['42']), true);
  assert.equal(sent.length, 1);
});

test('SEEN-WEB-07: baseline уезжает даже с пустым списком', async () => {
  const store = await fixture();
  const sent = [];
  apiHarness.post = async (url, body) => {
    sent.push(body);
    return snapshot({ revision: 1, initialized: true, taskIds: [] });
  };

  // Пустая доска — тоже базовая линия: без запроса `initialized` не поднялся бы
  // никогда, и первая же появившаяся задача считалась бы «не новой».
  assert.equal(await store.markSeen([], { baseline: true }), true);
  assert.deepEqual(sent, [{ taskIds: [], baseline: true }]);
  assert.equal(store.ready, true);

  // Обычный просмотр пустого списка сетью не занимается.
  assert.equal(await store.markSeen([]), true);
  assert.equal(sent.length, 1);
});

test('SEEN-WEB-08: отказ отметки виден в error и сохраняет прежнее состояние', async () => {
  const store = await fixture();
  store.applySnapshot(snapshot({ revision: 1, taskIds: ['11'] }));
  apiHarness.post = async () => { throw new Error('отметки недоступны'); };

  // Действие возвращает false и НЕ бросает: открытие задачи не должно падать
  // из-за того, что метку не удалось погасить.
  assert.equal(await store.markSeen([42]), false);
  assert.equal(store.isSeen(42), false);
  assert.deepEqual(store.taskIds, ['11']);
  assert.match(store.error, /отметки недоступны/);
  assert.equal(store.marking, false);
});

test('SEEN-WEB-09: поздний ответ старого scope не воскрешает чужие отметки', async () => {
  const store = await fixture();
  store.applySnapshot(snapshot({ revision: 1, taskIds: ['11'] }));
  const oldMark = deferred();
  apiHarness.post = async () => oldMark.promise;
  apiHarness.get = async () => snapshot({ scope: 'scope-b', revision: 0, initialized: false, taskIds: [] });

  const marking = store.markSeen([22]);
  await Promise.resolve();
  assert.equal(await store.load(true), true);
  assert.equal(store.scope, 'scope-b');

  oldMark.resolve(snapshot({ revision: 2, taskIds: ['11', '22'] }));
  assert.equal(await marking, true);
  assert.equal(store.scope, 'scope-b');
  assert.deepEqual(store.taskIds, []);
  assert.equal(store.ready, false);
});

test('SEEN-WEB-10: clear убирает состояние аккаунта и гасит поздние ответы', async () => {
  const store = await fixture();
  store.applySnapshot(snapshot({ revision: 3, taskIds: ['42'] }));
  store.error = 'ошибка';
  const late = deferred();
  apiHarness.post = async () => late.promise;

  const marking = store.markSeen([77]);
  await Promise.resolve();
  store.clear();

  assert.equal(store.scope, '');
  assert.equal(store.revision, -1);
  assert.equal(store.initialized, false);
  assert.equal(store.ready, false);
  assert.deepEqual(store.taskIds, []);
  assert.equal(store.loaded, false);
  assert.equal(store.error, null);

  late.resolve(snapshot({ revision: 4, taskIds: ['42', '77'] }));
  assert.equal(await marking, false);
  assert.deepEqual(store.taskIds, []);
});
