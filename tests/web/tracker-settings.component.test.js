import assert from 'node:assert/strict';
import test from 'node:test';

import { migrationHarness } from './helpers/compile-vue.js';
import {
  actionButton, chooseExternal, mountTrackerBoard, openTrackerSettings,
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

    const save = actionButton(card.wrapper, /сохранить|save/iu);

    assert.ok(save);
    await save.trigger('click');
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

test('TRACKER-INSTALL-UI-01: repo/tag, review, apply, update и rollback через отдельный API', async (t) => {
  const preparing = Promise.withResolvers();
  const applying = Promise.withResolvers();
  const card = await mountTrackerBoard(t, {
    handlers: {
      post: async (url) => {
        if (url === '/api/driver-installs/jobs') {
          await preparing.promise;
        }

        if (url.endsWith('/apply')) {
          await applying.promise;
        }
      },
    },
  });

  t.after(() => {
    preparing.resolve();
    applying.resolve();
  });

  await openTrackerSettings(card);

  const install = actionButton(card.wrapper, /^\s*(?:установить|install)\s*$/iu);

  assert.ok(install);
  await install.trigger('click');
  await card.flushPromises();

  const dialog = card.wrapper.findAll('[role="dialog"]').at(-1);

  assert.ok(dialog, 'Установка открывается поверх настроек в отдельном диалоге');
  await dialog.find('[data-role="driver-custom-source"]').trigger('click');

  const repo = dialog.find('input[type="url"], input[name="url"], input[name="repo"]');

  assert.ok(repo.exists());
  await repo.setValue('https://git.fixture/driver.git');

  const tag = dialog.find('input[name="tag"], input[name="version"]');

  assert.ok(tag.exists());
  await tag.setValue('v1.0.0');

  const prepare = actionButton(dialog, /^\s*(?:проверить пакет|review package)\s*$/iu);

  assert.ok(prepare);
  await prepare.trigger('click');
  await prepare.trigger('click');
  assert.equal(card.apiCalls.filter((call) => call.url === '/api/driver-installs/jobs').length, 1);
  assert.equal(card.apiCalls.some((call) => call.url.endsWith('/apply')), false);
  preparing.resolve();
  await card.flushPromises();
  assert.ok(dialog.text().includes('1.0.0'));
  assert.ok(dialog.text().includes('b'.repeat(64)));

  const applyLabel = /^\s*(?:применить|apply)\s*$/iu;
  const apply = actionButton(dialog, applyLabel);

  assert.ok(apply);
  await apply.trigger('click');
  await apply.trigger('click');
  assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/apply')).length, 1);
  applying.resolve();
  await card.flushPromises();
  assert.match(dialog.text(), /перезапуск|restart/iu);
  assert.equal(card.state.installed.version, '1.0.0');

  const update = actionButton(dialog, /обновить|update/iu);

  assert.ok(update);
  await update.trigger('click');
  await card.flushPromises();
  assert.ok(card.apiCalls.some((call) => call.url.endsWith('/update')));
  assert.equal(card.state.job.status, 'ready');
  assert.equal(card.state.installed.version, '1.0.0');
  assert.match(dialog.text(), /1\.1\.0/u);
  assert.ok(dialog.text().includes('e'.repeat(64)));

  const applyUpdate = actionButton(dialog, applyLabel);

  assert.ok(applyUpdate);
  await applyUpdate.trigger('click');
  await card.flushPromises();
  assert.equal(card.apiCalls.filter((call) => call.url.endsWith('/apply')).length, 2);
  assert.equal(card.state.installed.version, '1.1.0');
  assert.match(dialog.text(), /перезапуск|restart/iu);

  const installed = structuredClone(card.state.installed);
  const rollback = actionButton(dialog, /откатить|rollback/iu);

  assert.ok(rollback);
  await rollback.trigger('click');
  await card.flushPromises();

  const checkIndex = card.apiCalls.findIndex((call) => call.url === '/api/driver-installs/check');
  const rollbackIndex = card.apiCalls.findIndex((call) => call.url.endsWith('/rollback'));
  const request = card.apiCalls[rollbackIndex];

  assert.ok(checkIndex >= 0 && rollbackIndex > checkIndex);
  assert.deepEqual(request.payload, {
    requestId: request.payload.requestId,
    expectedRevision: installed.revision,
    expectedPreviousDigest: installed.previous.payloadDigest,
  });
  assert.match(request.payload.requestId, /^[a-f0-9-]{36}$/u);
  assert.notEqual(request.payload.expectedPreviousDigest, installed.payloadDigest);
  assert.equal(card.state.installed.version, '1.0.0');
  assert.equal(card.state.job.kind, 'rollback');
  assert.equal(card.state.job.status, 'done');
  assert.match(dialog.text(), /1\.0\.0/u);
  assert.match(dialog.text(), /перезапуск|restart/iu);

  assert.equal(card.apiCalls.some((call) => call.url.includes('plugin-installs')), false);
});

test('TRACKER-SETTINGS-02: ошибка установки сохраняет выбор и введённый repo/tag', async (t) => {
  const card = await mountTrackerBoard(t, {
    handlers: {
      post: async (url) => {
        if (url === '/api/driver-installs/jobs') {
          throw new Error('Репозиторий недоступен');
        }
      },
    },
  });

  await openTrackerSettings(card);
  await actionButton(card.wrapper, /^\s*(?:установить|install)\s*$/iu).trigger('click');
  await card.flushPromises();
  await card.wrapper.find('[data-role="driver-custom-source"]').trigger('click');

  const repo = card.wrapper.find('input[type="url"], input[name="url"], input[name="repo"]');
  const tag = card.wrapper.find('input[name="tag"], input[name="version"]');

  await repo.setValue('https://git.fixture/unavailable.git');
  await tag.setValue('v1.0.0');
  await actionButton(card.wrapper, /^\s*(?:проверить пакет|review package)\s*$/iu).trigger('click');
  await card.flushPromises();
  assert.match(card.wrapper.text(), /Репозиторий недоступен/u);
  assert.equal(repo.element.value, 'https://git.fixture/unavailable.git');
  assert.equal(tag.element.value, 'v1.0.0');
  assert.equal(card.state.catalog.externalId, null);
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
