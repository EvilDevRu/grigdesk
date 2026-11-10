import assert from 'node:assert/strict';
import test from 'node:test';

import { boardAllRoleTasks, selectTopbarTimerTasks } from '../../web/src/shared/boardTimerTasks.ts';

process.env.NODE_ENV = 'test';

test('ROLES-01: задачи собираются из всех ролей без повторов', () => {
  const shared = {
    id: 42,
    title: 'Моя и в контроле',
    timerRunning: true
  };
  const result = boardAllRoleTasks({
    multiSource: true,
    tasks: [{
      id: 7,
      title: 'Моя',
      timerRunning: false
    }, shared],
    toReview: [{ ...shared, source: 'a@b' }, { id: 9, title: 'Только контроль' }],
    created: [{
      id: 12,
      title: 'Поставленная',
      timerRunning: true
    }],
    accomplice: [{ id: 7, title: 'Дубль моей' }, { id: 13, timerRunning: true }],
    auditor: [{ id: 14, timerRunning: true }],
  });

  assert.deepEqual(result.map((task) => task.id), [7, 42, 9, 12, 13, 14]);
});

test('ROLES-06: одинаковые номера разных подтверждённых источников не сливаются', () => {
  const sourceA = `fixture-a@${'a'.repeat(64)}`;
  const sourceB = `fixture-b@${'b'.repeat(64)}`;
  const result = boardAllRoleTasks({
    tasks: [{
      id: 42,
      source: sourceA,
      timerRunning: true
    }],
    toReview: [{
      id: 42,
      source: sourceB,
      timerRunning: true
    }],
  });

  assert.deepEqual(result.map((task) => task.source), [sourceA, sourceB]);
});

test('ROLES-02: пустой и отсутствующий снимок дают пустой список', () => {
  assert.deepEqual(boardAllRoleTasks(null), []);
  assert.deepEqual(boardAllRoleTasks(undefined), []);
  assert.deepEqual(boardAllRoleTasks({ multiSource: true }), []);
});

test('ROLES-03: топбар берёт идущий таймер из контроля', () => {
  const result = selectTopbarTimerTasks({
    multiSource: true,
    tasks: [{
      id: 7,
      title: 'Моя',
      timerRunning: false
    }],
    toReview: [{
      id: 44,
      title: 'Контроль',
      timerRunning: true,
      timerElapsed: 4
    }],
    created: [],
  }, new Set());

  assert.deepEqual(result.map((task) => task.id), [44]);
});

test('ROLES-04: пауза из окна удерживает остановленную строку', () => {
  const result = selectTopbarTimerTasks({
    multiSource: true,
    tasks: [{
      id: 7,
      title: 'Моя',
      timerRunning: false
    }],
  }, new Set(['[null,"7"]']));

  assert.deepEqual(result.map((task) => task.id), [7]);
});

test('ROLES-05: без пауз остановленные строки не попадают в топбар', () => {
  const result = selectTopbarTimerTasks({
    multiSource: true,
    tasks: [{
      id: 7,
      title: 'Моя',
      timerRunning: false
    }],
  }, new Set());

  assert.deepEqual(result, []);
});
