import assert from 'node:assert/strict';
import test from 'node:test';

import { mountBoardView } from './helpers/board-view.js';

process.env.NODE_ENV = 'test';

test('BOARD-TIMERS-01: блок таймеров показывает все идущие задачи', async (t) => {
  const { wrapper, calls } = await mountBoardView(t, {
    prefix: 'board-active-timers',
    tasks: [
      { id: 11, title: 'Первый таймер', timerRunning: true, timerElapsed: 11 },
      { id: 22, title: 'Задача без таймера', timerRunning: false, timerElapsed: 22 },
      { id: 33, title: 'Второй таймер', timerRunning: true, timerElapsed: 33 },
      { id: 44, title: 'Третий таймер', timerRunning: true, timerElapsed: 44 },
      { id: 55, title: 'Четвёртый таймер', timerRunning: true, timerElapsed: 55 },
    ],
  });

  const cards = wrapper.findAll('[data-context="active-timer-card"]');
  assert.equal(cards.length, 4);
  assert.equal(wrapper.get('.active-timers-count').text(), '4');
  assert.deepEqual(cards.map((card) => card.get('.active-task-title').text()), [
    'Первый таймер',
    'Второй таймер',
    'Третий таймер',
    'Четвёртый таймер',
  ]);
  assert.deepEqual(
    cards.map((card) => card.get('.active-timer-time').text()),
    ['11', '33', '44', '55'],
  );

  await cards[2].trigger('click');
  assert.deepEqual(calls.opened, ['44']);
});

test('BOARD-TIMERS-02: пустой блок таймеров не занимает место', async (t) => {
  const { wrapper } = await mountBoardView(t, {
    prefix: 'board-no-active-timers',
    tasks: [
      { id: 11, title: 'Остановленная задача', timerRunning: false, timerElapsed: 11 },
    ],
  });

  assert.equal(wrapper.find('.active-timers').exists(), false);
});

test('BOARD-TIMERS-04: идущий таймер из контроля виден в блоке активных', async (t) => {
  const { wrapper } = await mountBoardView(t, {
    prefix: 'board-active-timers-review',
    tasks: [
      {
        id: 11,
        title: 'Задача без таймера',
        timerRunning: false,
        timerElapsed: 5
      },
    ],
    toReview: [
      {
        id: 44,
        title: 'Таймер из контроля',
        timerRunning: true,
        timerElapsed: 44
      },
    ],
  });

  const cards = wrapper.findAll('[data-context="active-timer-card"]');

  assert.equal(cards.length, 1);
  assert.equal(wrapper.get('.active-timers-count').text(), '1');
  assert.equal(cards[0].get('.active-task-title').text(), 'Таймер из контроля');
});
