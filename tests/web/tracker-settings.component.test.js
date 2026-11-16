import assert from 'node:assert/strict';
import test from 'node:test';

import { migrationHarness } from './helpers/compile-vue.js';
import {
  actionButton, chooseExternal, driverInstallInfo, driverJob, mountTrackerBoard, openTrackerSettings,
  liveTrackerDialog, prepareTracker, trackerCatalog,
} from './helpers/trackerBoard.js';

process.env.NODE_ENV = 'test';

test('TRACKER-SETTINGS-01: настройки без отдельного трекера GrigDesk, выбор и secret через tracker API',
  async (t) => {
    const card = await mountTrackerBoard(t);

    await openTrackerSettings(card);

    assert.equal(card.wrapper.find('section[aria-label="GrigDesk"]').exists(), false);
    assert.equal(card.wrapper.find('option[value="own"]').exists(), false);
    await chooseExternal(card, 'grigdesk-b24');

    const secret = card.wrapper.find('input[type="password"]');

    assert.ok(secret.exists());
    assert.equal(secret.element.value, '');
    await secret.setValue('fixture-secret');

    const apply = actionButton(card.wrapper, /применить|apply/iu);

    assert.ok(apply);
    assert.equal(apply.attributes('data-variant'), 'outline');
    assert.equal(apply.attributes('data-tone'), 'neutral');
    await apply.trigger('click');
    await card.flushPromises();

    const writes = card.apiCalls.filter((call) => call.method === 'POST');

    assert.ok(writes.some((call) => call.url === '/api/trackers/settings'
      && call.payload.externalId === 'grigdesk-b24'));
    assert.ok(writes.some((call) => JSON.stringify(call.payload).includes('fixture-secret')));
    assert.equal(writes.some((call) => call.url.includes('/plugins')), false);
    assert.equal(card.state.catalog.activeIds.includes('own'), true);
    assert.match(card.wrapper.text(), /Настройки доски сохранены|Board settings saved/iu);

    const updatedSecret = card.wrapper.find('input[type="password"]');

    assert.equal(updatedSecret.element.value, 'fixture-secret');
    await updatedSecret.setValue('updated-fixture-secret');
    assert.doesNotMatch(card.wrapper.text(), /Настройки доски сохранены|Board settings saved/iu);
  });

test('TRACKER-SETTINGS-02: stale revision показывает отказ и сохраняет выбранный источник', async (t) => {
  const card = await mountTrackerBoard(t, {
    handlers: {
      post: async (url) => {
        if (url === '/api/trackers/settings') {
          throw new migrationHarness.ApiError('Настройки изменились в другом окне', 409, {
            error: 'tracker_context_changed',
          });
        }
      },
    },
  });

  await openTrackerSettings(card);
  await chooseExternal(card, 'grigdesk-b24-discript');
  await actionButton(card.wrapper, /сохранить|save/iu).trigger('click');
  await card.flushPromises();
  assert.match(card.wrapper.text(), /Настройки изменились/u);
  assert.equal(card.state.catalog.externalId, null);
});

test('TRACKER-SETTINGS-03: шестерёнка сразу показывает текущие настройки независимо от job установщика',
  async (t) => {
    for (const status of [null, 'done', 'ready']) {
      await t.test(String(status), async (subtest) => {
        const card = await mountTrackerBoard(subtest, {
          handlers: {
            get: async (_url, state) => {
              state.catalog.externalId = 'grigdesk-b24';
              state.settings.externalId = 'grigdesk-b24';
              state.settings.settings = { 'grigdesk-b24': { baseUrl: 'https://portal.fixture' } };

              if (status) {
                state.installed ??= driverInstallInfo('1.1.0', 2);
                state.job ??= driverJob('update', state.installed, status);
              }
            },
          },
        });

        await openTrackerSettings(card);

        const dialog = card.wrapper.find('[data-role="tracker-settings"]');

        assert.equal(dialog.exists(), true, 'Шестерёнка открывает форму доски без промежуточного экрана');
        assert.equal(card.wrapper.find('[data-role="tracker-install"]').exists(), false);
        assert.equal(dialog.find('select').element.value, 'grigdesk-b24');
        assert.equal(dialog.find('input[type="text"]').element.value, 'https://portal.fixture');
        assert.equal(dialog.find('input[type="password"]').element.value, '');
        assert.equal(card.apiCalls.some((call) => call.url.includes('/api/driver-installs/jobs')), false);
        assert.equal(card.apiCalls.some((call) => call.method === 'POST'), false);
      });
    }
  });

test('TRACKER-SETTINGS-04: после установки вход открывает параметры, добавление сразу открывает источники',
  async (t) => {
    const card = await mountTrackerBoard(t);

    await openTrackerSettings(card);

    const installer = await prepareTracker(card);

    await actionButton(installer, /^Установить$/u).trigger('click');
    await card.flushPromises();
    assert.match(installer.text(), /Установлено/u);
    await installer.find('button[aria-label="Закрыть"]').trigger('click');
    await card.flushPromises();
    await openTrackerSettings(card);
    assert.equal(card.wrapper.find('[data-role="tracker-settings"]').exists(), true);
    assert.equal(card.wrapper.find('[data-role="tracker-install"]').exists(), false);

    assert.equal(Boolean(actionButton(card.wrapper, /^Другие действия$/u)), false);
    await actionButton(card.wrapper, /^Добавить трекер$/u).trigger('click');
    await card.flushPromises();
    assert.equal(card.wrapper.find('.driver-job').exists(), false);
    assert.equal(card.wrapper.find('.driver-sources').exists(), true);
    assert.equal(card.state.job.status, 'done');
    assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/apply')).length, 1);
    assert.equal(card.apiCalls.some((call) => call.url.endsWith('/cancel')), false);
  });

test('TRACKER-SETTINGS-05: медленное чтение не позволяет сохранить пустые настройки до загрузки',
  async (t) => {
    const held = Promise.withResolvers();
    const card = await mountTrackerBoard(t, {
      handlers: {
        get: async (url) => {
          if (url === '/api/trackers/settings') {
            await held.promise;
          }
        },
      },
    });

    t.after(() => held.resolve());
    await openTrackerSettings(card);

    const dialog = card.wrapper.find('[data-role="tracker-settings"]');

    assert.equal(dialog.exists(), true);
    assert.equal(dialog.find('[data-ui-loading]').exists(), true);
    assert.equal(dialog.get('.tracker-settings').attributes('aria-busy'), 'true');
    assert.equal(dialog.findAll('[data-ui-loading] [role="status"]').length, 1);
    assert.equal(dialog.find('[data-ui-loading] .tracker-settings__sidebar').exists(), true);
    assert.equal(dialog.find('[data-ui-loading] .tracker-settings__editor').exists(), true);
    assert.equal(dialog.find('[data-ui-loading] [data-layout="form"]').exists(), false);
    assert.equal(dialog.find('[data-ui-loading] input, [data-ui-loading] button').exists(), false);
    assert.equal(dialog.find('select').exists(), false);
    assert.equal(actionButton(dialog, /^Сохранить$/u).element.disabled, true);
    assert.equal(actionButton(dialog, /^Применить$/u).element.disabled, true);
    assert.equal(card.apiCalls.some((call) => call.method === 'POST'), false);
    held.resolve();
    await card.flushPromises();

    const loaded = card.wrapper.find('[data-role="tracker-settings"]');

    assert.equal(loaded.find('[data-ui-loading]').exists(), false);
    assert.equal(loaded.get('.tracker-settings').attributes('aria-busy'), 'false');
    assert.equal(loaded.find('select').exists(), true);
    assert.equal(actionButton(loaded, /^Сохранить$/u).element.disabled, false);
  });

test('TRACKER-SETTINGS-06: каталог переключает редактор, сохраняя черновики и выбор подключения доски',
  async (t) => {
    const card = await mountTrackerBoard(t);

    await openTrackerSettings(card);
    assert.equal(card.wrapper.findAll('[data-driver]').length, 2);
    await card.wrapper.find('input[type="password"]').setValue('cloud-draft');
    await card.wrapper.find('[data-driver="grigdesk-b24-discript"]').trigger('click');
    await card.flushPromises();
    assert.match(card.wrapper.find('.tracker-settings__driver-heading').text(), /Кастомный Б24/u);
    assert.equal(card.wrapper.find('[data-role="tracker-board-enabled"]').element.checked, false);
    assert.equal(card.state.catalog.externalId, null);
    await card.wrapper.find('[data-driver="grigdesk-b24"]').trigger('click');
    await card.flushPromises();
    assert.equal(card.wrapper.find('input[type="password"]').element.value, 'cloud-draft');
    await actionButton(card.wrapper, /^Сохранить$/u).trigger('click');
    await card.flushPromises();

    const write = card.apiCalls.find((call) => call.method === 'POST'
      && call.url === '/api/trackers/settings');

    assert.equal(write.payload.externalId, null);
    assert.equal(write.payload.settings['grigdesk-b24'].accessToken, 'cloud-draft');
  });

test('TRACKER-SETTINGS-07: проверка из каталога, обновление выбранного драйвера с подтверждением',
  async (t) => {
    const catalog = trackerCatalog();

    catalog.drivers.find((driver) => driver.id === 'grigdesk-b24-discript').schema = {
      endpoint: { type: 'string', label: 'Адрес подключения' },
    };

    const card = await mountTrackerBoard(t, {
      catalog,
      handlers: {
        get: async (_url, state) => {
          state.installed ??= driverInstallInfo('1.0.0', 1, null, { restartRequired: false });
          state.settings.externalId = 'grigdesk-b24-discript';
        },
        post: async (url, _payload, state) => {
          if (url.endsWith('/check')) {
            state.installed.updateAvailable = true;
            state.installed.latest = { version: '1.1.0', tag: 'v1.1.0', sha: 'c'.repeat(40) };
            state.installed.checkedAt = '2026-01-01T00:00:00.000Z';
          }
        },
      },
    });

    await openTrackerSettings(card);
    assert.match(card.wrapper.text(), /Установлена версия 1\.0\.0/u);
    assert.equal(actionButton(card.wrapper, /^Обновить$/u).element.disabled, true);
    assert.equal(card.apiCalls.some((call) => call.url.endsWith('/check')), false);
    await card.wrapper.find('input[type="text"]').setValue('unsaved-endpoint');
    await actionButton(card.wrapper, /^Проверить обновления$/u).trigger('click');
    await card.flushPromises();
    assert.match(card.wrapper.text(), /Доступна версия 1\.1\.0/u);
    assert.equal(card.wrapper.find('input[type="text"]').element.value, 'unsaved-endpoint');
    assert.equal(actionButton(card.wrapper, /^Обновить$/u).element.disabled, false);
    assert.equal(card.apiCalls.some((call) => call.url === '/api/trackers/settings'
      && call.method === 'POST'), false);
    await actionButton(card.wrapper, /^Обновить$/u).trigger('click');
    await card.flushPromises();

    const installer = liveTrackerDialog(card);

    assert.match(installer.text(), /1\.0\.0\s*→\s*1\.1\.0/u);
    assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/update')).length, 1);
    assert.equal(card.apiCalls.find((call) => call.url.endsWith('/update')).url,
      '/api/driver-installs/drivers/grigdesk-b24-discript/update');
    assert.equal(card.apiCalls.some((call) => call.url.endsWith('/apply')), false);
  });

test('TRACKER-SETTINGS-08: ошибка проверки обновлений оставляет параметры выбранного драйвера открытыми',
  async (t) => {
    const card = await mountTrackerBoard(t, {
      handlers: {
        post: async (url) => {
          if (url.endsWith('/check')) {
            throw new Error('Источник обновлений недоступен');
          }
        },
      },
    });

    await openTrackerSettings(card);
    await card.wrapper.find('input[type="password"]').setValue('kept-draft');
    await actionButton(card.wrapper, /^Проверить обновления$/u).trigger('click');
    await card.flushPromises();
    assert.match(card.wrapper.text(), /Источник обновлений недоступен/u);
    assert.equal(card.wrapper.find('input[type="password"]').element.value, 'kept-draft');
    assert.equal(card.wrapper.find('[data-role="tracker-settings"]').exists(), true);
    assert.equal(card.apiCalls.some((call) => call.url.endsWith('/apply')), false);
  });

test('TRACKER-SETTINGS-09: Сохранить закрывает окно только после успешного ответа', async (t) => {
  const held = Promise.withResolvers();
  const card = await mountTrackerBoard(t, {
    handlers: {
      post: async (url) => {
        if (url === '/api/trackers/settings') {
          await held.promise;
        }
      },
    },
  });

  t.after(() => held.resolve());
  await openTrackerSettings(card);

  const footer = card.wrapper.get('.tracker-settings__actions');
  const buttons = footer.findAll('button');

  assert.deepEqual(buttons.map((button) => button.text()), ['Закрыть', 'Применить', 'Сохранить']);
  await actionButton(footer, /^Сохранить$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.find('[data-role="tracker-settings"]').exists(), true);
  assert.equal(actionButton(card.wrapper, /^Применить$/u).element.disabled, true);
  assert.equal(card.wrapper.get('.tracker-settings__actions button[aria-busy="true"]')
    .get('.ui-button__label').text(), 'Сохранить');
  await actionButton(card.wrapper, /^Применить$/u).trigger('click');
  assert.equal(card.apiCalls.filter((call) => call.url === '/api/trackers/settings'
    && call.method === 'POST').length, 1);
  held.resolve();
  await card.flushPromises();
  assert.equal(card.wrapper.find('[data-role="tracker-settings"]').exists(), false);
});

test('TRACKER-SETTINGS-10: Применить оставляет окно и обновляет базу для следующих изменений', async (t) => {
  const original = 'https://original.fixture';
  const card = await mountTrackerBoard(t, {
    handlers: {
      get: async (url, state) => {
        if (url === '/api/trackers/settings') {
          state.settings.settings['grigdesk-b24'] ??= { baseUrl: original };
        }
      },
    },
  });

  await openTrackerSettings(card);
  await card.wrapper.get('input[type="text"]').setValue('https://updated.fixture');
  await actionButton(card.wrapper, /^Применить$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.find('[data-role="tracker-settings"]').exists(), true);
  assert.equal(card.wrapper.get('input[type="text"]').element.value, 'https://updated.fixture');
  assert.match(card.wrapper.text(), /Настройки доски сохранены/u);
  await card.wrapper.get('input[type="text"]').setValue(original);
  await actionButton(card.wrapper, /^Применить$/u).trigger('click');
  await card.flushPromises();

  const writes = card.apiCalls.filter((call) => call.url === '/api/trackers/settings'
    && call.method === 'POST');

  assert.equal(writes.length, 2);
  assert.equal(writes[0].payload.expectedRevision, 1);
  assert.equal(writes[1].payload.expectedRevision, 2);
  assert.equal(writes[1].payload.settings['grigdesk-b24'].baseUrl, original);
  assert.equal(card.wrapper.find('[data-role="tracker-settings"]').exists(), true);
  await actionButton(card.wrapper, /^Сохранить$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.find('[data-role="tracker-settings"]').exists(), false);
});

test('TRACKER-SETTINGS-11: отказ записи оставляет окно и черновик для обоих действий', async (t) => {
  for (const label of ['Применить', 'Сохранить']) {
    await t.test(label, async (subtest) => {
      const card = await mountTrackerBoard(subtest, {
        handlers: {
          post: async (url) => {
            if (url === '/api/trackers/settings') {
              throw new migrationHarness.ApiError('Не удалось сохранить настройки', 409);
            }
          },
        },
      });

      await openTrackerSettings(card);
      await card.wrapper.get('input[type="text"]').setValue('https://kept.fixture');
      await actionButton(card.wrapper, new RegExp(`^${label}$`, 'u')).trigger('click');
      await card.flushPromises();
      assert.equal(card.wrapper.find('[data-role="tracker-settings"]').exists(), true);
      assert.equal(card.wrapper.get('input[type="text"]').element.value, 'https://kept.fixture');
      assert.match(card.wrapper.text(), /Не удалось сохранить настройки/u);
      assert.equal(actionButton(card.wrapper, /^Применить$/u).element.disabled, false);
      assert.equal(actionButton(card.wrapper, /^Сохранить$/u).element.disabled, false);
    });
  }
});
