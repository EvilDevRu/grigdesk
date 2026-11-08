import assert from 'node:assert/strict';
import test from 'node:test';

import { migrationHarness } from './helpers/compile-vue.js';
import {
  actionButton, chooseExternal, mountTrackerBoard, openTrackerSettings, trackerCatalog,
} from './helpers/trackerBoard.js';

process.env.NODE_ENV = 'test';

/**
 * Прежний пакет объявляет назначение токена общей подписью, без нового format.
 * Наличие пароля рядом доказывает, что ограничения не применяются ко всем секретам.
 */
function tokenCatalog() {
  const catalog = trackerCatalog();
  const schema = catalog.drivers.find((driver) => driver.id === 'grigdesk-b24').schema;

  schema.accessToken.label = { key: 'core.trackerAccessToken' };
  schema.password = {
    type: 'string',
    secret: true,
    label: { key: 'core.trackerPassword' },
  };

  return catalog;
}

test('Ошибка формата видна у токена, блокирует отправку и исчезает после исправления', async (t) => {
  const card = await mountTrackerBoard(t, { catalog: tokenCatalog() });

  await openTrackerSettings(card);

  const token = card.wrapper.findAll('input[type="password"]')[0];
  const password = card.wrapper.findAll('input[type="password"]')[1];

  assert.match(card.wrapper.text(), /Нужен API-токен/u);
  await password.setValue('Обычный пароль!');
  assert.equal(password.attributes('aria-invalid'), undefined);
  await token.setValue('Ввёл пароль!');
  assert.equal(token.attributes('aria-invalid'), 'true', card.wrapper.text());
  assert.match(card.wrapper.get('.ui-field__error').text(), /API-токен целиком/u);
  assert.equal(actionButton(card.wrapper, /^Сохранить$/u).element.disabled, true);
  assert.equal(card.wrapper.get('[data-role="tracker-test-connection"]').element.disabled, true);
  assert.equal(card.apiCalls.some((call) => call.method === 'POST'), false);
  await token.setValue('ATATT' + 'a'.repeat(187));
  assert.equal(token.attributes('aria-invalid'), undefined);
  assert.equal(actionButton(card.wrapper, /^Сохранить$/u).element.disabled, false);
});

test('Непрозрачный токен с внутренним = проходит проверку и сохранение без изменений', async (t) => {
  const card = await mountTrackerBoard(t, {
    catalog: tokenCatalog(),
    handlers: {
      post: async (url) => url === '/api/trackers/test-connection' ? { ok: true } : undefined,
    },
  });
  const value = 'ATATTopaque==segment:fixture!';

  await openTrackerSettings(card);
  await card.wrapper.findAll('input[type="password"]')[0].setValue(value);

  assert.equal(card.wrapper.findAll('input[type="password"]')[0].attributes('aria-invalid'), undefined);
  assert.equal(card.wrapper.get('[data-role="tracker-test-connection"]').element.disabled, false);
  await card.wrapper.get('[data-role="tracker-test-connection"]').trigger('click');
  await card.flushPromises();
  assert.equal(card.apiCalls.find((call) => call.url === '/api/trackers/test-connection')
    .payload.settings.accessToken, value);
  await actionButton(card.wrapper, /^Сохранить$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.apiCalls.find((call) => call.url === '/api/trackers/settings' && call.method === 'POST')
    .payload.settings['grigdesk-b24'].accessToken, value);
});

test('Отказ подлинности отмечает поле и сохраняет введённый черновик', async (t) => {
  const card = await mountTrackerBoard(t, {
    catalog: tokenCatalog(),
    handlers: {
      post: async (url) => {
        if (url === '/api/trackers/settings') {
          throw new migrationHarness.ApiError('Нужен API-токен, а не пароль', 400, {
            error: 'tracker_token_invalid',
            driverId: 'grigdesk-b24',
            field: 'accessToken',
          });
        }
      },
    },
  });

  await openTrackerSettings(card);

  const token = card.wrapper.findAll('input[type="password"]')[0];

  await token.setValue('password123');
  await actionButton(card.wrapper, /^Сохранить$/u).trigger('click');
  await card.flushPromises();

  const failedToken = card.wrapper.findAll('input[type="password"]')[0];

  assert.equal(failedToken.element.value, 'password123');
  assert.equal(failedToken.attributes('aria-invalid'), 'true');
  assert.match(card.wrapper.get('.ui-field__error').text(), /а не пароль/u);
  assert.equal(card.state.catalog.externalId, null);
  await failedToken.setValue('new-valid-token');
  assert.equal(card.wrapper.findAll('input[type="password"]')[0].attributes('aria-invalid'), undefined);
});

test('Чип показывает сохранённый драйвер независимо от редактора и флажка черновика', async (t) => {
  const catalog = trackerCatalog();

  catalog.externalId = 'grigdesk-b24';

  const card = await mountTrackerBoard(t, { catalog });

  await openTrackerSettings(card);
  assert.equal(card.wrapper.findAll('[data-role="tracker-in-use"]').length, 1);
  assert.equal(card.wrapper.get('[data-driver="grigdesk-b24"] [data-role="tracker-in-use"]').text(),
    'Используется');
  await chooseExternal(card, 'grigdesk-b24-discript');
  assert.equal(card.wrapper.get('[data-driver="grigdesk-b24"] [data-role="tracker-in-use"]').exists(), true);
  assert.equal(card.wrapper.find('[data-driver="grigdesk-b24-discript"] [data-role="tracker-in-use"]')
    .exists(), false);
  assert.equal(card.wrapper.find('[data-role="tracker-editor-in-use"]').exists(), false);
  await actionButton(card.wrapper, /^Сохранить$/u).trigger('click');
  await card.flushPromises();
  assert.equal(card.wrapper.find('[data-driver="grigdesk-b24"] [data-role="tracker-in-use"]')
    .exists(), false);
  assert.equal(card.wrapper.get('[data-driver="grigdesk-b24-discript"] [data-role="tracker-in-use"]')
    .text(), 'Используется');
  assert.equal(card.wrapper.get('[data-role="tracker-editor-in-use"]').text(), 'Используется');
});
