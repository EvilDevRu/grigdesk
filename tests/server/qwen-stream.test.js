import assert from 'node:assert/strict';
import test from 'node:test';

import { createQwenTextSteps } from '../../server/src/lib/qwen/steps.ts';
import { STEP_TEXT_LIMIT, STEP_THINK_LIMIT } from '../../server/src/lib/chat/streamSteps.ts';
import { qwenAdapter, qwenFixture, rejectedTurn, runInput } from '../helpers/qwenFixture.mjs';

const chunk = (kind, text) => ({ sessionUpdate: kind, content: { type: 'text', text } });

test('Qwen: дельты собираются в смысловые блоки в живой и сохранённой ленте', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const stream = [
    ...['Один', ' цельный', '\nблок', ' размышления.'].map((text) => chunk('agent_thought_chunk', text)),
    chunk('agent_message_chunk', ''),
    { sessionUpdate: 'usage_update' },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'read-1',
      title: 'Read',
      rawInput: {},
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read-1',
      status: 'completed',
      content: [],
    },
    chunk('agent_thought_chunk', 'Второй блок.'),
    ...['Полный', ' ответ.'].map((text) => chunk('agent_message_chunk', text)),
  ];

  await fixture.fake({ stream });

  const live = [];
  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    onStep: (step) => live.push(step),
  }));

  assert.equal(result.reply, 'Полный ответ.');
  assert.deepEqual(live, result.steps);
  assert.deepEqual(live.map((step) => step.k), ['start', 'think', 'tool', 'res', 'think', 'text']);
  assert.deepEqual(live.filter((step) => step.k === 'think').map((step) => step.text), [
    'Один цельный\nблок размышления.', 'Второй блок.',
  ]);
  assert.equal(live.at(-1).text, 'Полный ответ.');
  assert.ok(live.filter((step) => ['think', 'text'].includes(step.k)).every((step) => step.id));
});

test('Qwen: ошибка потока выпускает накопленный хвост ровно один раз', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });

  await fixture.fake({
    stream: [chunk('agent_thought_chunk', 'Сохранённый '), chunk('agent_thought_chunk', 'хвост.')],
    streamError: true,
  });

  const live = [];
  const reason = await rejectedTurn(() => adapter.run(runInput(fixture, 'shared-model(openai)', {
    onStep: (step) => live.push(step),
  })));

  assert.match(reason, /synthetic stream failure/);

  const thoughts = live.filter((step) => step.k === 'think').map((step) => step.text);

  assert.deepEqual(thoughts, ['Сохранённый хвост.']);
});

test('Qwen: пустые chunks, время первой дельты, лимит памяти и отдельные id блоков', () => {
  let time = 10;
  const steps = createQwenTextSteps(() => time++);

  assert.deepEqual(steps.append('think', ''), []);
  assert.deepEqual(steps.append('think', 'a'.repeat(STEP_THINK_LIMIT + 100)), []);
  assert.deepEqual(steps.append('text', ''), []);

  const thought = steps.append('text', 'b'.repeat(STEP_TEXT_LIMIT + 100))[0];
  const text = steps.flush()[0];

  assert.equal(thought.at, 10);
  assert.equal(text.at, 11);
  assert.equal(String(thought.text).length, STEP_THINK_LIMIT + 1);
  assert.equal(String(text.text).length, STEP_TEXT_LIMIT + 1);
  assert.notEqual(thought.id, text.id);
  assert.deepEqual(steps.flush(), []);
  steps.append('think', ' \n ');
  assert.deepEqual(steps.flush(), []);
});
