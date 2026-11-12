import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { messages } from '../../shared/i18n/catalogs.ts';

process.env.NODE_ENV = 'test';

/**
 * Общая проекция читает язык на каждом вызове и не изменяет входной снимок.
 * Проверка перевода не подменяет отдельный DOM-сценарий согласованности экранов.
 */
test('PROVIDER-LOCALE: доступность переводится независимо от поддержки чата', async () => {
  const { providerAvailability } = await compileModule(webFile('src/features/providers/providerLocale.ts'));
  const provider = Object.freeze({ available: true, chatEnabled: false });
  const locale = { value: 'ru' };

  assert.deepEqual(providerAvailability(provider, locale), {
    available: true,
    label: 'Доступен',
  });
  locale.value = 'en';
  assert.deepEqual(providerAvailability(provider, locale), {
    available: true,
    label: 'Available',
  });
  assert.equal(providerAvailability({ available: false }, 'en').label, 'Unavailable');
});

/**
 * Подпись настройки чата учитывает установку и модели без изменения общего допуска.
 * Оба языка используют собственные тексты, а внешняя причина сохраняется дословно.
 */
test('PROVIDER-LOCALE: готовность чата объясняет установку, доступ и модели', async () => {
  const { providerChatReadiness } = await compileModule(webFile('src/features/providers/providerLocale.ts'));
  const provider = {
    id: 'fixture',
    name: 'Fixture',
    available: true,
    installed: true,
    models: [],
  };

  assert.equal(providerChatReadiness(provider, 'ru').label, 'Нет моделей');
  assert.equal(providerChatReadiness(provider, 'en').label, 'No models');
  assert.equal(providerChatReadiness({ ...provider, installed: false }, 'ru').label, 'Не установлен');
  assert.equal(providerChatReadiness({ ...provider, type: '3d' }), null);
  assert.equal(providerChatReadiness({ ...provider, chatEnabled: false }), null);
  assert.equal(providerChatReadiness({
    ...provider,
    available: false,
    authLabel: 'HTTP 401',
  }).message, 'HTTP 401');
  assert.equal(providerChatReadiness({ ...provider, models: [{ id: 'one', name: 'One' }] }).available, true);
});

/**
 * Собственные причины отказа каталога Qwen имеют точный перевод по ID исполнителя.
 * Исходные сообщения стороннего сервиса не становятся ключами каталога.
 */
test('PROVIDER-LOCALE: причины отказа Qwen переводятся без изменения внешних ошибок', async () => {
  const { localizeProviderAuthLabel } = await compileModule(
    webFile('src/features/providers/providerLocale.ts'),
  );

  for (const [key, authLabel] of Object.entries(messages.ru.settings.builtinProviders.qwen.auth)) {
    assert.equal(localizeProviderAuthLabel({ id: 'qwen', authLabel }, 'en'),
      messages.en.settings.builtinProviders.qwen.auth[key]);
  }

  assert.equal(localizeProviderAuthLabel({ id: 'qwen', authLabel: 'HTTP 401: upstream' }, 'en'),
    'HTTP 401: upstream');
});
