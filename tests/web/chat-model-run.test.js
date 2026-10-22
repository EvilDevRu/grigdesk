import assert from 'node:assert/strict';
import test from 'node:test';

import { lastModelRun, modelRunView } from '../../web/src/shared/chatModelRun.ts';

test('GPT-ход без actualModel не откатывает шапку к старому Claude-факту', () => {
  const messages = [
    { role: 'assistant', model: 'claude-fable-5', actualModel: 'claude-fable-5', effort: 'max' },
    { role: 'user', text: 'Переключись на GPT' },
    { role: 'assistant', model: 'gpt-5.6-terra', actualModel: '', effort: 'max' },
  ];

  const run = lastModelRun(messages);
  assert.equal(run.model, 'gpt-5.6-terra');
  assert.deepEqual(modelRunView(run), {
    model: 'gpt-5.6-terra',
    requested: 'gpt-5.6-terra',
    source: 'запрошено',
    actual: false,
    mismatch: false,
  });
});

test('явный факт CLI имеет приоритет и показывает реальный рассинхрон', () => {
  assert.deepEqual(modelRunView({
    model: 'claude-opus-5',
    actualModel: 'claude-sonnet-5',
  }), {
    model: 'claude-sonnet-5',
    requested: 'claude-opus-5',
    source: 'факт',
    actual: true,
    mismatch: true,
  });
});

test('датированный actualModel считается формой запрошенного id', () => {
  assert.equal(modelRunView({
    model: 'claude-fable-5',
    actualModel: 'claude-fable-5-20260701',
  }).mismatch, false);
});
