import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { selectTracker, trackerFixture, writeTracker } from './helpers/trackerFixture.js';

const validToken = 'ATATTopaque==segment:fixture!';

/**
 * Подлинность токена определяет драйвер: даже пароль допустимого алфавита получает отказ.
 * Оба прежних имени полей используют ту же семантику схемы, без списка vendor id в ядре.
 */
async function tokenFixture(t, key, conditional = false) {
  return trackerFixture(t, {
    setup: (config) => writeTracker(config, 'fixture-token', {
      manifest: {
        settings: {
          authMode: {
            type: 'select',
            options: [
              { value: 'token', label: { text: 'Токен' } },
              { value: 'password', label: { text: 'Пароль' } },
            ],
          },
          [key]: {
            type: 'string',
            secret: true,
            required: true,
            label: { key: 'core.trackerAccessToken' },
            ...(conditional ? { visibleIf: { field: 'authMode', equals: 'token' } } : {}),
          },
          password: { type: 'string', secret: true },
        },
      },
      code: `
        export default (host) => ({
          id: 'fixture-token',
          capabilities: {},
          isConfigured: () => true,
          taskDetail: async () => null,
          testAuth: async () => host.credentials.read()?.${key} === ${JSON.stringify(validToken)}
            ? { ok: true } : { ok: false, error: 'Ключ отклонён' },
        });
      `,
    }),
  });
}

for (const key of ['accessToken', 'apiToken']) {
  test(`${key}: пароль не записывается, правильный токен сохраняется после проверки`, async (t) => {
    const fixture = await tokenFixture(t, key);

    for (const value of ['password123', 'Pass!word', 'Bearer token', '']) {
      const response = await fixture.request('POST', '/api/trackers/settings', {
        externalId: 'fixture-token',
        expectedRevision: 0,
        settings: { 'fixture-token': { [key]: value } },
      });

      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error, 'tracker_token_invalid');
      assert.equal(response.json().field, key);
      assert.equal(response.json().driverId, 'fixture-token');
      assert.equal(fixture.credsStore.readFor('fixture-token'), null);
      assert.equal(fixture.runtime.selection.read().revision, 0);
      assert.equal(fixture.events.length, 0);
    }

    await selectTracker(fixture, 'fixture-token', { 'fixture-token': { [key]: validToken } });
    assert.equal(fixture.credsStore.readFor('fixture-token')[key], validToken);

    const before = await readFile(fixture.config.trackerCredentialsPath, 'utf8');

    await selectTracker(fixture, 'fixture-token', { 'fixture-token': { [key]: '' } });
    assert.equal(await readFile(fixture.config.trackerCredentialsPath, 'utf8'), before);
    assert.equal(fixture.logs.join('').includes(validToken), false);
  });
}

test('Проверка соединения отклоняет формат до исполнения драйвера', async (t) => {
  const fixture = await tokenFixture(t, 'apiToken');
  const response = await fixture.request('POST', '/api/trackers/test-connection', {
    driverId: 'fixture-token',
    expectedRevision: 0,
    settings: { apiToken: 'Пароль с пробелом!' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().field, 'apiToken');
  assert.equal(fixture.runtime.registry.isLoaded('fixture-token'), false);
  assert.equal(response.body.includes('Пароль с пробелом!'), false);
});

test('Настройки всех драйверов проверяются до первой сетевой пробы токена', async (t) => {
  const fixture = await tokenFixture(t, 'apiToken');
  const response = await fixture.request('POST', '/api/trackers/settings', {
    externalId: 'fixture-token',
    expectedRevision: 0,
    settings: {
      'fixture-token': { apiToken: validToken },
      'missing-driver': {},
    },
  });

  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error, 'invalid_request');
  assert.equal(fixture.runtime.registry.isLoaded('fixture-token'), false);
  assert.equal(fixture.credsStore.readFor('fixture-token'), null);
  assert.equal(fixture.runtime.selection.read().revision, 0);
  assert.equal(fixture.events.length, 0);
});

test('Режим пароля сохраняет пароль без токенных ограничений и проверки скрытого секрета', async (t) => {
  const fixture = await tokenFixture(t, 'accessToken', true);

  fixture.credsStore.writeFor('fixture-token', { accessToken: 'старый неверный пароль!' });
  await selectTracker(fixture, 'fixture-token', {
    'fixture-token': { authMode: 'password', password: 'Пароль с пробелами!' },
  });
  assert.equal(fixture.credsStore.readFor('fixture-token').password, 'Пароль с пробелами!');
});

test('Сохранённый секрет нестандартного формата не блокирует сохранение других реквизитов', async (t) => {
  const fixture = await tokenFixture(t, 'apiToken');

  // Токен с '=' внутри строки сохранила прежняя версия сервера без форматной проверки.
  fixture.credsStore.writeFor('fixture-token', { apiToken: 'Abc123==extra0' });

  const response = await fixture.request('POST', '/api/trackers/settings', {
    externalId: 'fixture-token',
    expectedRevision: 0,
    settings: { 'fixture-token': { apiToken: '', password: 'Пароль с пробелами!' } },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().revision, 1);
  assert.equal(fixture.credsStore.readFor('fixture-token').apiToken, 'Abc123==extra0');
  assert.equal(fixture.credsStore.readFor('fixture-token').password, 'Пароль с пробелами!');
});

test('Проверка соединения при пустом вводе доходит до драйвера со старым секретом', async (t) => {
  const fixture = await tokenFixture(t, 'apiToken');

  fixture.credsStore.writeFor('fixture-token', { apiToken: 'Abc123==extra0' });

  const response = await fixture.request('POST', '/api/trackers/test-connection', {
    driverId: 'fixture-token',
    expectedRevision: 0,
    settings: { apiToken: '' },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, false);
  assert.equal(response.json().error, 'Ключ отклонён');
});
