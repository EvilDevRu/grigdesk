import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

const record = {
  id: 'forecast',
  name: 'Прогноз',
  system: false,
  enabled: true,
  settings: [
    {
      key: 'providers',
      type: 'providers',
      label: 'Исполнители',
      default: [],
    },
    {
      key: 'showIdle',
      type: 'checkbox',
      label: 'Свободные',
      default: true,
    },
  ],
  values: { providers: ['fixture'], showIdle: true },
  placements: [{
    slot: 'provider.popover.after-bars',
    label: 'Всплывашка исполнителя',
    enabled: true,
  }],
};

test('Размещения: один полный PUT, отказ, Cancel и поздний ответ после нового открытия', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', {
    prepare({ plugins }) {
      plugins.list = [structuredClone(record)];
    },
  });
  const plugin = h.plugins.byId('forecast');

  assert.match(h.wrapper.text(), /Всплывашка исполнителя/);
  assert.equal(h.wrapper.find('input[aria-label="Всплывашка исполнителя"]').exists(), true);
  await h.wrapper.get('input[aria-label="Всплывашка исполнителя"]').setValue(false);
  h.settings.setField('pluginSettings:forecast', '["values","providers"]', []);
  assert.equal(plugin.placements[0].enabled, true);
  assert.deepEqual(plugin.values.providers, ['fixture']);
  assert.match(h.wrapper.text(), /Ни один не отмечен — значит все/);
  h.control.handlers['/api/plugins/forecast/settings'] = () =>
    new Response(JSON.stringify({ error: 'Отказ размещения' }), { status: 500 });
  await h.settings.apply();
  assert.equal(plugin.placements[0].enabled, true);
  assert.equal(h.settings.snapshot.dirtyCount, 2);
  delete h.control.handlers['/api/plugins/forecast/settings'];
  await h.settings.apply();
  assert.deepEqual(h.writes().at(-1).body, {
    values: { providers: [], showIdle: true },
    placements: { 'provider.popover.after-bars': false },
  });
  assert.equal(plugin.placements[0].enabled, false);
  h.settings.setField('pluginSettings:forecast', '["values","showIdle"]', false);
  h.settings.dispose();
  h.settings.requestOpen({ pageId: 'plugins.installed', entityId: 'forecast' });
  await h.flushPromises();
  assert.equal(plugin.values.showIdle, true);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
});
