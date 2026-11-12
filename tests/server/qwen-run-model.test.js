import assert from 'node:assert/strict';
import test from 'node:test';

import { qwenSelectedModel } from '../../server/src/lib/qwen/modelMetadata.ts';
import { qwenAdapter, qwenFixture, runInput } from '../helpers/qwenFixture.mjs';

test('Qwen передаёт подтверждённую CLI модель до prompt и сохраняет её при resume', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const model = 'shared-model(anthropic)';
  const reports = [];
  let sessionSaved = false;

  await fixture.fake({ metadata: { [model]: {} } });

  const callbacks = {
    onSessionCreated: () => {
      sessionSaved = true;
    },
    onRunMetadata: (metadata) => {
      assert.equal(sessionSaved, true);
      reports.push(metadata);
    },
    onStep: (step) => {
      if (step.k === 'start') {
        assert.equal(reports.at(-1)?.actualModelId, model);
      }
    },
  };
  const first = await adapter.run(runInput(fixture, model, callbacks));

  sessionSaved = false;

  const second = await adapter.run(runInput(fixture, model, {
    ...callbacks,
    sessionId: first.sessionId,
  }));

  assert.equal(first.actualModel, model);
  assert.equal(second.actualModel, model);
  assert.equal(second.sessionId, first.sessionId);
  assert.deepEqual(reports, [
    { actualModelId: model, modelSource: 'session' },
    { actualModelId: model, modelSource: 'session' },
  ]);
});

test('Qwen принимает названную модель сессии, а пустой ACK и чужую сессию не подтверждает', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const requested = 'shared-model(anthropic)';
  const reported = 'shared-model(openai)';

  for (const [options, expected] of [
    [{ modelUpdate: reported }, reported],
    [{}, ''],
    [{ modelUpdate: reported, foreignModelUpdate: true }, ''],
  ]) {
    const reports = [];

    await fixture.fake(options);

    const result = await adapter.run(runInput(fixture, requested, {
      onRunMetadata: (metadata) => reports.push(metadata),
    }));

    assert.equal(result.reply, 'Новый ответ');
    assert.equal(result.actualModel || '', expected);
    assert.deepEqual(reports, expected ? [{ actualModelId: expected, modelSource: 'session' }] : []);
  }
});

test('Qwen читает текущую модель из metadata, не подставляя доступные варианты', () => {
  const options = [{
    id: 'model',
    type: 'select',
    currentValue: ' effective-model(openai) ',
    options: [{ value: 'requested-model(openai)' }],
  }];

  assert.equal(qwenSelectedModel(options), 'effective-model(openai)');
  assert.equal(qwenSelectedModel(undefined), '');
  assert.equal(qwenSelectedModel([{ ...options[0], currentValue: undefined }]), '');
  assert.equal(qwenSelectedModel([{ ...options[0], currentValue: 42 }]), '');
  assert.equal(qwenSelectedModel([{ ...options[0], type: 'boolean' }]), '');
});
