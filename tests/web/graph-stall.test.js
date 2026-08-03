import assert from 'node:assert/strict';
import test from 'node:test';

import { graphStallView } from '../../web/src/shared/graph-stall.js';

test('graph stall presentation keeps the affected node, explicit reason and recovery hint visible', () => {
  const view = graphStallView({
    nodes: { review: ['agent', '🤖 Ревью', ''] },
    stall: {
      node: 'review',
      stage: 'REVIEW',
      title: 'REVIEW: агент трижды не отчитался о результате',
      hint: 'Проверь лимиты и доступность инструментов.',
      fails: 113,
    },
  });

  assert.deepEqual(view, {
    node: 'review',
    stage: 'REVIEW',
    nodeLabel: 'Ревью',
    title: 'REVIEW: агент трижды не отчитался о результате',
    hint: 'Проверь лимиты и доступность инструментов.',
    fails: 113,
  });
});

test('healthy graph has no stall presentation', () => {
  assert.equal(graphStallView({ stall: null }), null);
});
