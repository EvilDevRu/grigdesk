import assert from 'node:assert/strict';
import test from 'node:test';

import { cardButton, mountTrackerCard } from './helpers/trackerCard.js';

process.env.NODE_ENV = 'test';

for (const presentation of ['dialog', 'document']) {
  for (const detailMode of ['held', 'error']) {
    test(`LEGACY-READY-01: ${presentation}/${detailMode}, custom actions до details`, async (t) => {
      const { wrapper } = await mountTrackerCard(t, { presentation, detailMode });

      assert.equal(wrapper.find('[aria-label="Учёт времени"]').exists(), true);
      assert.equal(wrapper.find('[data-task-section="comments"]').exists(), true);
      assert.equal(cardButton(wrapper, 'Завершить')?.element.disabled, false);
      assert.equal(cardButton(wrapper, 'Остановить учёт')?.element.disabled, false);
      assert.equal(wrapper.find('[data-role="task-edit-open"]').exists(), false);
    });
  }

  test(`LEGACY-READY-01: ${presentation}, own-диапазон ждёт подтверждения источника`, async (t) => {
    const { wrapper } = await mountTrackerCard(t, {
      presentation,
      detailMode: 'held',
      id: '100000000001'
    });

    assert.equal(wrapper.find('[aria-label="Учёт времени"]').exists(), false);
    assert.equal(wrapper.find('[data-task-section="comments"]').exists(), false);
    assert.equal(cardButton(wrapper, 'Завершить') === undefined, true);
    assert.equal(wrapper.find('[data-role="task-edit-open"]').exists(), false);
  });
}

for (const presentation of ['dialog', 'document']) {
  test(`TRACKER-UI-02: ${presentation}, metadata404 старого сервера сохраняет custom actions`, async (t) => {
    const { wrapper } = await mountTrackerCard(t, {
      presentation,
      metadataMode: 'legacy',
      capabilities: null,
    });

    assert.equal(wrapper.find('[aria-label="Учёт времени"]').exists(), true);
    assert.equal(wrapper.find('[data-task-section="comments"]').exists(), true);
    assert.equal(cardButton(wrapper, 'Завершить')?.element.disabled, false);
  });
}
