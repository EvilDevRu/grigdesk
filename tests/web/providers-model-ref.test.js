import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { api } from '../../web/src/shared/apiClient.ts';
import { useProvidersStore } from '../../web/src/stores/providers.js';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });

  return { promise, resolve };
}

/**
 * Создаёт новый стор с отдельными сетевыми ответами для реестра и лимитов.
 * Подмена API восстанавливается после сценария и не читает настоящее окружение.
 */
function credentialFixture(t) {
  setActivePinia(createPinia());

  const store = useProvidersStore();
  const original = { get: api.get, post: api.post };
  const gets = [];

  api.get = (url) => {
    const pending = deferred();

    gets.push({ url, ...pending });

    return pending.promise;
  };
  t.after(() => {
    api.get = original.get;
    api.post = original.post;
  });
  store.providers = [{ id: 'tripo', credentials: [{ env: 'KEY', preview: 'old' }] }];
  store.usage = { tripo: { resources: [{ summary: 'A', controls: [{ href: 'old-region' }] }] } };

  return { store, gets };
}

function providersFixture() {
  setActivePinia(createPinia());
  const providers = useProvidersStore();
  providers.providers = [{
    id: 'claude',
    models: [{
      id: 'claude-opus-5',
      aliases: ['opus'],
      modelRefAliases: ['claude-opus-5[1m]'],
    }],
  }];
  return providers;
}

test('versioned modelRef канонизирует только retired exact alias того же provider', () => {
  const providers = providersFixture();

  const retired = providers.modelOf({ provider: 'claude', model: 'claude-opus-5[1m]' });
  assert.equal(retired.id, 'claude-opus-5');
  assert.equal(retired.model.id, 'claude-opus-5');
  assert.equal(retired.provider.id, 'claude');

  const floating = providers.modelOf({ provider: 'claude', model: 'opus' });
  assert.equal(floating.id, 'opus');
  assert.equal(floating.model, null, 'обычный alias нельзя принимать за exact modelRef');
});

test('legacy scalar alias по-прежнему разворачивается в текущую модель', () => {
  const providers = providersFixture();
  const legacy = providers.modelOf('opus');

  assert.equal(legacy.id, 'claude-opus-5');
  assert.equal(legacy.model.id, 'claude-opus-5');

  const retiredExact = providers.modelOf('claude-opus-5[1m]');
  assert.equal(retiredExact.id, 'claude-opus-5');
  assert.equal(retiredExact.model.id, 'claude-opus-5');
});

test('store передаёт confirmed в тело существующего settings POST', async (t) => {
  setActivePinia(createPinia());
  const providers = useProvidersStore();
  providers.providers = [{
    id: 'future-provider',
    settings: [{ id: 'blockDirectSsh', kind: 'toggle', value: true }],
  }];
  const calls = [];
  const originalPost = api.post;
  api.post = async (url, body) => {
    calls.push({ url, body });
    return { ok: true };
  };
  t.after(() => { api.post = originalPost; });

  await providers.saveSetting('future-provider', 'blockDirectSsh', false, true);

  assert.deepEqual(calls, [{
    url: '/api/providers/future-provider/settings',
    body: { settingId: 'blockDirectSsh', value: false, confirmed: true },
  }]);
});

test('store сохраняет включение запрета без confirmed в теле POST', async (t) => {
  setActivePinia(createPinia());
  const providers = useProvidersStore();
  providers.providers = [{
    id: 'future-provider',
    settings: [{ id: 'blockDirectSsh', kind: 'toggle', value: false }],
  }];
  const calls = [];
  const originalPost = api.post;
  api.post = async (url, body) => {
    calls.push({ url, body });
    return { ok: true };
  };
  t.after(() => { api.post = originalPost; });

  await providers.saveSetting('future-provider', 'blockDirectSsh', true);

  assert.deepEqual(calls, [{
    url: '/api/providers/future-provider/settings',
    body: { settingId: 'blockDirectSsh', value: true },
  }]);
});

test('store откатывает подтверждённый optimistic toggle при отказе сервера', async (t) => {
  setActivePinia(createPinia());
  const providers = useProvidersStore();
  providers.providers = [{
    id: 'future-provider',
    settings: [{ id: 'blockDirectSsh', kind: 'toggle', value: true }],
  }];
  const originalPost = api.post;
  api.post = async () => { throw new Error('confirmation_required'); };
  t.after(() => { api.post = originalPost; });

  const result = await providers.saveSetting('future-provider', 'blockDirectSsh', false, true);

  assert.deepEqual({
    result,
    value: providers.providers[0].settings[0].value,
  }, {
    result: {
      ok: false,
      outcome: 'unknown',
      error: 'confirmation_required',
    },
    value: true,
  });
});

test('credential invalidation убирает credits/URL, обходит throttle и отсеивает поздние GET', async (t) => {
  const { store, gets } = credentialFixture(t);
  const registryA = store.load();
  const usageA = store.loadUsage(true);
  const current = store.invalidateCredentials('tripo');

  assert.equal(store.usage.tripo, undefined);
  assert.equal(store.usageTransport.status, 'loading');
  assert.deepEqual(gets.map((item) => item.url), [
    '/api/providers', '/api/providers/usage', '/api/providers', '/api/providers/usage',
  ]);
  gets[2].resolve({
    providers: [{
    id: 'tripo',
    available: false,
    credentials: []
  }]
  });
  gets[3].resolve({ usage: { tripo: { state: 'auth_required', resources: [] } } });
  await current;
  gets[0].resolve({
    providers: [{
    id: 'tripo',
    available: true,
    credentials: [{
    preview: 'A'
  }]
  }]
  });
  gets[1].resolve({ usage: { tripo: { resources: [{ summary: 'A' }] } } });
  await Promise.all([registryA, usageA]);

  assert.equal(store.providers[0].available, false);
  assert.deepEqual(store.providers[0].credentials, []);
  assert.deepEqual(store.usage.tripo.resources, []);
});

test('поздний ACK не присваивает credentials A поверх SSE/GET B и не ждёт проверку', async (t) => {
  const { store, gets } = credentialFixture(t);
  const ackA = deferred();

  api.post = () => ackA.promise;

  const saving = store.saveCredentials('tripo', { KEY: 'A' });
  const current = store.invalidateCredentials('tripo');
  const projectionB = [{ env: 'KEY', preview: 'B' }];

  gets[0].resolve({ providers: [{ id: 'tripo', credentials: projectionB }] });
  gets[1].resolve({ usage: { tripo: { resources: [{ summary: 'B' }] } } });
  await current;
  ackA.resolve({ ok: true, credentials: [{ env: 'KEY', preview: 'A' }] });

  assert.deepEqual(await saving, { ok: true });
  assert.deepEqual(store.providers[0].credentials, projectionB);
  assert.equal(store.usage.tripo, undefined);
  gets[2].resolve({ providers: [{ id: 'tripo', credentials: projectionB }] });
  gets[3].resolve({ usage: { tripo: { resources: [{ summary: 'B' }] } } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store.usage.tripo.resources[0].summary, 'B');
});

test('ошибка проверки после commit не превращает запись ключа в ошибку', async (t) => {
  const { store } = credentialFixture(t);

  api.post = async () => ({ ok: true });
  api.get = async () => {
    throw new Error('Проверка недоступна');
  };

  assert.deepEqual(await store.saveCredentials('tripo', { KEY: 'new' }), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.usage.tripo, undefined);
  assert.equal(store.usageTransport.status, 'error');
  assert.match(store.usageTransport.error, /Проверка недоступна/);
});

test('reconnect перечитывает реестр и usage, поздний ответ прежнего соединения игнорируется', async (t) => {
  const { store, gets } = credentialFixture(t);

  store.noteUsageConnection(true);

  const pending = store.loadUsage(true);

  store.noteUsageConnection(false);
  store.noteUsageConnection(true);

  assert.equal(store.usage.tripo, undefined);
  assert.deepEqual(gets.map((item) => item.url), [
    '/api/providers/usage', '/api/providers', '/api/providers/usage',
  ]);
  gets[1].resolve({ providers: [{ id: 'tripo', available: false }] });
  gets[2].resolve({ usage: { tripo: { state: 'auth_required', resources: [] } } });
  await new Promise((resolve) => setImmediate(resolve));
  gets[0].resolve({ usage: { tripo: { resources: [{ summary: 'A' }] } } });
  await pending;

  assert.equal(store.providers[0].available, false);
  assert.deepEqual(store.usage.tripo.resources, []);
});
