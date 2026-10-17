import assert from 'node:assert/strict';
import test from 'node:test';

import { requireProtectedStorage } from '../../desktop/src/storageProtection.ts';

/**
 * Подмена явно записывает порядок проверок доступности и выбранного backend.
 * Это не позволяет отказу пройти до обращения к системному API по другой причине.
 */
function storageFixture(backend, available = true) {
  const calls = [];

  return {
    calls,
    storage: {
      isEncryptionAvailable: () => {
        calls.push('available');

        return available;
      },
      getSelectedStorageBackend: () => {
        calls.push('backend');

        return backend;
      },
    },
  };
}

test('DW-Q1: защищённые backend разрешены', () => {
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    const fixture = storageFixture(backend);

    assert.doesNotThrow(() => requireProtectedStorage(fixture.storage));
    assert.deepEqual(fixture.calls, ['available', 'backend']);
  }
});

test('DW-Q2: basic_text и unknown отвергнуты даже при доступности', () => {
  for (const backend of ['basic_text', 'unknown', '', 'new_backend']) {
    const fixture = storageFixture(backend);

    assert.throws(() => requireProtectedStorage(fixture.storage), /защищённое хранилище/u);
    assert.deepEqual(fixture.calls, ['available', 'backend']);
  }
});

test('DW-Q3: недоступный или бросающий storage отказывает до профиля', () => {
  const unavailable = storageFixture('gnome_libsecret', false);

  assert.throws(() => requireProtectedStorage(unavailable.storage), /защищённое хранилище/u);
  assert.deepEqual(unavailable.calls, ['available']);

  for (const method of ['isEncryptionAvailable', 'getSelectedStorageBackend']) {
    const fixture = storageFixture('gnome_libsecret');

    fixture.storage[method] = () => {
      throw new Error('Тестовый отказ системного API');
    };
    assert.throws(() => requireProtectedStorage(fixture.storage), /защищённое хранилище/u);
  }

  assert.throws(() => requireProtectedStorage({ isEncryptionAvailable: () => true }),
    /защищённое хранилище/u);
});
