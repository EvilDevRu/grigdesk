import assert from 'node:assert/strict';
import test from 'node:test';

import { qwenEffortOption } from '../../server/src/lib/qwen/modelMetadata.ts';
import { qwenAdapter, runInput } from '../helpers/qwenFixture.mjs';
import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';

test('Qwen Preview.2: каталог сохраняет окно маршрута и не обещает неизвестное усилие', async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const primary = fixture.settings.modelProviders.openai[0];

  primary.generationConfig.contextWindowSize = 96000;
  fixture.settings.modelProviders.openai.push({
    ...primary,
    id: 'secondary',
    name: 'Вторая модель',
    generationConfig: { ...primary.generationConfig, contextWindowSize: 48000 },
  });
  await fixture.writeSettings(fixture.settings);

  const models = await adapter.catalog(fixture.config);
  const first = models.find((model) => model.id === 'shared-model(openai)');
  const second = models.find((model) => model.id === 'secondary(openai)');

  assert.equal(first.context, 96000);
  assert.equal(second.context, 48000);
  assert.deepEqual(first.efforts, []);
  assert.deepEqual(second.efforts, []);
  await assert.rejects(adapter.run(runInput(fixture, second.id, { effort: 'xhigh' })), /усилие недоступно/);
  assert.equal(fixture.requests.length, 0);
});

test('Qwen: группы ACP, default для переключения thinking и отсутствие capability', () => {
  const option = qwenEffortOption([{
    id: 'reasoning_effort',
    type: 'select',
    currentValue: 'default',
    _meta: { 'qwenCode/reasoning': { toggleOnly: true } },
    options: [{ value: 'none' }, { options: [{ value: 'default' }, { value: 'none' }] }, { value: 7 }],
  }]);

  assert.deepEqual(option, { current: 'default', levels: ['none', 'default'] });
  assert.equal(qwenEffortOption(undefined), null);
  assert.equal(qwenEffortOption([]), null);
  assert.equal(qwenEffortOption([{
    id: 'reasoning_effort',
    type: 'select',
    options: [{ value: 'none' }, { value: 'high' }, { value: 'max' }],
  }]), null, 'Общий fallback CLI не объявляет поддержку усилия конкретной моделью');
  assert.equal(qwenEffortOption([{
    id: 'reasoning_effort',
    type: 'boolean',
    options: [],
  }]), null);
});
