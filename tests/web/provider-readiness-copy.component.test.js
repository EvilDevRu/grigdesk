import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

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
