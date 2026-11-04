import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { compileModule, webFile } from './helpers/compile-vue.js';

test('вход после сетевого отказа восстанавливается без нового перехода online', async (t) => {
  let calls = 0;

  globalThis.__authRecoveryShell = { present: true, status: 'online' };
  globalThis.__authRecoveryApi = {
    get: async () => {
      calls += 1;

      if (calls < 5) {
        throw new TypeError('Сетевой отказ фикстуры');
      }

      return { configured: true, authenticated: true, clientScope: 'fixture' };
    },
  };
  const { useAuthStore } = await compileModule(webFile('src/stores/auth.ts'), {
    stubs: {
      './shell.ts': 'export const useShellStore = () => globalThis.__authRecoveryShell;',
      '../shared/apiClient.ts': 'export const api = globalThis.__authRecoveryApi;',
    },
  });
  const auth = useAuthStore(createPinia());

  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    auth.stopRecovery();
    delete globalThis.__authRecoveryApi;
    delete globalThis.__authRecoveryShell;
  });
  await auth.load('shell-online');
  assert.equal(auth.recovering, true);

  for (const delay of [1000, 1000, 1000, 2000]) {
    const before = calls;

    t.mock.timers.tick(delay - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, before);
    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, before + 1);
  }

  assert.equal(auth.authenticated, true);
  assert.equal(auth.recovering, false);
  assert.equal(auth.retryAt, 0);
  assert.equal(auth.retryAttempt, 0);
  globalThis.__authRecoveryApi.get = async () => {
    calls += 1;
    throw new TypeError('Повторный сетевой отказ');
  };
  await auth.load();
  globalThis.__authRecoveryShell.status = 'locked';

  const before = calls;

  t.mock.timers.tick(30000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, before, 'Блокировка ключа не обходится повтором GET');
});
