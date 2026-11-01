import assert from 'node:assert/strict';
import test from 'node:test';

import { mountTrackerCard, STOCK_CAPS } from './helpers/trackerCard.js';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

for (const confirmed of [false, true]) {
  test(`TRACKER-DELETE-UI-01: подтверждение=${confirmed}, удаление проходит через tasks store`, async (t) => {
    const confirmations = [];
    const card = await mountTrackerCard(t, {
      trackerId: 'grigdesk-b24',
      capabilities: STOCK_CAPS,
      confirm: async (...args) => {
        confirmations.push(args);

        return confirmed;
      },
    });
    const button = card.wrapper.get('[data-role="task-delete"]');

    assert.equal(button.text(), 'Удалить');
    await button.trigger('click');
    await card.flushPromises();
    assert.deepEqual(confirmations, [[
      'Удалить задачу на портале? Действие необратимо.',
      { danger: true, okText: 'Удалить' },
    ]]);

    const mutations = card.calls.filter((call) => call.method === 'DELETE');
    const reloads = card.calls.filter((call) => call.method === 'BOARD');

    assert.equal(mutations.length, confirmed ? 1 : 0);
    assert.equal(reloads.length, confirmed ? 1 : 0);
    assert.equal(card.ui.taskId, confirmed ? null : '42');
    assert.equal(Boolean(card.tasks.details['42']), !confirmed);

    if (confirmed) {
      assert.equal(mutations[0].url, '/api/tracker/task/42');
      assert.deepEqual(mutations[0].options, {
        headers: { 'x-grigdesk-tracker-generation': '1' },
      });
      assert.equal(reloads[0].force, true);
    }
  });
}

for (const metadataMode of ['held', 'empty', 'error', 'legacy']) {
  test(`TRACKER-DELETE-UI-02: ${metadataMode} не разрешает новое удаление`, async (t) => {
    const card = await mountTrackerCard(t, { metadataMode });

    assert.equal(card.wrapper.find('[data-role="task-delete"]').exists(), false);
  });
}

test('TRACKER-DELETE-UI-02: драйвер без capability.delete скрывает кнопку', async (t) => {
  const card = await mountTrackerCard(t);

  assert.equal(card.wrapper.find('[data-role="task-delete"]').exists(), false);
  assert.equal(card.calls.some((call) => call.method === 'DELETE'), false);
});

test('TRACKER-DELETE-UI-03: отказ портала сохраняет карточку, кеш и доску', async (t) => {
  const card = await mountTrackerCard(t, {
    capabilities: STOCK_CAPS,
    deleteError: 'Нет прав удалять задачу',
  });

  await card.wrapper.get('[data-role="task-delete"]').trigger('click');
  await card.flushPromises();
  assert.equal(card.ui.taskId, '42');
  assert.equal(Boolean(card.tasks.details['42']), true);
  assert.equal(card.calls.filter((call) => call.method === 'DELETE').length, 1);
  assert.equal(card.calls.some((call) => call.method === 'BOARD'), false);
  assert.match(card.wrapper.get('.malerts .err').text(), /Нет прав удалять задачу/u);
});

test('TRACKER-DELETE-UI-04: смена карточки во время подтверждения отменяет удаление', async (t) => {
  const confirmation = Promise.withResolvers();
  const card = await mountTrackerCard(t, {
    capabilities: STOCK_CAPS,
    confirm: () => confirmation.promise,
  });

  t.after(() => confirmation.resolve(false));
  await card.wrapper.get('[data-role="task-delete"]').trigger('click');
  card.ui.taskId = '43';
  confirmation.resolve(true);
  await card.flushPromises();
  assert.equal(card.calls.some((call) => call.method === 'DELETE'), false);
  assert.equal(card.ui.taskId, '43');
});

test('TRACKER-DELETE-UI-04: смена трекера во время подтверждения отменяет удаление', async (t) => {
  const confirmation = Promise.withResolvers();
  const card = await mountTrackerCard(t, {
    capabilities: STOCK_CAPS,
    confirm: () => confirmation.promise,
  });

  t.after(() => confirmation.resolve(false));
  await card.wrapper.get('[data-role="task-delete"]').trigger('click');

  for (const listener of card.listeners) {
    listener('trackers-changed', { revision: 2, externalId: 'another-driver' });
  }

  confirmation.resolve(true);
  await card.flushPromises();
  assert.equal(card.calls.some((call) => call.method === 'DELETE'), false);
});

test('TRACKER-DELETE-UI-05: декодер принимает только явный булевый delete', async () => {
  const { trackerCapabilities, LEGACY_TRACKER_CAPABILITIES } = await compileModule(
    webFile('src/shared/trackerCapabilities.ts'),
  );

  for (const value of [undefined, {}, { delete: 'true' }, { delete: 1 }, { delete: false }]) {
    assert.equal(trackerCapabilities(value).delete, false);
  }

  assert.equal(trackerCapabilities({ delete: true }).delete, true);
  assert.equal(LEGACY_TRACKER_CAPABILITIES.delete, false);
});
