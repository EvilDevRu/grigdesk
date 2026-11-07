import assert from 'node:assert/strict';
import test from 'node:test';

import { settingsHarness } from './helpers/settings-harness.js';

process.env.NODE_ENV = 'test';

/**
 * Каталог и карточка настроек получают один настоящий providers store.
 * Подменяется HTTP, чтобы проверить сохранение снимка при ошибке и восстановление.
 */
test('PROVIDER-READINESS: общий статус и восстановление после ошибки', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'tripo',
    prepare({ providers }) {
      providers.providers = [
        {
          id: 'tripo',
          name: 'Tripo',
          type: '3d',
          kind: 'api',
          available: true,
          installed: true,
          chatEnabled: false,
          models: [],
        },
        {
          id: 'setup-only',
          name: 'Setup only',
          available: true,
          installed: true,
          chatEnabled: false,
          models: [],
        },
        {
          id: 'synthetic-chat',
          name: 'Synthetic chat',
          available: false,
          installed: true,
          chatEnabled: true,
          models: [],
        },
      ];
    },
  });

  h.settings.selectPage('agents.providers', 'tripo', 'overview');
  await h.flushPromises();

  const refresh = () => h.wrapper.get('[data-ui-settings-sidebar-action]');
  const titleStatus = () => h.wrapper.get('.settings-provider-status').text();
  const listStatus = () => h.wrapper.get('[data-select-provider="tripo"] .ui-settings-catalog-status').text();

  assert.equal(titleStatus(), 'Доступен');
  assert.equal(listStatus(), 'Доступен');

  const gate = Promise.withResolvers();

  h.control.handlers['/api/providers?refresh=1'] = () => gate.promise;

  try {
    await refresh().trigger('click');
    assert.equal(refresh().element.disabled, true);
  } finally {
    gate.resolve(Response.json({ error: 'fixture unavailable' }, { status: 503 }));
  }

  await h.providers.whenRegistryReady();
  await h.flushPromises();
  assert.equal(refresh().element.disabled, false);
  assert.equal(titleStatus(), 'Доступен');

  const snapshot = h.providers.providers.map((provider) => ({ ...provider, available: false }));

  h.control.handlers['/api/providers?refresh=1'] = () => Response.json({ providers: snapshot });
  await refresh().trigger('click');
  await h.providers.whenRegistryReady();
  await h.flushPromises();
  assert.equal(titleStatus(), 'Недоступен');
  assert.equal(listStatus(), 'Недоступен');

  h.control.handlers['/api/providers?refresh=1'] = () => Response.json({
    providers: snapshot.map((provider) => ({ ...provider, available: true })),
  });
  await refresh().trigger('click');
  await h.providers.whenRegistryReady();
  await h.flushPromises();
  assert.equal(titleStatus(), 'Доступен');

  t.after(() => h.module.setUiLocale('ru'));
  h.module.setUiLocale('en');
  await h.flushPromises();
  assert.equal(titleStatus(), 'Available');
  assert.equal(listStatus(), 'Available');
  h.module.setUiLocale('ru');
  await h.flushPromises();
  assert.equal(titleStatus(), 'Доступен');
  assert.equal(listStatus(), 'Доступен');
  assert.deepEqual(h.writes(), []);
});
