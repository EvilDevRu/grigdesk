import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pipelineBadgeSummary,
  pipelineTopbarItems,
} from '../../web/src/shared/pipeline-nav-badge.js';

test('сводка даёт топбару взаимоисключающие числа работы / ожидания / проблем', () => {
  const summary = pipelineBadgeSummary({
    stalled: [{ task: '1' }],
    waiting: [{ task: '2' }, { task: '3' }, { task: '4' }, { task: '5' }],
    running: [{ task: '6' }, { task: '7' }, { task: '8' }],
  });

  assert.deepEqual(summary, {
    errorCount: 1,
    waitingCount: 4,
    runningCount: 3,
    attentionCount: 5,
    totalCount: 8,
    errorEnd: 12.5,
    waitingEnd: 62.5,
  });
  assert.deepEqual(
    [summary.runningCount, summary.waitingCount, summary.errorCount],
    [3, 4, 1],
  );
});

test('авария и ворота имеют приоритет над синим сектором и не дублируют задачу', () => {
  const summary = pipelineBadgeSummary({
    stalled: [{ task: 1 }],
    silent: [{ task: '2' }],
    waiting: [{ task: '1' }, { task: '3' }],
    running: [{ task: '1' }, { task: '2' }, { task: '3' }, { task: '4' }],
  });

  assert.equal(summary.errorCount, 2);
  assert.equal(summary.waitingCount, 1);
  assert.equal(summary.runningCount, 1);
  assert.equal(summary.attentionCount, 3);
  assert.equal(summary.totalCount, 4);
});

test('пустая сводка не создаёт некорректные проценты', () => {
  assert.deepEqual(pipelineBadgeSummary(), {
    errorCount: 0,
    waitingCount: 0,
    runningCount: 0,
    attentionCount: 0,
    totalCount: 0,
    errorEnd: 0,
    waitingEnd: 0,
  });
});

test('проекция топбара дедуплицирует задачи с тем же приоритетом, что и сводка', () => {
  const state = {
    stalled: [{ task: '1', taskTitle: 'Авария', title: 'Оборвался демон' }],
    silent: [{ task: '2', taskTitle: 'Молчащий ход', text: 'Нет событий 20 минут' }],
    waiting: [
      { task: '1', taskTitle: 'Авария', text: 'Ждёт ворота' },
      { task: '3', taskTitle: 'План', text: 'Принять план' },
    ],
    running: [
      { task: '1', taskTitle: 'Авария' },
      { task: '2', taskTitle: 'Молчащий ход' },
      { task: '3', taskTitle: 'План' },
      { task: '4', taskTitle: 'Работа' },
    ],
    observedByTask: {
      1: { progress: { done: 2, total: 7 }, stage: { label: 'Проверка' } },
      2: { progress: { done: 3, total: 7 }, stage: { label: 'Ревью' } },
      3: { progress: { done: 1, total: 7 }, stage: { label: 'Ворота плана' } },
      4: { progress: { done: 5, total: 7 }, stage: { label: 'Браузер' } },
    },
  };

  const items = pipelineTopbarItems(state);

  assert.deepEqual(items.map((item) => item.task), ['1', '2', '3', '4']);
  assert.deepEqual(items.map((item) => item.kind), ['error', 'error', 'waiting', 'running']);
  assert.deepEqual(items.map((item) => item.stateLabel), [
    'Встал',
    'Молчит',
    'Ждёт решения',
    'В работе',
  ]);
  assert.equal(items[0].detail, 'Оборвался демон');
  assert.equal(items[3].stage, 'Браузер');
  assert.deepEqual(items[3].progress, { done: 5, total: 7 });
  assert.equal(items.length, pipelineBadgeSummary(state).totalCount);
});
