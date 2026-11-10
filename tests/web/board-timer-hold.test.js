import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { api } from '../../web/src/shared/apiClient.ts';
import { useBoardStore } from '../../web/src/stores/board.ts';
import { selectTopbarTimerTasks } from '../../web/src/shared/boardTimerTasks.ts';
import { taskReferenceKey } from '../../shared/tasks/taskReference.ts';

import { controlDriver } from '../server/helpers/trackerMulti.js';
import { flushMulti, webMultiFixture } from './helpers/trackerMulti.js';

process.env.NODE_ENV = 'test';

const RUNNING = {
  timerRunning: true,
  timerStartedAt: 1_800_000_000,
  timerElapsed: 60
};

test('HOLD-01: одиночное пропадание таймера держит признак один цикл', async (t) => {
  const fixture = await webMultiFixture(t);

  await controlDriver(fixture, 'fixture-a', { task: { title: 'С таймером', ...RUNNING } });
  await fixture.board.load(true);

  const running = () => fixture.board.data.tasks
    .filter((row) => row.source === fixture.sourceA && row.timerRunning === true);

  assert.equal(running().length, 1);

  await controlDriver(fixture, 'fixture-a', { task: { title: 'С таймером', timerRunning: false } });
  await fixture.board.load(true);
  assert.equal(running().length, 1);

  await fixture.board.load(true);
  assert.equal(running().length, 0);

  await flushMulti();
});

test('HOLD-SINGLE: одиночный путь удерживает только первый отрицательный ответ', async (t) => {
  setActivePinia(createPinia());

  let running = true;
  const board = useBoardStore();

  t.after(() => board.stopPolling());
  t.mock.method(api, 'get', async (url) => {
    if (url === '/api/trackers') {
      return { externalId: 'fixture', revision: 1 };
    }
    if (url === '/api/tracker/task-seen') {
      return {
        scope: 'fixture',
        revision: 1,
        initialized: true,
        taskIds: []
      };
    }

    return { tasks: [{
      id: 42,
      ...RUNNING,
      timerRunning: running
    }] };
  });

  await board.load(true);
  running = false;
  await board.load(true);
  assert.equal(board.data.tasks[0].timerRunning, true);
  await board.load(true);
  assert.equal(board.data.tasks[0].timerRunning, false);
  running = true;
  await board.load(true);
  running = false;
  await board.load(true);
  assert.equal(board.data.tasks[0].timerRunning, true);
});

test('HOLD-PAUSE: подтверждённая пауза переживает поздний GET и позволяет start', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const posted = Promise.withResolvers();
  let hold = false;
  const fixture = await webMultiFixture(t, {
    afterResponse: async ({ url }) => {
      if (hold && url === '/api/tracker/fixture-a/dashboard') {
        hold = false;
        entered.resolve();
        await release.promise;
      }
    },
  });

  await controlDriver(fixture, 'fixture-a', { task: RUNNING });
  await controlDriver(fixture, 'fixture-b', { task: RUNNING });
  await fixture.board.load(true);

  const post = api.post.bind(api);

  t.mock.method(api, 'post', async (url, ...args) => {
    const result = await post(url, ...args);

    if (url.endsWith('/timer/pause')) {
      await controlDriver(fixture, 'fixture-a', { task: { timerRunning: false } });
      posted.resolve();
    }
    if (url.endsWith('/timer/start')) {
      await controlDriver(fixture, 'fixture-a', { task: RUNNING });
    }

    return result;
  });

  hold = true;

  const reading = fixture.board.load(true);
  let pausing;

  try {
    await Promise.race([entered.promise, reading.then(() => assert.fail('GET должен ожидать'))]);
    pausing = fixture.tasks.timer(42, 'pause', fixture.sourceA);
    await Promise.race([posted.promise, pausing.then(() => assert.fail('refresh должен ожидать'))]);
    await flushMulti();
    release.resolve();
    await Promise.all([reading, pausing]);

    const pausedKey = taskReferenceKey({ id: 42, source: fixture.sourceA });
    const rows = selectTopbarTimerTasks(fixture.board.data, new Set([pausedKey]));
    const paused = rows.find((row) => row.source === fixture.sourceA);

    assert.equal(paused?.timerRunning, false);
    assert.equal(rows.find((row) => row.source === fixture.sourceB)?.timerRunning, true);

    const action = paused.timerRunning ? 'pause' : 'start';

    assert.equal(action, 'start');
    await fixture.tasks.timer(42, action, fixture.sourceA);
    assert.ok(fixture.calls.some((call) => call.method === 'POST'
      && call.url === '/api/tracker/fixture-a/task/42/timer/start'));
    assert.equal(fixture.board.data.tasks.find((row) => row.source === fixture.sourceA).timerRunning, true);
  } finally {
    release.resolve();
    await Promise.allSettled([reading, pausing]);
  }
});

test('HOLD-PAUSE-FAIL: отказ POST не отключает защиту пропуска', async (t) => {
  const fixture = await webMultiFixture(t);

  await controlDriver(fixture, 'fixture-a', { task: RUNNING });
  await fixture.board.load(true);
  t.mock.method(api, 'post', async () => {
    throw new Error('pause denied');
  });
  await assert.rejects(fixture.tasks.timer(42, 'pause', fixture.sourceA), /pause denied/u);
  await controlDriver(fixture, 'fixture-a', { task: { timerRunning: false } });
  await fixture.board.load(true);
  assert.equal(fixture.board.data.tasks.find((row) => row.source === fixture.sourceA).timerRunning, true);
  await fixture.board.load(true);
  assert.equal(fixture.board.data.tasks.find((row) => row.source === fixture.sourceA).timerRunning, false);
});

test('HOLD-02: здоровая B не сбрасывает время отказавшей A, успех снимает ошибку', async (t) => {
  const fixture = await webMultiFixture(t);
  let now = Date.now();

  t.mock.method(Date, 'now', () => now);
  await fixture.board.load(true);
  assert.equal(fixture.board.refreshProblem, '');
  assert.equal(fixture.board.staleSinceMs, 0);

  const successA = fixture.board.branches['fixture-a'].lastOkAt;

  now += 180000;
  await controlDriver(fixture, 'fixture-a', { dashboardError: 'A временно недоступен' });
  await fixture.board.load(true);
  assert.match(fixture.board.refreshProblem, /временно недоступен/u);
  assert.equal(fixture.board.staleSinceMs, successA);
  assert.equal(fixture.board.branches['fixture-b'].lastOkAt, now);
  now += 120000;
  await fixture.board.load(true);
  assert.equal(fixture.board.staleSinceMs, successA);
  assert.equal(fixture.board.lastRefreshAttemptAt - fixture.board.staleSinceMs, 300000);
  await controlDriver(fixture, 'fixture-a', { dashboardError: null });
  await fixture.board.load(true);
  assert.equal(fixture.board.refreshProblem, '');
  assert.equal(fixture.board.staleSinceMs, 0);
});

test('HOLD-CATALOG: общий отказ виден при сохранённом multi-снимке', async (t) => {
  let failures = 0;
  const fixture = await webMultiFixture(t, {
    intercept: ({ url }) => {
      if (url === '/api/trackers' && failures > 0) {
        failures -= 1;

        throw new Error('catalog unavailable');
      }
    },
  });

  await fixture.board.load(true);

  const success = fixture.board.loadedAt;

  failures = 1;
  await fixture.board.load(true);
  assert.equal(fixture.board.data.multiSource, true);
  assert.match(fixture.board.refreshProblem, /catalog unavailable/u);
  assert.equal(fixture.board.staleSinceMs, success);
});

test('HOLD-OFFLINE: каталог без dashboard не выдаётся за восстановление', async (t) => {
  let offline = false;
  const fixture = await webMultiFixture(t, {
    intercept: ({ url }) => {
      if (offline && url === '/api/trackers') {
        throw new Error('server offline');
      }
    },
  });
  let now = Date.now();

  t.mock.method(Date, 'now', () => now);
  await fixture.board.load(true);

  const successA = fixture.board.branches['fixture-a'].lastOkAt;

  now += 60000;
  await controlDriver(fixture, 'fixture-a', { dashboardError: 'A unavailable' });
  await fixture.board.load(true);

  const successB = fixture.board.branches['fixture-b'].lastOkAt;

  assert.equal(successB - successA, 60000);
  offline = true;
  now += 120000;
  await fixture.board.load(true);
  assert.equal(fixture.board.data, null);
  assert.equal(Object.keys(fixture.board.branches).length, 0);
  assert.match(fixture.board.refreshProblem, /server offline/u);
  assert.equal(fixture.board.staleSinceMs, successA);
  now += 120000;
  await fixture.board.load(true);
  assert.equal(fixture.board.staleSinceMs, successA);
  assert.equal(fixture.board.lastRefreshAttemptAt - successA, 300000);
  await controlDriver(fixture, 'fixture-b', { dashboardError: 'B unavailable' });
  offline = false;
  await fixture.board.load(true);
  assert.match(fixture.board.refreshProblem, /unavailable/u);
  assert.equal(fixture.board.staleSinceMs, successA);
  assert.equal(fixture.board.branches['fixture-b'].lastOkAt, successB);
  assert.equal((fixture.board.data?.tasks ?? []).length, 0);
  now += 60000;
  await fixture.board.load(true);
  assert.equal(fixture.board.lastRefreshAttemptAt - fixture.board.staleSinceMs, 360000);
  await controlDriver(fixture, 'fixture-a', { dashboardError: null });
  await fixture.board.load(true);
  assert.match(fixture.board.refreshProblem, /B unavailable/u);
  assert.equal(fixture.board.staleSinceMs, successB);
  assert.deepEqual(fixture.board.data.tasks.map((task) => task.source), [fixture.sourceA]);
  await controlDriver(fixture, 'fixture-b', { dashboardError: null });
  await fixture.board.load(true);
  assert.equal(fixture.board.refreshProblem, '');
  assert.equal(fixture.board.staleSinceMs, 0);
  assert.equal(fixture.board.data.tasks.length, 2);
  fixture.board.clearSource();
  assert.equal(fixture.board.failedSnapshotAt, 0);
  assert.deepEqual(fixture.board.failedBranchTimes, {});
});

test('HOLD-COLD: первая ошибка A видна, успех B не придумывает срок A', async (t) => {
  const fixture = await webMultiFixture(t);

  await controlDriver(fixture, 'fixture-a', { dashboardError: 'A cold failure' });
  await fixture.board.load(true);
  assert.match(fixture.board.refreshProblem, /A cold failure/u);
  assert.equal(fixture.board.staleSinceMs, 0);
  assert.deepEqual(fixture.board.data.tasks.map((task) => task.source), [fixture.sourceB]);
});
