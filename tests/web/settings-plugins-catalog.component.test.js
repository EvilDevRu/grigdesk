import assert from 'node:assert/strict';
import test from 'node:test';
import { PLUGIN_CATEGORIES } from '../../shared/plugins/pluginsContracts.ts';
import { settingsHarness } from './helpers/settings-harness.js';

test('Список плагинов: категории, фильтры, draft enabled, install и recovery guard', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', {
    prepare({ plugins }) {
      plugins.list = PLUGIN_CATEGORIES.map((group, index) => ({
        id: `entry-${index}`,
        name: `Плагин ${index}`,
        description: `Описание ${group.label}`,
        enabled: index % 2 === 0,
        system: true,
        category: group.id,
        settings: [],
        values: {},
      }));
    },
  });

  assert.deepEqual(h.wrapper.findAll('[data-plugin-category]').map((item) =>
    item.attributes('data-plugin-category')), PLUGIN_CATEGORIES.map((group) => group.id));
  await h.wrapper.get('[data-plugin-filter]').setValue('  ПЛАГИН 1 ');
  assert.equal(h.wrapper.findAll('[data-select-plugin]').length, 1);
  await h.wrapper.get('[data-select-plugin="entry-1"]').trigger('click');
  await h.flushPromises();
  assert.equal(h.settings.entityId, 'entry-1');
  await h.wrapper.findAll('[role="switch"]').at(-1).setValue(true);
  assert.equal(h.plugins.byId('entry-1').enabled, false);
  assert.equal(h.writes().length, 0);
  await h.settings.apply();
  assert.equal(h.plugins.byId('entry-1').enabled, true);
  await h.wrapper.get('[data-plugin-filter]').setValue('нет-совпадений');
  assert.match(h.wrapper.text(), /Плагины не найдены/);
  await h.wrapper.findAll('button').find((item) => item.text() === 'Сбросить фильтры').trigger('click');
  assert.equal(h.wrapper.findAll('[data-select-plugin]').length, PLUGIN_CATEGORIES.length);

  const installer = h.module.usePluginInstallStore();

  installer.recoveryError = { message: 'Требуется восстановление' };
  await h.flushPromises();
  assert.match(h.wrapper.text(), /Требуется восстановление/);
  assert.equal(h.wrapper.findAll('[role="switch"]').every((item) => item.element.disabled), true);
  installer.recoveryError = null;
  await h.flushPromises();
  await h.wrapper.findAll('button').find((item) => item.text() === 'Установить из git').trigger('click');
  assert.equal(h.settings.pageId, 'plugins.install');
});
