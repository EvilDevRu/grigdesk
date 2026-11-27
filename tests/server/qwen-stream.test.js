import assert from 'node:assert/strict';
import test from 'node:test';

import { createQwenTextSteps } from '../../server/src/lib/qwen/steps.ts';
import { createQwenBackground } from '../../server/src/lib/qwen/background.ts';
import { STEP_TEXT_LIMIT, STEP_THINK_LIMIT } from '../../server/src/lib/chat/streamSteps.ts';
import { rejectedTurn } from '../helpers/qwenFixture.mjs';
import { runQwenPreviewStream } from '../helpers/qwenPreviewStream.mjs';

const chunk = (kind, text) => ({ sessionUpdate: kind, content: { type: 'text', text } });

test('Qwen: чередующиеся каналы не дробят ответ и размышление', async (t) => {
  const stream = [
    chunk('agent_thought_chunk', 'Проверяю '),
    chunk('agent_message_chunk', 'Компоненты настоя'),
    chunk('agent_thought_chunk', 'компоненты '),
    chunk('agent_message_chunk', 'щие, импорты '),
    chunk('agent_thought_chunk', 'и импорты.'),
    chunk('agent_message_chunk', 'есть.'),
  ];
  const steps = [];
  const messages = [];

  const result = await runQwenPreviewStream(t, stream, {
    onStep: (step) => steps.push(step),
    onAssistantMessage: (message) => messages.push(message),
  });

  const expected = [
    { k: 'think', text: 'Проверяю компоненты и импорты.' },
    { k: 'text', text: 'Компоненты настоящие, импорты есть.' },
  ];
  const textSteps = steps.filter((step) => ['think', 'text'].includes(step.k));

  assert.deepEqual(textSteps.map(({ k, text }) => ({ k, text })), expected);
  assert.deepEqual(steps, result.steps);
  assert.deepEqual(messages.map((message) => message.text), [expected[1].text]);
  assert.equal(result.reply, expected[1].text);

  const backgroundSteps = [];
  const background = createQwenBackground('synthetic-session', {
    onBackgroundStep: (step) => backgroundSteps.push(step),
  });

  stream.forEach((update) => background.observe(update));
  await background.finish('end_turn');
  assert.deepEqual(backgroundSteps.map(({ k, text }) => ({ k, text })), expected);
});

test('Qwen: дельты собираются в смысловые блоки в живой и сохранённой ленте', async (t) => {
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

  const live = [];
  const result = await runQwenPreviewStream(t, stream, { onStep: (step) => live.push(step) });

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

  const stream = [chunk('agent_thought_chunk', 'Сохранённый '), chunk('agent_thought_chunk', 'хвост.')];
  const live = [];
  const reason = await rejectedTurn(() => runQwenPreviewStream(t, stream, {
    onStep: (step) => live.push(step),
  }, new Error('synthetic stream failure')));

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

  assert.deepEqual(steps.append('text', 'b'.repeat(STEP_TEXT_LIMIT + 100)), []);

  const [thought, text] = steps.flush();

  assert.equal(thought.at, 10);
  assert.equal(text.at, 11);
  assert.equal(String(thought.text).length, STEP_THINK_LIMIT + 1);
  assert.equal(String(text.text).length, STEP_TEXT_LIMIT + 1);
  assert.notEqual(thought.id, text.id);
  assert.deepEqual(steps.flush(), []);
  steps.append('think', ' \n ');
  assert.deepEqual(steps.flush(), []);
});

test('Qwen: порядок первых дельт сохраняется, явная граница отделяет следующие блоки', () => {
  let time = 10;
  const steps = createQwenTextSteps(() => time++);

  steps.append('text', 'До инстру');
  steps.append('think', 'Параллельное ');
  steps.append('text', 'мента.');
  steps.append('think', 'размышление.');

  const before = steps.flush();

  assert.deepEqual(before.map((step) => [step.k, step.text, step.at]), [
    ['text', 'До инструмента.', 10],
    ['think', 'Параллельное размышление.', 11],
  ]);
  assert.deepEqual(steps.flush(), []);
  steps.append('text', 'После инструмента.');

  const after = steps.flush();

  assert.equal(after[0].text, 'После инструмента.');
  assert.equal(after[0].at, 12);
  assert.notEqual(after[0].id, before[0].id);
});
