import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('W5: опрос пересборки переживает временный отказ и ограничен сроком', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });

  let reads = 0;
  let unavailable = false;
  const fixture = await settingsHarness(t, 'system.updates', 'SystemPage', {
    prepare({ control }) {
      control.handlers['/api/system/version'] = () =>
        new Response(JSON.stringify(control.data.release));
      control.handlers['/api/system/web-rebuild'] = ({ method }) => {
        if (method === 'POST') {
          return new Response(JSON.stringify({ ok: true }));
        }

        reads += 1;

        if (unavailable || reads === 2) {
          return new Response(JSON.stringify({ message: 'Временный отказ GET' }), { status: 503 });
        }

        return new Response(JSON.stringify({ rebuild: { status: reads === 1 ? 'running' : 'done' } }));
      };
    },
  });
  const { wrapper, flushPromises } = fixture;

  t.mock.timers.tick(2000);
  await flushPromises();
  assert.equal(reads, 2);
  t.mock.timers.tick(2000);
  await flushPromises();
  assert.equal(reads, 3, 'После неудачного GET выполняется следующая итерация');
  assert.match(wrapper.text(), /Рабочая сборка готова/);
  assert.equal(wrapper.find('[role="alert"]').exists(), false);

  unavailable = true;
  await wrapper.findAll('button').find((button) => button.text() === 'Пересобрать web-бандл')
    .trigger('click');
  await flushPromises();
  t.mock.timers.tick(12 * 60000);
  await flushPromises();

  assert.match(wrapper.text(), /статус неизвестен/i);
  assert.doesNotMatch(wrapper.text(), /Нет выполняемой пересборки/);
});
