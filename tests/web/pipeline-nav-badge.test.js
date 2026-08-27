import assert from 'node:assert/strict';
import test from 'node:test';

import { pipelineBadgeSummary } from '../../web/src/shared/pipeline-nav-badge.js';

test('сводка даёт топбару числа всего / едут / стоят без повторного счёта задач', () => {
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
    [summary.totalCount, summary.runningCount, summary.attentionCount],
    [8, 3, 5],
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
