import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('Native-каталог читается только при явном раскрытии', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', { entityId: 'fixture' });

  assert.equal(h.control.calls.some((call) => call.path.includes('/settings/catalog')), false);
  h.settings.selectPage('agents.providers', 'fixture', 'parameters');
  await h.flushPromises();
  assert.equal(h.control.calls.some((call) => call.path.includes('/settings/catalog')), false);
  await h.wrapper.findAll('button')
    .find((item) => item.text().includes('Дополнительные параметры')).trigger('click');
  await h.flushPromises();
  assert.equal(h.control.calls.filter((call) => call.path.includes('/settings/catalog')).length, 1);
  assert.match(h.wrapper.text(), /Новая настройка/);
});
