import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionButton, mountTrackerBoard, openTrackerSettings, trackerCatalog,
} from './helpers/trackerBoard.js';

process.env.NODE_ENV = 'test';

/**
 * Адрес объявлен общей подписью у разных драйверов и под разными именами поля.
 * Обычная строка и секрет рядом проверяют границы автоматического преобразования.
 */
function portalCatalog() {
  const catalog = trackerCatalog();
  const portal = { type: 'string', label: { key: 'core.trackerPortal' } };

  catalog.drivers[1].schema.baseUrl = portal;
  catalog.drivers[1].schema.login = { type: 'string', label: { text: 'Логин' } };
  catalog.drivers[2].schema = {
    endpoint: portal,
    password: {
      type: 'string',
      secret: true,
      label: { key: 'core.trackerPassword' },
    },
    attempts: { type: 'number', label: { text: 'Попытки' } },
    enabled: { type: 'boolean', label: { text: 'Флаг' } },
  };

  return catalog;
}

test('Адрес получает HTTPS после выхода из поля, явные схемы и пустота сохраняются', async (t) => {
  const card = await mountTrackerBoard(t, { catalog: portalCatalog() });

  await openTrackerSettings(card);

  const address = card.wrapper.findAll('input[type="text"]')[0];

  for (const [input, expected] of [
    ['portal.fixture', 'https://portal.fixture'],
    ['  portal.fixture:8443/path?q=1#part  ', 'https://portal.fixture:8443/path?q=1#part'],
    ['localhost:8080', 'https://localhost:8080'],
    ['[::1]:8443/path', 'https://[::1]:8443/path'],
    ['//portal.fixture/path', 'https://portal.fixture/path'],
    ['http://portal.fixture:8080/path', 'http://portal.fixture:8080/path'],
    ['https://portal.fixture/path', 'https://portal.fixture/path'],
    ['ftp://portal.fixture/path', 'ftp://portal.fixture/path'],
    ['mailto:person@fixture.invalid', 'mailto:person@fixture.invalid'],
    ['', ''],
    ['   ', ''],
  ]) {
    await address.setValue(input);
    assert.equal(address.element.value, input);
    await address.trigger('blur');
    assert.equal(address.element.value, expected);
  }

  const login = card.wrapper.findAll('input[type="text"]')[1];
  const secret = card.wrapper.get('input[type="password"]');

  await login.setValue(' user@fixture.invalid ');
  await login.trigger('blur');
  await secret.setValue(' secret-with-spaces ');
  await secret.trigger('blur');
  assert.equal(login.element.value, ' user@fixture.invalid ');
  assert.equal(secret.element.value, ' secret-with-spaces ');
  assert.equal(card.apiCalls.some((call) => call.method === 'POST'), false);
});

test('Проверка соединения дополняет адрес даже без выхода из поля', async (t) => {
  const card = await mountTrackerBoard(t, {
    catalog: portalCatalog(),
    handlers: {
      post: async (url) => url === '/api/trackers/test-connection' ? { ok: true } : undefined,
    },
  });

  await openTrackerSettings(card);
  await card.wrapper.findAll('input[type="text"]')[0].setValue('portal.fixture/path');
  await card.wrapper.get('[data-role="tracker-test-connection"]').trigger('click');
  await card.flushPromises();

  const writes = card.apiCalls.filter((call) => call.method === 'POST');

  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/trackers/test-connection');
  assert.equal(writes[0].payload.settings.baseUrl, 'https://portal.fixture/path');
  assert.match(card.wrapper.get('[data-role="tracker-connection-result"]').text(),
    /Соединение.*установлено/u);
});

test('Сохранение дополняет адреса всех черновиков и сохраняет типы остальных полей', async (t) => {
  const card = await mountTrackerBoard(t, { catalog: portalCatalog() });

  await openTrackerSettings(card);
  await card.wrapper.findAll('input[type="text"]')[0].setValue('cloud.fixture');
  await card.wrapper.findAll('input[type="text"]')[1].setValue('login.fixture');
  await card.wrapper.get('[data-driver="grigdesk-b24-discript"]').trigger('click');
  await card.flushPromises();
  await card.wrapper.findAll('input[type="text"]')[0].setValue('http://local.fixture:8080');
  await card.wrapper.findAll('input[type="text"]')[1].setValue('3');
  await card.wrapper.get('input[type="password"]').setValue(' password.fixture ');
  await actionButton(card.wrapper, /^Сохранить$/u).trigger('click');
  await card.flushPromises();

  const write = card.apiCalls.find((call) => call.method === 'POST'
    && call.url === '/api/trackers/settings');

  assert.ok(write);
  assert.equal(write.payload.settings['grigdesk-b24'].baseUrl, 'https://cloud.fixture');
  assert.equal(write.payload.settings['grigdesk-b24'].login, 'login.fixture');
  assert.deepEqual(write.payload.settings['grigdesk-b24-discript'], {
    endpoint: 'http://local.fixture:8080',
    password: ' password.fixture ',
    attempts: 3,
    enabled: false,
  });
});
