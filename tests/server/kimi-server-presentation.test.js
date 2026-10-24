// Лента Kimi должна закрывать реплику перед долгим инструментом и подтверждать модель.
// Искусственный сервер воспроизводит события без вызовов модели и расхода квоты.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runKimiServerTurn } from '../../server/src/lib/kimi/serverTurn.ts';
import { kimiUsageWire } from '../helpers/kimiUsageWire.mjs';

test('Kimi: реплика завершена до результата долгого Agent', async (t) => {
  const called = Promise.withResolvers();
  const release = Promise.withResolvers();
  const blocks = [];
  const wire = await kimiUsageWire(t, [async (send) => {
    send({
      type: 'turn.step.started',
      turnId: 0,
      step: 4,
    });
    send({ type: 'assistant.delta', delta: 'О' });
    send({ type: 'assistant.delta', delta: 'статок плана прочитает критик.' });
    send({
      type: 'tool.call.started',
      toolCallId: 'critic',
      name: 'Agent',
    });
    await release.promise;
    send({
      type: 'tool.result',
      toolCallId: 'critic',
      output: 'Замечания критика',
    });
    send({
      type: 'turn.step.completed',
      turnId: 0,
      step: 4,
    });
    send({ type: 'turn.ended', reason: 'completed' });
  }]);
  const turn = runKimiServerTurn({
    bin: '/bin/true',
    home: '/tmp',
    message: 'Проверь план',
    ...wire,
    onAssistantMessage: (event) => blocks.push(event),
    onStep: (step) => {
      if (step.k === 'tool') {
        called.resolve();
      }
    },
  });

  try {
    await called.promise;
    assert.equal(blocks.at(-1).text, 'Остаток плана прочитает критик.');
    assert.equal(blocks.at(-1).complete, true, 'реплика закрыта, пока Agent ещё работает');
  } finally {
    release.resolve();
    await turn;
  }

  assert.equal(blocks.filter((block) => block.complete).length, 1, 'граница шага не дублирует блок');
});

test('Kimi: пробельная реплика перед инструментом не создаёт пустого блока', async (t) => {
  const blocks = [];
  const wire = await kimiUsageWire(t, [(send) => {
    send({
      type: 'turn.step.started',
      turnId: 0,
      step: 1,
    });
    send({ type: 'assistant.delta', delta: ' \n' });
    send({
      type: 'tool.call.started',
      toolCallId: 'read',
      name: 'Read',
    });
    send({
      type: 'turn.step.completed',
      turnId: 0,
      step: 1,
    });
    send({
      type: 'turn.step.started',
      turnId: 0,
      step: 2,
    });
    send({ type: 'assistant.delta', delta: ' ' });
    send({ type: 'assistant.delta', delta: 'Готово.' });
    send({ type: 'turn.ended', reason: 'completed' });
  }]);
  const result = await runKimiServerTurn({
    bin: '/bin/true',
    home: '/tmp',
    message: 'Прочитай файл',
    ...wire,
    onAssistantMessage: (event) => blocks.push(event),
  });

  assert.ok(blocks.every((block) => block.text.trim()), 'пустых черновиков и итогов нет');
  assert.equal(result.reply, ' Готово.', 'пробелы непустой реплики сохраняются');
  assert.equal(blocks.filter((block) => block.complete).length, 1);
});

test('Kimi: модель основного агента подтверждается независимо от контекстного замера', async (t) => {
  const metadata = [];
  const wire = await kimiUsageWire(t, [(send) => {
    send({ type: 'agent.status.updated', model: 'kimi-code/k3-256k' });
    send({ type: 'agent.status.updated', usage: {} });
    send({ type: 'agent.status.updated', model: '' });
    send({ type: 'agent.status.updated', model: { id: 'wrong-shape' } });
    send({
      type: 'agent.status.updated',
      agentId: 'critic',
      model: 'kimi-code/k3',
    });
    send({ type: 'turn.ended', reason: 'completed' });
  }]);
  const result = await runKimiServerTurn({
    bin: '/bin/true',
    home: '/tmp',
    message: 'Проверь модель',
    model: 'requested-model',
    ...wire,
    onRunMetadata: (event) => metadata.push(event),
  });

  assert.deepEqual(metadata, [{ actualModelId: 'kimi-code/k3-256k', modelSource: 'session' }]);
  assert.equal(result.actualModel, 'kimi-code/k3-256k');
  assert.equal(Object.hasOwn(result, 'contextTokens'), false);
});

test('Kimi: запрошенная модель без статуса не выдаётся за подтверждённую', async (t) => {
  const metadata = [];
  const wire = await kimiUsageWire(t, [(send) => send({ type: 'turn.ended', reason: 'completed' })]);
  const result = await runKimiServerTurn({
    bin: '/bin/true',
    home: '/tmp',
    message: 'Без подтверждения',
    model: 'kimi-code/k3',
    ...wire,
    onRunMetadata: (event) => metadata.push(event),
  });

  assert.deepEqual(metadata, []);
  assert.equal(Object.hasOwn(result, 'actualModel'), false);
});
