import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  actionButton, chooseExternal, mountTrackerBoard, openTrackerSettings, trackerCatalog,
} from './helpers/trackerBoard.js';

const schema = {
  authMode: {
    type: 'select',
    label: { key: 'core.trackerAuthMode' },
    options: [
      { value: 'token', label: { key: 'core.trackerAuthToken' } },
      { value: 'password', label: { key: 'core.trackerAuthPassword' } },
    ],
  },
  accessToken: {
    type: 'string',
    secret: true,
    label: { key: 'core.trackerAccessToken' },
    visibleIf: { field: 'authMode', equals: 'token' },
  },
  login: {
    type: 'string',
    label: { key: 'core.trackerLogin' },
    visibleIf: { field: 'authMode', equals: 'password' },
  },
  password: {
    type: 'string',
    secret: true,
    label: { key: 'core.trackerPassword' },
    visibleIf: { field: 'authMode', equals: 'password' },
  },
};

/**
 * Выбирает режим через видимый комбобокс и настоящее меню UiSelect.
 * Скрытый native select не получает синтетических изменений в этой проверке.
 */
async function chooseMode(card, label) {
  const trigger = card.wrapper.findAll('button[role="combobox"]').at(-1);

  assert.ok(trigger);
  await trigger.trigger('click');
  await card.flushPromises();

  const option = [...card.browser.document.querySelectorAll('[role="option"]')]
    .find((element) => element.textContent.trim() === label);

  assert.ok(option, label);
  option.click();
  await card.flushPromises();
}

test('Режим подключения: комбобокс, видимость, черновики и фильтрация POST', async (t) => {
  const catalog = trackerCatalog();

  catalog.drivers.find((driver) => driver.id === 'grigdesk-b24').schema = schema;

  const card = await mountTrackerBoard(t, { catalog });

  await openTrackerSettings(card);
  await chooseExternal(card, 'grigdesk-b24');
  assert.equal(card.wrapper.findAll('button[role="combobox"]').length, 2);
  assert.equal(card.wrapper.findAll('input[type="password"]').length, 0);
  await chooseMode(card, 'Токен доступа');
  await card.wrapper.find('input[type="password"]').setValue('token-draft');
  await chooseMode(card, 'Логин и пароль');
  assert.equal(card.wrapper.findAll('input[type="password"]').length, 1);
  await card.wrapper.find('input[type="text"]').setValue('fixture-login');
  await card.wrapper.find('input[type="password"]').setValue('password-draft');
  await actionButton(card.wrapper, /сохранить|save/iu).trigger('click');
  await card.flushPromises();

  const writes = () => card.apiCalls.filter((call) => call.url === '/api/trackers/settings'
    && call.method === 'POST');

  assert.deepEqual(writes().at(-1).payload.settings['grigdesk-b24'], {
    authMode: 'password',
    login: 'fixture-login',
    password: 'password-draft',
  });
  await chooseMode(card, 'Токен доступа');
  assert.equal(card.wrapper.find('input[type="password"]').element.value, 'token-draft');
  assert.equal(card.wrapper.find('input[type="text"]').exists(), false);
  await actionButton(card.wrapper, /сохранить|save/iu).trigger('click');
  await card.flushPromises();
  assert.deepEqual(writes().at(-1).payload.settings['grigdesk-b24'], {
    authMode: 'token',
    accessToken: 'token-draft',
  });
});

test('Подписи способов подключения и полей доступны в обоих каталогах', async () => {
  for (const locale of ['ru', 'en']) {
    const catalog = JSON.parse(await readFile(
      new URL(`../../shared/i18n/assets/locales/${locale}/core.json`, import.meta.url), 'utf8',
    ));

    for (const key of ['trackerAuthMode', 'trackerAuthToken', 'trackerAuthPassword',
      'trackerLogin', 'trackerPassword', 'trackerAccessToken', 'trackerChooseOption']) {
      assert.equal(typeof catalog[key], 'string', `${locale}.${key}`);
      assert.ok(catalog[key].trim());
    }
  }
});
