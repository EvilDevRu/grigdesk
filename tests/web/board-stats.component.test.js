import assert from 'node:assert/strict';
import test from 'node:test';

import { mountBoardView } from './helpers/board-view.js';

process.env.NODE_ENV = 'test';

test('плитка месяца показывает число выполненных задач рядом с учётом времени', async (t) => {
  const { wrapper } = await mountBoardView(t, {
    prefix: 'board-month-completed',
    snapshot: {
      trackerId: 'grigdesk-b24-discript',
      widgets: [{
        id: 'month',
        kind: 'kpi',
        title: { text: 'За месяц' },
        items: [{
          id: 'month-completed',
          label: { text: 'выполнено задач' },
          value: 17,
          format: 'count',
        }],
      }],
    },
    month: { hours: 82.5, norm: 160, completedTasks: 17 },
  });

  const completed = wrapper.get('[data-stat="month-completed"]');

  assert.equal(completed.get('strong').text(), '17');
  assert.match(completed.text(), /выполнено задач/u);
  assert.equal(completed.attributes('aria-label'), 'Выполнено задач за месяц: 17');
});
