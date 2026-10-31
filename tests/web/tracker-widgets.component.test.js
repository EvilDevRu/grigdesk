import assert from 'node:assert/strict';
import test from 'node:test';

import { mountBoardView } from './helpers/board-view.js';
import { webFile } from './helpers/compile-vue.js';
import { CUSTOM_CAPS } from './helpers/trackerCard.js';

process.env.NODE_ENV = 'test';

const periods = Object.fromEntries(['day', 'week', 'month'].map((period) => [period, {
  labels: [`Метка ${period}`],
  series: [{
    id: 'value',
    label: { text: 'Ряд драйвера' },
    values: [17],
    format: 'count'
  }],
}]));
const widgets = [{
  id: 'totals',
  kind: 'kpi',
  title: { text: 'Сводка драйвера' },
  items: [
    {
      id: 'completed',
      label: { text: 'Готовых задач' },
      value: 17,
      format: 'count'
    },
    {
      id: 'hours',
      label: { text: 'Часы за месяц' },
      value: 82.5,
      format: 'duration',
      progress: { value: 82.5, max: 160 },
      secondaryItems: [{
        id: 'norm',
        label: { text: 'Норма драйвера' },
        value: 160,
        format: 'duration'
      }],
    },
  ],
}, ...['hours', 'tasks', 'average'].map((id) => ({
  id,
  kind: 'chart',
  title: { text: `График ${id}` },
  periods,
}))];

for (const trackerId of ['fixture-a', 'fixture-b']) {
  test(`TRACKER-WIDGETS-01: ${trackerId} рисует один DTO без привязки к vendor`, async (t) => {
    const { wrapper, flushPromises } = await mountBoardView(t, {
      snapshot: {
        trackerId,
        capabilities: CUSTOM_CAPS,
        widgets
      },
      compilerStubs: {
        './board/MiniChart.vue': `
          export { default } from ${JSON.stringify(webFile('src/views/board/MiniChart.vue'))};
        `,
      },
    });

    assert.match(wrapper.text(), /Сводка драйвера/u);
    assert.match(wrapper.text(), /Готовых задач[\s\S]*17/u);
    assert.match(wrapper.text(), /Норма драйвера/u);
    assert.match(wrapper.text(), /160/u);

    for (const id of ['hours', 'tasks', 'average']) {
      assert.ok(wrapper.text().includes(`График ${id}`));
    }

    for (const period of ['День', 'Неделя', 'Месяц']) {
      const button = wrapper.findAll('button').find((candidate) => candidate.text().trim() === period);

      assert.ok(button, `Есть переключатель ${period}`);
      await button.trigger('click');
      await flushPromises();
      assert.equal(button.attributes('aria-pressed') ?? button.attributes('aria-selected'), 'true');
    }
  });
}

test('TRACKER-WIDGETS-01: widgets=[] не рисует salary-плитки из compatibility', async (t) => {
  const { wrapper } = await mountBoardView(t, {
    snapshot: {
      trackerId: 'fixture-a',
      capabilities: CUSTOM_CAPS,
      widgets: []
    },
    month: {
      hours: 999,
      norm: 1000,
      completedTasks: 777
    },
  });

  assert.equal(wrapper.find('[data-stat="month-completed"]').exists(), false);
  assert.equal(wrapper.text().includes('За месяц'), false);
  assert.equal(wrapper.text().includes('777'), false);
  assert.equal(wrapper.find('.charts').exists(), false);
});
