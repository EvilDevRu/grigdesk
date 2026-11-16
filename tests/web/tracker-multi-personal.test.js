import assert from 'node:assert/strict';
import test from 'node:test';

import { useTaskFavoritesStore } from '../../web/src/stores/taskFavorites.ts';
import { useTaskSeenStore } from '../../web/src/stores/taskSeen.ts';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { flushMulti, webMultiFixture } from './helpers/trackerMulti.js';
import { shelfInput } from '../server/helpers/trackerMulti.js';

const apiFile = JSON.stringify(webFile('src/shared/apiClient.ts'));
const shelfModule = await compileModule(webFile('src/stores/taskShelf.ts'), {
  stubs: {
    '../shared/apiClient.ts': `export { api, ApiError } from ${apiFile};`,
    './apiClient.ts': `export { api, ApiError } from ${apiFile};`,
    '../shared/grigdeskPersonalState.ts': `export const grigdeskPersonalStateVersion = {
      get value() { return globalThis.__multiShelfPersonalState.value; },
    };`,
    './board.ts': 'export const useBoardStore = () => globalThis.__multiShelfBoard;',
    './plugins.ts': `export const usePluginsStore = () => ({
      loaded: true, enabled: () => true, byId: () => ({ values: {} }),
    });`,
    './analysis.ts': 'export const useAnalysisStore = () => ({ loadedAt: 0, byTask: {} });',
    './notifyWatch.ts': 'export const useNotifyWatchStore = () => ({ loadedAt: 0 });',
    '../shared/alerts.ts': `export const alertUser = (value) => {
      globalThis.__multiShelfAlerts.push(value);
      return true;
    };`,
    '../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
  },
});

/**
 * Ветка запрашивается через планируемую публичную границу, не через внутренний state.
 * На базе отсутствие изоляции даёт assertion RED, а не ошибку загрузки модуля.
 */
function branch(store, source) {
  assert.equal(typeof store.forSource, 'function', 'Нужны независимые личные ветки каждого source');

  return store.forSource(source);
}

/**
 * Полка использует настоящие Pinia и HTTP; подменены только источники оповещений.
 * Пассивный режим проверяется отдельно от активной гидратации и записи acknowledge.
 */
async function personalFixture(t, options) {
  const fixture = await webMultiFixture(t, options);

  await fixture.trackers.load(true);

  globalThis.__multiShelfBoard = fixture.board;
  globalThis.__multiShelfPersonalState = { value: 0 };
  globalThis.__multiShelfAlerts = [];
  t.after(() => {
    delete globalThis.__multiShelfBoard;
    delete globalThis.__multiShelfPersonalState;
    delete globalThis.__multiShelfAlerts;
  });

  const favorites = useTaskFavoritesStore();
  const seen = useTaskSeenStore();
  const shelf = shelfModule.useTaskShelfStore();

  t.after(() => shelf.stop());

  return {
    ...fixture,
    favorites,
    seen,
    shelf,
  };
}

test('MD-BRANCHES: звезда, seen и полка A42 не меняют B42', async (t) => {
  const fixture = await personalFixture(t);
  const a = branch(fixture.favorites, fixture.sourceA);
  const b = branch(fixture.favorites, fixture.sourceB);
  const seenA = branch(fixture.seen, fixture.sourceA);
  const seenB = branch(fixture.seen, fixture.sourceB);
  const shelfA = branch(fixture.shelf, fixture.sourceA);
  const shelfB = branch(fixture.shelf, fixture.sourceB);

  // Пустая baseline обоих аккаунтов подтверждена до загрузки задач.
  // Поэтому A42 и B42 начинают непросмотренными, без автоматического гашения новизны.
  await Promise.all([seenA.load(), seenB.load()]);
  assert.equal(await seenA.markSeen([], { baseline: true }), true);
  assert.equal(await seenB.markSeen([], { baseline: true }), true);
  assert.equal(seenA.initialized, true);
  assert.equal(seenB.initialized, true);

  await fixture.board.load(true);
  await Promise.all([a.load(), b.load(), seenA.load(), seenB.load(), shelfA.load(), shelfB.load()]);
  assert.equal(seenA.isSeen('42'), false);
  assert.equal(seenB.isSeen('42'), false);
  assert.equal(await a.setFavorite('42', true), true);
  assert.equal(a.isFavorite('42'), true);
  assert.equal(b.isFavorite('42'), false);
  assert.equal(await seenA.markSeen(['42']), true);
  assert.equal(seenA.isSeen('42'), true);
  assert.equal(seenB.isSeen('42'), false);

  for (const id of ['fixture-a', 'fixture-b']) {
    assert.equal((await fixture.request('PUT', `/api/tracker/${id}/task-shelf/42`, shelfInput(id)))
      .statusCode, 200);
  }

  await shelfA.load(true);
  await shelfB.load(true);
  await flushMulti();
  shelfA.reconcile();
  shelfB.reconcile();
  fixture.shelf.reconcile();
  assert.deepEqual(fixture.shelf.allRows.map((row) => row.taskSource).sort(),
    [fixture.sourceA, fixture.sourceB].sort());
});

test('MD-BASELINE: первый успешный A не инициализирует B', async (t) => {
  const fixture = await personalFixture(t);
  const a = branch(fixture.seen, fixture.sourceA);
  const b = branch(fixture.seen, fixture.sourceB);

  await a.load();
  await b.load();
  await a.markSeen(['42'], { baseline: true });
  assert.equal(a.initialized, true);
  assert.equal(b.initialized, false);
  assert.deepEqual(b.taskIds, []);
});

test('MD-PERSONAL-LATE: старый ответ A не восстанавливает метки, B сохраняется', async (t) => {
  let held = false;
  const release = Promise.withResolvers();
  const fixture = await personalFixture(t, {
    intercept: async ({ url }) => {
      if (held && url === '/api/tracker/fixture-a/task-favorites') {
        await release.promise;
      }
    },
  });
  const a = branch(fixture.favorites, fixture.sourceA);
  const b = branch(fixture.favorites, fixture.sourceB);

  await a.load();
  await b.load();
  await a.setFavorite('42', true);
  await b.setFavorite('42', true);
  held = true;

  const reading = a.load(true);

  try {
    await flushMulti();
    a.clear();
    assert.equal(b.isFavorite('42'), true);
  } finally {
    release.resolve();
    await reading;
  }

  assert.equal(a.isFavorite('42'), false);
  assert.equal(b.isFavorite('42'), true);
});

test('MD-SHELF-REF: пассивное окно сохраняет пару, не гидратирует и не оповещает', async (t) => {
  const fixture = await personalFixture(t);
  const a = branch(fixture.shelf, fixture.sourceA);
  const b = branch(fixture.shelf, fixture.sourceB);

  fixture.shelf.setViewMirror(true);
  fixture.shelf.setPassive(true);
  fixture.calls.length = 0;
  fixture.shelf.applyViewSnapshot({
    scope: 'view',
    revision: 1,
    entries: [],
    rows: [fixture.sourceA, fixture.sourceB].map((taskSource) => ({
      taskId: '42',
      taskSource,
      title: taskSource,
      state: 'idle',
    })),
    sourceIssues: [],
    loaded: true,
    error: null,
  });
  await fixture.shelf.load(true);
  await flushMulti();
  assert.equal(a !== b, true);
  assert.deepEqual(fixture.shelf.allRows.map((row) => [row.taskSource, row.taskId]),
    [[fixture.sourceA, '42'], [fixture.sourceB, '42']]);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(globalThis.__multiShelfAlerts, []);
});

test('MD-SHELF-REF: активная гидратация и оповещение A не используют B42', async (t) => {
  const fixture = await personalFixture(t);
  const a = branch(fixture.shelf, fixture.sourceA);
  const b = branch(fixture.shelf, fixture.sourceB);

  await fixture.board.load(true);
  await a.load();
  await b.load();

  for (const task of fixture.board.data.tasks) {
    task.unread = 0;
  }

  assert.equal(await a.toggle('42'), true);
  assert.equal(await b.toggle('42'), true);
  await flushMulti();
  assert.ok(fixture.calls.some((call) => call.url === '/api/tracker/fixture-a/task/42'));
  assert.ok(fixture.calls.some((call) => call.url === '/api/tracker/fixture-b/task/42'));
  globalThis.__multiShelfAlerts.length = 0;

  const task = fixture.board.data.tasks.find((item) => item.source === fixture.sourceA);

  task.unread = 2;
  a.reconcile();
  b.reconcile();

  const alerts = globalThis.__multiShelfAlerts;

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].target.source, fixture.sourceA);
  assert.equal(String(alerts[0].target.taskId ?? alerts[0].target.id), '42');
  assert.equal(b.rows.some((row) => row.state === 'lit'), false);
  assert.equal(await a.acknowledge('42'), true);
  assert.equal(b.entries.length, 1);
  assert.equal(fixture.calls.filter((call) => call.method === 'PUT').at(-1).url,
    '/api/tracker/fixture-a/task-shelf/42');
});
