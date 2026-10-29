import assert from 'node:assert/strict';
import test from 'node:test';

import { installFixture } from './helpers/providerInstallFixture.js';

test('ONB-PROVIDER-BASE: refresh=1 перечитывает вход без ожидания минуты', async (t) => {
  const { app, provider, calls } = await installFixture(t);
  let authenticated = false;

  provider.auth = async () => ({
    mode: 'fixture',
    available: authenticated,
    label: authenticated ? 'Вход выполнен' : 'Нет входа',
  });

  const first = await app.inject('/api/providers');
  const before = first.json().providers.find((item) => item.id === provider.id);

  assert.equal(first.statusCode, 200, first.body);
  assert.equal(before.installed, true);
  assert.equal(before.authLabel, 'Нет входа');
  assert.equal(before.available, false);
  authenticated = true;

  const cached = await app.inject('/api/providers');
  const refreshed = await app.inject('/api/providers?refresh=1');
  const after = refreshed.json().providers.find((item) => item.id === provider.id);

  assert.equal(cached.json().providers[0].authLabel, before.authLabel);
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.equal(after.installed, true);
  assert.equal(after.authLabel, 'Вход выполнен');
  assert.equal(after.available, true);
  assert.ok(calls.models.length > 0, 'каталог моделей подменён явно');
  assert.equal(calls.commands.length, 0, 'проверка не исполняет installer');
});
