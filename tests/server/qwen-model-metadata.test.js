import assert from 'node:assert/strict';
import test from 'node:test';

import { qwenEffortOption } from '../../server/src/lib/qwen/modelMetadata.ts';
import { qwenAdapter, qwenFixture, rejectedTurn, runInput } from '../helpers/qwenFixture.mjs';

/**
 * Разные маршруты возвращают разные ступени и native-окно, включая неизвестное имя уровня.
 * Каталог и запуск используют один протокол, без переноса возможностей соседней модели.
 */
test('Qwen: каталог читает усилие каждой модели и подтверждённое CLI окно', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const first = 'shared-model(openai)';
  const second = 'shared-model(anthropic)';
  const metadata = {
    [first]: {
      context: 96000,
      efforts: ['none', 'low', 'medium', 'xhigh'],
      defaultEffort: 'medium',
    },
    [second]: {
      context: 48000,
      efforts: ['none', 'default', 'future-tier'],
      defaultEffort: 'default',
    },
  };

  await fixture.fake({ metadata });

  const models = await adapter.catalog(fixture.config);

  assert.deepEqual(models.find((model) => model.id === first).efforts, metadata[first].efforts);
  assert.deepEqual(models.find((model) => model.id === second).efforts, metadata[second].efforts);
  assert.equal(models.find((model) => model.id === first).context, 96000);
  assert.equal(models.find((model) => model.id === second).context, 48000);
  assert.ok(models.every((model) => !model.contextUnverified));

  const result = await adapter.run(runInput(fixture, first, { effort: 'xhigh' }));

  assert.equal(result.reply, 'Новый ответ');

  const frames = (await fixture.records()).filter((entry) => entry.frame?.method).map((entry) => entry.frame);
  const effortIndex = frames.findLastIndex((frame) => frame.method === 'session/set_config_option'
    && frame.params.configId === 'reasoning_effort' && frame.params.value === 'xhigh');
  const promptIndex = frames.findLastIndex((frame) => frame.method === 'session/prompt');

  assert.ok(effortIndex >= 0 && effortIndex < promptIndex, 'Усилие подтверждается до запроса к модели');

  const rejected = await rejectedTurn(() => adapter.run(runInput(fixture, second, { effort: 'xhigh' })));

  assert.match(rejected, /усилие недоступно/);
  assert.equal((await fixture.records()).filter((entry) =>
    entry.frame?.method === 'session/prompt').length, 1, 'Чужой уровень не отправляет prompt');

  await fixture.fake({ metadata, unconfirmedEffort: true });

  const refused = await rejectedTurn(() => adapter.run(runInput(fixture, first, { effort: 'xhigh' })));

  assert.match(refused, /не подтвердил выбранное усилие/);
  assert.equal((await fixture.records()).filter((entry) =>
    entry.frame?.method === 'session/prompt').length, 1, 'Неподтверждённое усилие не отправляет prompt');
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
