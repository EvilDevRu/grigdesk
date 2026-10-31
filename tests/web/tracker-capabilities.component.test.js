import assert from 'node:assert/strict';
import test from 'node:test';

import { mountBoardView } from './helpers/board-view.js';
import { cardButton, mountTrackerCard, STOCK_CAPS } from './helpers/trackerCard.js';

process.env.NODE_ENV = 'test';

for (const presentation of ['dialog', 'document']) {
  test(`TRACKER-CAPS-01: ${presentation}, stock скрывает unsupported при stale payload`, async (t) => {
    const { wrapper, calls } = await mountTrackerCard(t, {
      presentation,
      trackerId: 'grigdesk-b24',
      capabilities: STOCK_CAPS,
    });

    assert.equal(wrapper.find('[aria-label="Учёт времени"]').exists(), false);
    assert.equal(wrapper.find('[data-task-section="comments"]').exists(), false);
    assert.equal(wrapper.find('[data-role="task-edit-open"]').exists(), false);
    assert.equal(wrapper.find('[data-role="task-comment"]').exists(), false);
    assert.equal(cardButton(wrapper, 'Возобновить') === undefined, true);
    assert.equal(cardButton(wrapper, 'Завершить')?.element.disabled, false);
    assert.equal(wrapper.text().includes('stale.png'), false);
    assert.equal(calls.some((call) => call.url.endsWith('/comments')), false);
  });

  test(`TRACKER-CAPS-01: ${presentation}, завершённый stock не предлагает renew`, async (t) => {
    const { wrapper } = await mountTrackerCard(t, {
      presentation,
      trackerId: 'grigdesk-b24',
      capabilities: STOCK_CAPS,
      status: 5,
    });

    assert.equal(cardButton(wrapper, 'Возобновить') === undefined, true);
    assert.equal(wrapper.find('[aria-label="Учёт времени"]').exists(), false);
  });

  for (const metadataMode of ['held', 'error', 'empty']) {
    test(`TRACKER-UI-02: ${presentation}/${metadataMode}, неизвестные возможности не включают действия`,
      async (t) => {
        const { wrapper } = await mountTrackerCard(t, {
          presentation,
          metadataMode,
          capabilities: null,
        });

        assert.equal(wrapper.find('[aria-label="Учёт времени"]').exists(), false);
        assert.equal(wrapper.find('[data-role="task-comment"]').exists(), false);
        assert.equal(cardButton(wrapper, 'Завершить') === undefined, true);
      });
  }
}

test('TRACKER-CAPS-01: stock не показывает активный таймер из старого snapshot', async (t) => {
  const { wrapper, stores, flushPromises } = await mountBoardView(t, {
    tasks: [{
      id: 42,
      title: 'Облачная задача',
      timerRunning: true,
      timerElapsed: 15
    }],
  });

  Object.assign(stores.board().data, {
    trackerId: 'grigdesk-b24',
    capabilities: STOCK_CAPS,
    widgets: []
  });
  await flushPromises();
  assert.equal(wrapper.find('.active-timers').exists(), false);
});

test('TRACKER-UI-02: поздний detail после trackers-changed не принимается в карточку', async (t) => {
  const card = await mountTrackerCard(t, { detailMode: 'held' });

  for (const listener of card.listeners) {
    listener('trackers-changed', { revision: 2, externalId: 'grigdesk-b24' });
  }

  card.heldDetail.resolve({
    id: 42,
    source: 'b24',
    title: 'Ответ старого поколения',
    status: 3
  });
  await card.flushPromises();
  assert.equal(card.wrapper.text().includes('Ответ старого поколения'), false);
});
