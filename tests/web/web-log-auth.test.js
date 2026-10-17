import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';

import { api } from '../../web/src/shared/apiClient.ts';
import { useAuthStore } from '../../web/src/stores/auth.js';

test('каждый успешный auth.load подтверждает сессию независимо от boolean-флагов', async () => {
  setActivePinia(createPinia());
  const store = useAuthStore();
  const originalGet = api.get;
  api.get = async () => ({ configured: true, authenticated: true, login: 'test', secure: true });
  try {
    await store.load();
    const previous = store.logConfirmation;
    await store.load();
    assert.equal(store.authenticated, true);
    assert.equal(store.logConfirmation, previous + 1);
    assert.equal(store.logReason, 'load');
  } finally {
    api.get = originalGet;
  }
});

test('потеря сессии меняет эпоху, перезагружает документ и не возобновляет вход', async (t) => {
  setActivePinia(createPinia());
  const store = useAuthStore();
  const originalGet = api.get;
  const originalOn = api.onUnauthorized;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  let resolveGet;
  let handler;
  let reloads = 0;

  api.get = () => new Promise((resolve) => {
    resolveGet = resolve;
  });
  api.onUnauthorized = (fn) => {
    handler = fn;

    return () => {};
  };
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: {
      reload: () => {
        reloads += 1;
      },
    },
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {},
    },
  });

  t.after(() => {
    api.get = originalGet;
    api.onUnauthorized = originalOn;

    for (const [name, descriptor] of [['location', originalLocation],
      ['sessionStorage', originalStorage]]) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  store.watchUnauthorized();

  const oldLoad = store.load();
  const epoch = store.logEpoch;

  handler({});

  resolveGet({
    configured: true,
    authenticated: true,
    clientScope: 'me',
  });
  await oldLoad;

  assert.equal(store.logEpoch, epoch + 1);
  assert.equal(store.authenticated, false);
  assert.equal(store.ready, false);
  assert.equal(store.logReason, '401');
  assert.equal(reloads, 1);
});
