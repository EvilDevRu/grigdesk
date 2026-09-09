import assert from 'node:assert/strict';
import test from 'node:test';

import { waitingReason } from '../../shared/pipelineWait.ts';

test('waiting reason prefers a route-specific gate meaning', () => {
  const base = {
    pos: { gate_accept: [0, 0] },
    statuses: { gate_accept: 'wait' },
    nodes: { gate_accept: ['human', '✅ Приёмка', ''] },
  };

  assert.deepEqual(waitingReason({ ...base, route: 'hunt' }), {
    node: 'gate_accept',
    text: 'принять находки и покрытие',
    premature: false,
  });
  assert.deepEqual(waitingReason({ ...base, route: 'feature' }), {
    node: 'gate_accept',
    text: 'принять работу — проверить в браузере',
    premature: false,
  });
});

test('waiting reason keeps fallback labels and premature state', () => {
  const graph = {
    route: 'future',
    pos: { gate_custom: [0, 0] },
    statuses: { gate_custom: 'premature' },
    nodes: { gate_custom: ['human', '🧭 Выбрать направление', ''] },
  };

  assert.deepEqual(waitingReason(graph), {
    node: 'gate_custom',
    text: 'Выбрать направление',
    premature: true,
  });
});
