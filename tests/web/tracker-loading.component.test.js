import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionButton, liveTrackerDialog, mountTrackerBoard, openTrackerInstaller, openTrackerSettings,
} from './helpers/trackerBoard.js';

process.env.NODE_ENV = 'test';

for (const screen of ['manage', 'source']) {
  test(`TRACKER-LOADING: ожидание ${screen} повторяет выбранный экран установщика`, async (t) => {
    const held = Promise.withResolvers();
    const card = await mountTrackerBoard(t, {
      handlers: {
        get: async (url) => {
          if (url === '/api/driver-installs/jobs/current') {
            await held.promise;
          }
        },
      },
    });

    t.after(() => held.resolve());
    await openTrackerSettings(card);

    if (screen === 'source') {
      await openTrackerInstaller(card);
    } else {
      await actionButton(card.wrapper, /^Другие действия$/u).trigger('click');
      await card.flushPromises();
    }

    const dialog = liveTrackerDialog(card);
    const loading = dialog.get('[data-ui-loading]');
    const region = screen === 'source' ? 'tracker-sources' : 'tracker-packages';

    assert.equal(loading.findAll('[role="status"]').length, 1);
    assert.equal(loading.get(`[data-loading-region="${region}"]`).attributes('aria-hidden'), 'true');
    assert.equal(loading.find('.ui-skeleton-layout').exists(), false);
    assert.equal(loading.find('button, input, select').exists(), false);
    assert.equal(dialog.get('.driver-install').attributes('aria-busy'), 'true');
    assert.equal(dialog.find('.ui-dialog__description').exists(), true);
    assert.equal(card.apiCalls.some((call) => call.method === 'POST'), false);

    if (screen === 'source') {
      assert.equal(dialog.get('[data-primary]').element.disabled, true);
      assert.equal(dialog.findAll('.driver-steps li').length, 4);
      assert.equal(dialog.get('.driver-steps li[aria-current="step"]').text().includes('Трекер'), true);
    }

    held.resolve();
    await card.flushPromises();

    const loaded = liveTrackerDialog(card);

    assert.equal(loaded.find('[data-ui-loading]').exists(), false);
    assert.equal(loaded.find(screen === 'source' ? '.driver-source' : '.driver-package').exists(), true);
    assert.equal(loaded.get('.driver-install').attributes('aria-busy'), 'false');
  });
}

test('TRACKER-LOADING: версии занимают одно поле, ручной ввод сохраняется при ожидании', async (t) => {
  const held = Promise.withResolvers();
  const card = await mountTrackerBoard(t, {
    handlers: {
      post: async (url) => {
        if (url === '/api/driver-installs/versions') {
          await held.promise;
        }
      },
    },
  });

  t.after(() => held.resolve());
  await openTrackerSettings(card);
  await openTrackerInstaller(card);
  await actionButton(liveTrackerDialog(card), /^Далее$/u).trigger('click');
  await card.flushPromises();

  let dialog = liveTrackerDialog(card);
  const loading = dialog.get('[data-ui-loading]');

  assert.equal(loading.find('[data-loading-region="tracker-version"]').exists(), true);
  assert.equal(loading.findAll('[data-ui-skeleton][data-shape="block"]').length, 1);
  assert.equal(dialog.find('.ui-dialog__description').exists(), true);
  assert.equal(dialog.get('[data-primary]').element.disabled, true);
  await actionButton(dialog, /^Указать версию вручную$/u).trigger('click');
  await card.flushPromises();
  dialog = liveTrackerDialog(card);

  assert.equal(dialog.find('[data-loading-region="tracker-version"]').exists(), false);
  assert.equal(dialog.get('[data-ui-loading]').attributes('data-variant'), 'inline');
  assert.equal(dialog.find('input[name="tag"]').exists(), true);
  assert.equal(dialog.get('input[name="tag"]').element.disabled, true);
  held.resolve();
  await card.flushPromises();
  dialog = liveTrackerDialog(card);

  assert.equal(dialog.find('[data-ui-loading]').exists(), false);
  assert.equal(dialog.get('input[name="tag"]').element.disabled, false);
});
