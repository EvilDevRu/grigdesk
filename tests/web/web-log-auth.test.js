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

test('logout меняет эпоху и старый ответ проверки не возобновляет вход', async () => {
  setActivePinia(createPinia());
  const store = useAuthStore();
  const originalGet = api.get;
  const originalPost = api.post;
  let resolveGet;
  api.get = () => new Promise((resolve) => { resolveGet = resolve; });
  api.post = async () => ({});
  try {
    const oldLoad = store.load();
    const epoch = store.logEpoch;
    await store.doLogout();
    resolveGet({ configured: true, authenticated: true, login: 'test', secure: true });
    await oldLoad;
    assert.equal(store.logEpoch, epoch + 1);
    assert.equal(store.authenticated, false);
    assert.equal(store.ready, false);
    assert.equal(store.logReason, 'logout');
  } finally {
    api.get = originalGet;
    api.post = originalPost;
  }
});
