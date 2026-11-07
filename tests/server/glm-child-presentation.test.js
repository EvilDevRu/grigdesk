import assert from 'node:assert/strict';
import test from 'node:test';

import { createGlmChildPresentation } from '../../server/src/lib/glm/childPresentation.ts';

test('child presentation: retry в том же step сохраняет prefix и итог без дублей live/replay', () => {
  const steps = [];
  const usage = [];
  const presentation = createGlmChildPresentation({
    id: (turn, id) => `${turn}:${id}`,
    emit: (step) => steps.push(step),
    usage: (value) => usage.push(value),
  });
  const stream = [{
    type: 'text-chunks',
    index: 0,
    texts: ['оборвано'],
  }];

  presentation.frame({
    type: 'start',
    attemptId: 'first',
    turn: 1,
    step: 0,
  });
  presentation.frame({
    type: 'chunk',
    attemptId: 'first',
    index: 0,
    chunk: {
      type: 'text-delta',
      index: 0,
      text: 'оборвано',
    },
  });
  presentation.message({
    turn: 1,
    step: 0,
    stream,
    usage: { outputTokens: 3 },
  });
  presentation.frame({ type: 'end', attemptId: 'first' });
  presentation.frame({
    type: 'start',
    attemptId: 'retry',
    turn: 1,
    step: 0,
  });
  presentation.frame({
    type: 'chunk',
    attemptId: 'retry',
    index: 0,
    chunk: {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'готово' },
    },
  });
  presentation.message({
    turn: 1,
    step: 0,
    message: { content: [{ type: 'text', text: 'готово' }] },
    usage: { outputTokens: 5 },
  });
  presentation.frame({ type: 'end', attemptId: 'retry' });
  assert.deepEqual(steps.map((step) => step.text), ['оборвано', 'готово']);
  assert.equal(new Set(steps.map((step) => step.id)).size, 2);
  assert.deepEqual(usage, [3, 5]);

  const replay = [];
  const restored = createGlmChildPresentation({
    id: (turn, id) => `${turn}:${id}`,
    emit: (step) => replay.push(step),
    usage: () => {},
  });

  restored.message({
    turn: 1,
    step: 0,
    stream,
  });
  restored.message({
    turn: 1,
    step: 0,
    message: { content: [{ type: 'text', text: 'готово' }] },
  });
  assert.deepEqual(replay, steps);
});
