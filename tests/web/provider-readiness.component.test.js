import assert from 'node:assert/strict';
import test from 'node:test';

import { settingsHarness } from './helpers/settings-harness.js';

process.env.NODE_ENV = 'test';

/**
 * Обычный снимок может быть пустым до окончания проб, в том числе при открытии ссылки.
 * Временный отказ даёт повтор, а поздний каталог восстанавливает выбранную карточку.
 */
test('PROVIDER-READINESS: холодный пустой снимок, ошибка и восстановление', async (t) => {
  const cold = Promise.withResolvers();
  const retry = Promise.withResolvers();
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'probe',
    prepare({ control, providers }) {
      providers.providers = [];
      control.handlers['/api/providers?wait=1'] = () => cold.promise;
    },
  });

  assert.equal(h.wrapper.find('[data-ui-loading]').exists(), true);
  assert.equal(h.wrapper.find('.settings-provider-general [data-ui-settings-field]').exists(), true);

  const sidebar = h.wrapper.get('[data-loading-region="provider-sidebar"]');
  const editor = h.wrapper.get('[data-loading-region="provider-editor"]');

  assert.equal(sidebar.find('.settings-provider-picker').exists(), true);
  assert.equal(editor.find('[data-ui-settings-tabs]').exists(), true);
  assert.equal(h.wrapper.find('.settings-provider-empty').exists(), false);
  assert.doesNotMatch(h.wrapper.text(), /Исполнитель больше недоступен/);

  const reads = h.control.calls.map(({ path }) => path).filter((path) => path.startsWith('/api/providers'));

  assert.deepEqual(reads, ['/api/providers?wait=1']);

  cold.resolve(Response.json({ error: 'fixture unavailable' }, { status: 400 }));
  await h.flushPromises();
  assert.match(h.wrapper.text(), /Не удалось перечитать реестр исполнителей/);

  h.control.handlers['/api/providers?wait=1'] = () => retry.promise;

  const retryButton = h.wrapper.findAll('button').find((button) => button.text() === 'Повторить загрузку');

  await retryButton.trigger('click');
  assert.equal(h.wrapper.find('[data-ui-loading]').exists(), true);

  retry.resolve(Response.json({
    providers: [{
      id: 'probe',
      name: 'Probe',
      models: [],
    }],
  }));
  await h.flushPromises();
  assert.equal(h.wrapper.get('[data-provider-page="probe"] .settings-provider-title h4').text(), 'Probe');
  assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
});

/**
 * При открытии раздела без конкретного исполнителя первый готовый результат выбирает карточку.
 * Готовой пустой выдаче соответствует обычное состояние отсутствия исполнителей.
 */
test('PROVIDER-READINESS: подтверждённый пустой каталог и поздний снимок', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    prepare({ control, providers }) {
      providers.providers = [];
      control.handlers['/api/providers?wait=1'] = () => Response.json({ providers: [] });
    },
  });

  assert.match(h.wrapper.get('.settings-provider-empty').text(), /Исполнители не найдены/);

  h.control.handlers['/api/providers'] = () => Response.json({
    providers: [{
      id: 'probe',
      name: 'Probe',
      models: [],
    }],
  });

  await h.providers.load(false, { invalidate: true, reason: 'sse' });
  await h.flushPromises();
  assert.equal(h.settings.entityId, 'probe');
  assert.equal(h.wrapper.get('[data-provider-page="probe"] .settings-provider-title h4').text(), 'Probe');
});

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

/**
 * Готовый CLI с ключом и пустым каталогом не выглядит пригодным для чата.
 * Исправление доступа и повтор доступны на месте, без записи нового ключа.
 */
test('PROVIDER-READINESS: пустые модели объясняются и восстанавливаются', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    prepare({ providers }) {
      Object.assign(providers.providers[0], {
        available: true,
        installed: true,
        chatEnabled: true,
        models: [],
      });
    },
  });

  h.settings.selectPage('agents.providers', 'fixture', 'models');
  await h.flushPromises();
  assert.equal(h.wrapper.get('.settings-provider-status').text(), 'Нет моделей');
  assert.match(h.wrapper.get('[data-provider-chat-notice]').text(), /Список моделей пуст/);
  await h.wrapper.findAll('[data-provider-chat-notice] button')
    .find((button) => button.text() === 'Настроить доступ').trigger('click');
  assert.equal(h.settings.tabId, 'access');
  h.control.handlers['/api/providers?refresh=1'] = () => Response.json({
    providers: h.providers.providers.map((provider) => ({
      ...provider, models: [{ id: 'recovered', name: 'Доступная модель' }],
    })),
  });
  await h.wrapper.get('[data-provider-chat-notice] button').trigger('click');
  await h.providers.whenRegistryReady();
  await h.flushPromises();
  assert.equal(h.wrapper.get('.settings-provider-status').text(), 'Доступен');
  assert.equal(h.wrapper.find('[data-provider-chat-notice]').exists(), false);
  assert.deepEqual(h.writes(), []);
});
