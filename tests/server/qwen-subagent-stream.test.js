import assert from 'node:assert/strict';
import test from 'node:test';

import { createQwenBackground } from '../../server/src/lib/qwen/background.ts';
import { createQwenSteps } from '../../server/src/lib/qwen/steps.ts';
import { qwenAdapter, qwenFixture, rejectedTurn, runInput } from '../helpers/qwenFixture.mjs';

const chunk = (text, parent = '', kind = 'agent_message_chunk') => ({
  sessionUpdate: kind,
  content: { type: 'text', text },
  _meta: parent ? { parentToolCallId: parent, subagentType: 'Explore' } : {},
});

const tool = (id, parent = '') => ({
  sessionUpdate: 'tool_call',
  toolCallId: id,
  title: 'read_file',
  kind: 'read',
  rawInput: { file_path: '/workspace/input.txt' },
  _meta: parent ? { parentToolCallId: parent, provenance: 'subagent' } : {},
});

const result = (id) => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: id,
  status: 'completed',
  content: [],
});

const stream = [
  tool('agent-a'),
  tool('agent-b'),
  chunk('Пул ма', 'agent-a'),
  chunk('Смотрю ', 'agent-a', 'agent_thought_chunk'),
  chunk('Проверка B.', 'agent-b'),
  tool('read-b', 'agent-b'),
  chunk('Итог осно'),
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'agent-b',
    status: 'in_progress',
    _meta: { subagentProgress: true, provenance: 'subagent' },
  },
  result('read-b'),
  chunk('жоров.', 'agent-a'),
  chunk('данные.', 'agent-a', 'agent_thought_chunk'),
  chunk('B готов.', 'agent-b'),
  result('agent-a'),
  result('agent-b'),
  chunk('вного агента.'),
];

for (const background of [false, true]) {
  test(`Qwen: параллельные субагенты не дробят чужие слова, background=${background}`, async (t) => {
    const messages = [];
    let outcome;

    if (background) {
      const collector = createQwenBackground('synthetic-session', {
        onBackground: (value) => {
          outcome = value;
        },
      });

      stream.forEach((update) => collector.observe(update));
      await collector.finish('end_turn');
    } else {
      const fixture = await qwenFixture(t);
      const adapter = await qwenAdapter({ runnable: true });

      await fixture.fake({ stream });
      outcome = await adapter.run(runInput(fixture, 'shared-model(openai)', {
        onAssistantMessage: (message) => messages.push(message),
      }));
    }

    const texts = outcome.steps.filter((step) => step.k === 'text');

    assert.deepEqual(texts.filter((step) => step.parent === 'agent-a').map((step) => step.text),
      ['Пул мажоров.']);
    assert.deepEqual(texts.filter((step) => step.parent === 'agent-b').map((step) => step.text),
      ['Проверка B.', 'B готов.']);
    assert.equal(outcome.steps.find((step) => step.k === 'think' && step.parent === 'agent-a').text,
      'Смотрю данные.');
    assert.ok(outcome.steps.filter((step) => step.id === 'read-b')
      .every((step) => step.parent === 'agent-b'));
    assert.ok(outcome.steps.findIndex((step) => step.text === 'Пул мажоров.')
      < outcome.steps.findIndex((step) => step.id === 'agent-a' && step.k === 'res'));
    assert.equal(outcome.reply, 'Итог основного агента.');

    if (!background) {
      assert.deepEqual(messages.map((message) => message.text), ['Итог основного агента.']);
    }
  });
}

test('Qwen: вложенный ребёнок и поздний результат сохраняют собственные границы', () => {
  const collector = createQwenSteps();
  const updates = [
    tool('outer'),
    tool('nested', 'outer'),
    chunk('Внешний ', 'outer'),
    chunk('Внутренний ', 'nested'),
    tool('nested-read', 'nested'),
    chunk('поток.', 'outer'),
    chunk('итог.', 'nested'),
    result('nested-read'),
    result('nested'),
    result('outer'),
  ];
  const steps = updates.flatMap((update) => collector.observe(update));

  steps.push(...collector.flush());
  assert.deepEqual(steps.filter((step) => step.k === 'text').map(({ text, parent }) => ({ text, parent })), [
    { text: 'Внутренний', parent: 'nested' },
    { text: 'итог.', parent: 'nested' },
    { text: 'Внешний поток.', parent: 'outer' },
  ]);
  assert.ok(steps.filter((step) => step.id === 'nested').every((step) => step.parent === 'outer'));
  assert.ok(steps.filter((step) => step.id === 'nested-read').every((step) => step.parent === 'nested'));
  assert.deepEqual(collector.flush(), []);
});

test('Qwen: ошибка выпускает раздельные хвосты, в реплику попадает только основной', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const steps = [];
  const messages = [];

  await fixture.fake({
    stream: [chunk('Основной хвост.'), chunk('Хвост ребёнка.', 'child')],
    streamError: true,
  });

  const error = await rejectedTurn(() => adapter.run(runInput(fixture, 'shared-model(openai)', {
    onStep: (step) => steps.push(step),
    onAssistantMessage: (message) => messages.push(message),
  })));

  assert.match(error, /synthetic stream failure/);
  assert.deepEqual(steps.filter((step) => step.k === 'text').map(({ text, parent }) => ({ text, parent })), [
    { text: 'Основной хвост.', parent: undefined },
    { text: 'Хвост ребёнка.', parent: 'child' },
  ]);
  assert.deepEqual(messages.map((message) => message.text), ['Основной хвост.']);
});

test('Qwen: отмена фонового хода выпускает хвосты ровно один раз', async () => {
  const results = [];
  const collector = createQwenBackground('synthetic-session', {
    onBackground: (result) => results.push(result),
  });

  collector.observe(chunk('Хвост ребёнка.', 'child'));
  await collector.finish('cancelled');
  await collector.finish('cancelled');
  assert.equal(results.length, 1);
  assert.equal(results[0].reply, '⏹ Ход остановлен.');
  assert.deepEqual(results[0].steps.map(({ text, parent }) => ({ text, parent })), [
    { text: 'Хвост ребёнка.', parent: 'child' },
  ]);
});
