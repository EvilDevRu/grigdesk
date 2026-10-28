import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('Арбитр: потерянная модель, opaque model id и effort общей сессии', async (t) => {
  const h = await settingsHarness(t, 'automation.arbiter', 'PreferencesPage', {
    prepare({ control, providers }) {
      control.data.prefs.arbiter.auto = false;
      providers.providers[0].available = false;
      providers.providers[0].models = [
        {
          id: 'repo/model:tag',
          name: 'Другая модель',
          efforts: ['low', 'high'],
        },
        { id: 'no-effort', name: 'Без усилия' },
      ];
    },
  });

  assert.equal(h.wrapper.get('[role="switch"]').attributes('aria-checked'), 'false');
  assert.equal(h.wrapper.get('optgroup').attributes('label'), 'Тестовый исполнитель — недоступен');
  assert.match(h.wrapper.text(), /fixture:retired — нет в реестре/);

  const select = h.wrapper.findAll('select')[0];

  await select.setValue(JSON.stringify({ provider: 'fixture', model: 'repo/model:tag' }));
  await h.wrapper.findAll('select')[1].setValue('high');
  assert.equal(h.writes().length, 0);
  await h.settings.apply();
  assert.deepEqual(h.control.data.prefs.arbiter, {
    auto: false,
    modelRef: { provider: 'fixture', model: 'repo/model:tag' },
    effort: 'high',
  });
  await select.setValue(JSON.stringify({ provider: 'fixture', model: 'no-effort' }));
  await h.settings.apply();
  assert.equal(h.control.data.prefs.arbiter.effort, '');
  assert.deepEqual(h.control.data.prefs.arbiter.modelRef, { provider: 'fixture', model: 'no-effort' });
});

test('сохранённый auto=true остаётся включённым; RU/EN явно объясняют новый выбор исправления', async (t) => {
  const h = await settingsHarness(t, 'automation.arbiter', 'PreferencesPage', {
    prepare({ control }) {
      control.data.prefs.arbiter.auto = true;
    },
  });

  assert.equal(h.wrapper.get('[role="switch"]').attributes('aria-checked'), 'true');
  assert.match(h.wrapper.text(), /После обновления он больше не продолжает конвейер автоматически/);
  h.module.setUiLocale('en');
  await h.flushPromises();

  try {
    assert.match(h.wrapper.text(), /you choose the correction/);
    assert.equal(h.control.data.prefs.arbiter.auto, true);
    assert.equal(h.writes().length, 0);
  } finally {
    h.module.setUiLocale('ru');
  }
});
