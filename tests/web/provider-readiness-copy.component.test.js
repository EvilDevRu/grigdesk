import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { mountOnboarding, onboardingButton } from './helpers/onboardingMounted.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

/**
 * Полный мастер связывает доступность сервиса с реальной кнопкой перехода.
 * API и старый CLI сохраняют разные пояснения без веток по имени исполнителя.
 */
test('PROVIDER-COPY: API, тип работы и условие продолжения в полном мастере', async (t) => {
  const browser = await installUiBrowser(t);
  const f = await mountOnboarding(t, browser, {
    providers: [{
      id: 'synthetic-3d',
      name: 'Synthetic 3D',
      type: '3d',
      kind: 'api',
      available: true,
      installed: true,
      chatEnabled: false,
    }],
  });
  const button = (label) => onboardingButton(f, label);
  const card = () => f.wrapper.get('article.provider');

  assert.match(card().text(), /3D-генерация/u);
  assert.match(card().text(), /Подключение по API/u);
  assert.doesNotMatch(card().text(), /Установлен|Не установлен/u);
  assert.equal(card().findAll('button').length, 0);
  assert.match(f.wrapper.get('.onboarding-description').text(), /с поддержкой чата/u);
  assert.equal(button('Далее').element.disabled, true);
  assert.equal(button('Пропустить шаг').element.disabled, false);

  f.providers.providers.push({
    id: 'legacy-chat',
    name: 'Legacy chat',
    available: true,
    installed: true,
  });
  await f.flushPromises();

  const legacy = f.wrapper.findAll('article.provider').find((item) => item.text().includes('Legacy chat'));

  assert.match(legacy.text(), /Универсальные/u);
  assert.match(legacy.text(), /Установлен/u);
  assert.equal(button('Далее').element.disabled, false);
  f.providers.providers = [];
  await f.flushPromises();
  assert.equal(f.wrapper.findAll('article.provider').length, 0);
  assert.equal(button('Далее').element.disabled, true);
  assert.equal(button('Пропустить шаг').element.disabled, false);
  assert.match(f.wrapper.text(), /Нужен хотя бы один доступный исполнитель с поддержкой чата/u);
});

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
    chatReady: false,
    label: 'Доступен',
  });
  locale.value = 'en';
  assert.deepEqual(providerAvailability(provider, locale), {
    available: true,
    chatReady: false,
    label: 'Available',
  });
  assert.equal(providerAvailability({ available: false }, 'en').label, 'Unavailable');
});
