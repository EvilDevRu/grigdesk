import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { api } from '../../web/src/shared/apiClient.ts';
import { useProvidersStore } from '../../web/src/stores/providers.js';

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
    result: { ok: false, error: 'confirmation_required' },
    value: true,
  });
});
