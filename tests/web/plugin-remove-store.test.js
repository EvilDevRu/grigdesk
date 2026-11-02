import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../../web/src/shared/apiClient.ts';
import { decodeInstallRemoval, PluginInstallProtocolError } from '../../web/src/shared/pluginInstallApi.ts';
import { pluginInstallStoreFixture, deferredInstallResponse } from './helpers/pluginInstallStoreFixture.js';
import { webInstallJob } from './helpers/pluginInstallFixtures.js';

const url = 'POST /api/plugin-installs/plugins/demo/remove';

test('Подтверждение удаления проверяет id и тип restartRequired', () => {
  assert.deepEqual(decodeInstallRemoval({
    id: 'demo',
    restartRequired: true,
    extra: 1,
  }, 'demo'), {
    id: 'demo', restartRequired: true,
  });

  for (const value of [null, {}, { id: 'other', restartRequired: true },
    { id: 'demo', restartRequired: 'true' }, { id: '../demo', restartRequired: true }]) {
    assert.throws(() => decodeInstallRemoval(value, 'demo'), PluginInstallProtocolError);
  }
});

test('Удаление запирает повторный клик и обновляет каталог после подтверждения', async (t) => {
  const f = pluginInstallStoreFixture(t);
  const store = f.newStore();
  const wait = deferredInstallResponse(t);

  store.job = webInstallJob('done');
  f.handlers.set(url, () => wait.promise);

  const first = store.remove('demo');

  assert.equal(store.busy, true);
  assert.equal(store.pendingAction, 'remove');
  assert.equal(await store.remove('demo'), false);
  await store.loadJob();
  assert.equal(f.calls.length, 1);
  wait.resolve({ id: 'demo', restartRequired: true });
  assert.equal(await first, true);
  assert.equal(store.job, null);
  assert.equal(store.busy, false);
  assert.equal(store.pendingAction, null);
  assert.equal(f.loads, 1);
});

test('Удаление блокируется незавершённым заданием и recovery', async (t) => {
  const f = pluginInstallStoreFixture(t);
  const store = f.newStore();

  for (const status of ['running', 'ready', 'applying', 'recovery_required']) {
    store.job = webInstallJob(status);
    assert.equal(await store.remove('demo'), false);
  }

  store.job = null;
  store.recoveryError = { code: 'recovery_required', message: 'Восстановление' };
  assert.equal(await store.remove('demo'), false);
  assert.equal(f.calls.length, 0);
});

test('Отказ и потерянный ответ видны без повторного POST или ложного успеха', async (t) => {
  const f = pluginInstallStoreFixture(t);
  const store = f.newStore();

  for (const cause of [new ApiError('Плагин занят', 409, {}), new Error('Ответ потерян')]) {
    f.handlers.set(url, () => {
      throw cause;
    });

    assert.equal(await store.remove('demo'), false);
    assert.equal(store.error, cause.message);
    assert.equal(store.busy, false);
    assert.equal(store.pendingAction, null);
  }

  assert.equal(f.calls.length, 2);
  assert.equal(f.loads, 2);
});

test('Поздний ответ после dispose не обновляет каталог', async (t) => {
  const f = pluginInstallStoreFixture(t);
  const store = f.newStore();
  const wait = deferredInstallResponse(t);

  f.handlers.set(url, () => wait.promise);

  const removal = store.remove('demo');

  store.$dispose();
  wait.resolve({ id: 'demo', restartRequired: true });
  assert.equal(await removal, false);
  assert.equal(f.loads, 0);
});
