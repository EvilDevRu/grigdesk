import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { api } from '../../web/src/shared/apiClient.ts';
import { useBoardStore } from '../../web/src/stores/board.ts';
import { useTasksStore } from '../../web/src/stores/tasks.ts';

test('BM-01: окно карточки просит снимок, а после своего действия читает доску само', async (t) => {
  let dashboards = 0;
  let asked = 0;

  setActivePinia(createPinia());
  t.mock.method(api, 'get', async (path) => {
    if (path === '/api/b24/task-seen') {
      return {
        scope: 'fixture',
        revision: 1,
        initialized: true,
        taskIds: [],
      };
    }

    if (path === '/api/b24/dashboard') {
      dashboards += 1;
    }

    return { tasks: [] };
  });

  const board = useBoardStore();

  board.setMirror(() => {
    asked += 1;
  });
  await board.load();
  assert.equal(dashboards, 0);
  assert.equal(asked, 1);
  board.applySnapshot({ tasks: [{ id: 42, timerRunning: true }] }, 2000);
  assert.equal(board.data.tasks[0].timerRunning, true);
  assert.equal(board.readAt, 2000);
  assert.equal(board.loadedAt > 0, true);
  board.applySnapshot({ tasks: [{ id: 42, timerRunning: false }] }, 1000);
  board.applySnapshot(null, 3000);
  board.applySnapshot([1], 3000);
  board.applySnapshot({ tasks: [] }, 'вчера');
  board.applySnapshot({ tasks: [] }, Number.POSITIVE_INFINITY);
  board.applySnapshot({ tasks: [] }, Number.NaN);
  assert.equal(board.data.tasks[0].timerRunning, true);
  await board.load(true);
  assert.equal(dashboards, 1);
  assert.equal(asked, 1);
  assert.equal(board.readAt > 2000, true);
  board.setMirror(null);
  board.loadedAt = 0;
  await board.load();
  assert.equal(dashboards, 2);
});

test('BM-02: своё действие во время ожидания снимка делает свой GET', { timeout: 5000 }, async (t) => {
  setActivePinia(createPinia());

  const board = useBoardStore();
  let dashboards = 0;

  t.mock.method(api, 'post', async (path) => {
    assert.equal(path, '/api/b24/task/42/timer/start');

    return {};
  });
  t.mock.method(api, 'get', async (path) => {
    if (path === '/api/b24/task-seen') {
      return {
        scope: 'fixture',
        revision: 1,
        initialized: true,
        taskIds: [],
      };
    }

    assert.equal(path, '/api/b24/dashboard');
    dashboards += 1;

    return { tasks: [{ id: 42, timerRunning: true }] };
  });
  board.setMirror(() => {});
  t.after(() => board.setMirror(null));
  void board.load();
  await useTasksStore().timer('42', 'start');
  assert.equal(dashboards, 1);
  assert.equal(board.data.tasks[0].timerRunning, true);
});
