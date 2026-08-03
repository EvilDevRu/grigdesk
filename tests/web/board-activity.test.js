import assert from 'node:assert/strict';
import test from 'node:test';

import { boardActivity, boardTaskIds } from '../../web/src/shared/board-activity.js';

test('чип доски считает только задачи с живым таймером, а не все начатые', () => {
  const dashboard = {
    activeTimer: { task_id: 11 },
    tasks: [
      { id: 11, status: 3, statusKind: 'running', timerRunning: true },
      { id: 12, status: 3, statusKind: 'in_progress', timerRunning: false },
      { id: 13, status: 2, statusKind: 'todo', timerRunning: false },
    ],
  };

  assert.deepEqual(boardActivity(dashboard, ['11']), {
    activeTimerCount: 1,
    unseenCount: 2,
    unseenTaskIds: ['12', '13'],
  });
});

test('оставшийся activeTimer не выдаёт остановленный таймер за активный', () => {
  const dashboard = {
    activeTimer: { task_id: 21 },
    tasks: [
      { id: 21, status: 3, statusKind: 'in_progress', timerRunning: false },
      { id: 22, status: 2, statusKind: 'todo', timerRunning: false },
    ],
  };

  const ids = boardTaskIds(dashboard.tasks);
  assert.deepEqual(ids, ['21', '22']);
  assert.deepEqual(boardActivity(dashboard, ids), {
    activeTimerCount: 0,
    unseenCount: 0,
    unseenTaskIds: [],
  });
});
