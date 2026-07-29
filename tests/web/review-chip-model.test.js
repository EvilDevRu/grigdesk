import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reviewChipModel,
  reviewPullTone,
  summarizeReviews,
} from '../../web/src/shared/review-chip.js';

function pull(id, attention, remarks = []) {
  return {
    id,
    projectId: id.split(':')[0],
    repoKey: 'app',
    number: Number(id.split(':')[1]),
    state: 'open',
    attention,
    remarks,
  };
}

test('UI-02: чип считает разные PR, а не замечания', () => {
  const fiveRemarks = Array.from({ length: 5 }, (_, index) => ({
    id: `r-${index}`,
    body: `Комментарий ${index}`,
  }));
  const summary = summarizeReviews([
    pull('alpha:10', { unread: true }, fiveRemarks),
    // Повтор той же строки из склеенного серверного снимка не должен увеличить число.
    pull('alpha:10', { unread: true }, fiveRemarks),
    pull('beta:20', { unread: true }, [{ id: 'other' }]),
  ]);

  assert.equal(summary.count, 2);
  assert.equal(summary.tone, 'blue');
});

test('UI-03: красный важнее жёлтого, а жёлтый важнее синего', () => {
  const combinations = [
    { pulls: [pull('p:1', 'blue')], tone: 'blue', kind: '' },
    { pulls: [pull('p:1', 'blue'), pull('p:2', 'yellow')], tone: 'yellow', kind: 'wait' },
    { pulls: [pull('p:1', 'red'), pull('p:2', 'yellow')], tone: 'red', kind: 'stall' },
    { pulls: [pull('p:1', 'blue'), pull('p:1', 'red')], tone: 'red', kind: 'stall' },
  ];

  for (const row of combinations) {
    const summary = summarizeReviews(row.pulls);
    assert.equal(summary.tone, row.tone);
    assert.equal(reviewChipModel(summary).kind, row.kind);
  }
});

test('UI-04: прочтение снимает только синее внимание', () => {
  assert.equal(reviewPullTone(pull('p:1', { unread: true })), 'blue');
  assert.equal(reviewPullTone(pull('p:1', { unread: false })), '');
  assert.equal(reviewPullTone(pull('p:1', { unread: false, needsDecision: true })), 'yellow');
  assert.equal(reviewPullTone(pull('p:1', { unread: false, needsAnalysis: true })), 'yellow');
  assert.equal(reviewPullTone(pull('p:1', { unread: false, failed: true })), 'red');
});

test('UI-05: закрытый PR не возвращается в чип из-за позднего анализа', () => {
  const closed = {
    ...pull('p:1', { unread: true, failed: true }),
    state: 'closed',
    remarks: [{ id: 'r', analysisStatus: 'failed' }],
  };
  assert.equal(reviewPullTone(closed), '');
  assert.equal(summarizeReviews([closed]).count, 0);
});

test('серверная сводка ограничивает подпись, сохраняя полное число и цвет', () => {
  const chip = reviewChipModel({
    count: 123,
    tone: 'yellow',
    title: '123 PR ждут решения',
    version: 17,
  });
  assert.deepEqual(chip, {
    count: 123,
    tone: 'yellow',
    title: '123 PR ждут решения',
    version: 17,
    visible: true,
    label: '99+',
    kind: 'wait',
  });
});
