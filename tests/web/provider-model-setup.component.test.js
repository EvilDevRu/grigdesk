import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

/**
 * Отсутствие исполнителя в вариантах объясняется в подвале общего селекта.
 * Переход к его настройке сохраняет текущую модель и несохранённые параметры.
 */
test('Выбор модели: исполнитель без моделей ведёт к своей настройке', async (t) => {
  const h = await settingsHarness(t, 'automation.arbiter', 'PreferencesPage', {
    prepare({ providers }) {
      providers.providers.push({
        id: 'empty',
        name: 'Пустой каталог',
        available: true,
        installed: true,
        models: [],
      });
    },
  });
  const before = structuredClone(h.settings.getValue('prefs', 'arbiterModelRef'));

  await h.wrapper.get('button[data-provider-model-select]').trigger('click');
  await h.flushPromises();

  assert.equal(h.browser.document.querySelector('[data-model-providers-settings]'), null);

  const action = h.browser.document.querySelector('[data-model-provider-setup][data-provider-id="empty"]');

  assert.ok(action);
  assert.match(action.textContent, /Пустой каталог.*Нет моделей/);
  action.click();
  await h.flushPromises();
  assert.equal(h.settings.pageId, 'agents.providers');
  assert.equal(h.settings.entityId, 'empty');
  assert.deepEqual(h.settings.getValue('prefs', 'arbiterModelRef'), before);
  assert.equal(h.writes().length, 0);
});
