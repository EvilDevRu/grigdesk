import assert from 'node:assert/strict';
import test from 'node:test';

import { stabilizeTimerRoles } from '../../web/src/shared/timerStability.ts';

process.env.NODE_ENV = 'test';

const running = (id) => ({
  id,
  title: `Задача ${id}`,
  timerRunning: true,
  timerElapsed: 1
});
const stopped = (id) => ({
  id,
  title: `Задача ${id}`,
  timerRunning: false,
  timerElapsed: 1
});

test('HOLD-U1: без предыдущего снимка роли проходят без удержания', () => {
  const result = stabilizeTimerRoles(null, { tasks: [running(1)] }, new Set());

  assert.equal(result.roles.tasks[0].timerRunning, true);
  assert.equal(result.held.size, 0);
});

test('HOLD-U2: первый ответ без таймера подменяет копию прежней роли', () => {
  const result = stabilizeTimerRoles({ tasks: [running(7)] }, { tasks: [stopped(7)] }, new Set());

  assert.equal(result.roles.tasks[0].timerRunning, true);
  assert.equal(result.roles.tasks[0].timerElapsed, 1);
  assert.deepEqual([...result.held], ['[null,"7"]']);
});

test('HOLD-U3: второй ответ подряд без таймера снимает признак', () => {
  const first = stabilizeTimerRoles({ tasks: [running(7)] }, { tasks: [stopped(7)] }, new Set());
  const second = stabilizeTimerRoles(
    { tasks: first.roles.tasks }, { tasks: [stopped(7)] }, first.held,
  );

  assert.equal(second.roles.tasks[0].timerRunning, false);
  assert.equal(second.held.size, 0);
});

test('HOLD-U4: возврат таймера снимает удержание', () => {
  const first = stabilizeTimerRoles({ tasks: [running(7)] }, { tasks: [stopped(7)] }, new Set());
  const second = stabilizeTimerRoles(
    { tasks: first.roles.tasks }, { tasks: [running(7)] }, first.held,
  );

  assert.equal(second.roles.tasks[0].timerRunning, true);
  assert.equal(second.held.size, 0);
});

test('HOLD-U5: исчезнувшая задача удерживается один цикл, потом убирается', () => {
  const first = stabilizeTimerRoles({ tasks: [running(7)] }, { tasks: [] }, new Set());

  assert.equal(first.roles.tasks.length, 1);
  assert.equal(first.held.size, 1);

  const second = stabilizeTimerRoles({ tasks: first.roles.tasks }, { tasks: [] }, first.held);

  assert.equal(second.roles.tasks.length, 0);
  assert.equal(second.held.size, 0);
});

test('HOLD-U6: остановленная в прежнем снимке задача не удерживается', () => {
  const result = stabilizeTimerRoles({ tasks: [stopped(7)] }, { tasks: [] }, new Set());

  assert.equal(result.roles.tasks.length, 0);
  assert.equal(result.held.size, 0);
});

test('HOLD-U7: повторное применение не дублирует строку задачи', () => {
  const first = stabilizeTimerRoles({ tasks: [running(7)] }, { tasks: [stopped(7)] }, new Set());
  const again = stabilizeTimerRoles(
    { tasks: first.roles.tasks }, { tasks: [stopped(7)] }, first.held,
  );

  assert.equal(again.roles.tasks.length, 1);
  assert.equal(again.roles.tasks[0].timerRunning, false);
  assert.equal(again.held.size, 0);
});

test('HOLD-U8: смена роли сохраняет свежие поля и даёт ровно один цикл', () => {
  const fresh = {
    ...stopped(7),
    title: 'Новое имя',
    status: 4
  };
  const first = stabilizeTimerRoles({ tasks: [running(7)] }, { toReview: [fresh] }, new Set());

  assert.equal(first.roles.tasks.length, 0);
  assert.equal(first.roles.toReview[0].timerRunning, true);
  assert.equal(first.roles.toReview[0].title, 'Новое имя');
  assert.equal(first.roles.toReview[0].status, 4);

  const second = stabilizeTimerRoles(first.roles, { toReview: [fresh] }, first.held);

  assert.equal(second.roles.toReview[0].timerRunning, false);

  const recovered = stabilizeTimerRoles(second.roles, { auditor: [running(7)] }, second.held);
  const nextGap = stabilizeTimerRoles(recovered.roles, { auditor: [stopped(7)] }, recovered.held);

  assert.equal(nextGap.roles.auditor[0].timerRunning, true);
});
