import assert from 'node:assert/strict';
import test from 'node:test';
import { PLUGIN_CATEGORIES } from '../../shared/plugins/pluginsContracts.ts';
import { settingsHarness } from './helpers/settings-harness.js';

test('Список плагинов: только пользовательские, фильтры и переход к системной странице', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', {
    prepare({ plugins }) {
      plugins.list = [
        ...PLUGIN_CATEGORIES.map((group, index) => ({
          id: `entry-${index}`,
          name: `Плагин ${index}`,
          description: `Описание ${group.label}`,
          enabled: index % 2 === 0,
          system: false,
          category: group.id,
          settings: [],
          values: {},
        })),
        {
          id: 'ssh',
          system: true,
          name: 'SSH',
          enabled: true,
          category: 'dev',
          settings: [{
            key: 'outputLimitKiB',
            type: 'number',
            label: 'Лимит',
            default: 64
          }],
          values: { outputLimitKiB: 64 },
        },
      ];
    },
  });

  assert.equal(h.wrapper.findAll('[data-select-plugin="ssh"]').length, 0);
  assert.equal(h.settings.entityId, 'entry-0');
  assert.deepEqual(h.wrapper.findAll('[data-plugin-category]').map((item) =>
    item.attributes('data-plugin-category')), PLUGIN_CATEGORIES.map((group) => group.id));
  await h.wrapper.get('[data-plugin-filter]').setValue('  ПЛАГИН 1 ');
  assert.equal(h.wrapper.findAll('[data-select-plugin]').length, 1);
  await h.wrapper.get('[data-select-plugin="entry-1"]').trigger('click');
  await h.flushPromises();
  assert.equal(h.settings.entityId, 'entry-1');
  assert.equal(h.wrapper.get('[data-select-plugin="entry-1"]').attributes('aria-pressed'), 'true');
  assert.equal(h.wrapper.get('[data-select-plugin="entry-1"]').classes().includes('is-pressed'), true);
  await h.wrapper.findAll('[role="switch"]').at(-1).setValue(true);
  assert.equal(h.plugins.byId('entry-1').enabled, false);
  assert.equal(h.writes().length, 0);
  await h.settings.apply();
  assert.equal(h.plugins.byId('entry-1').enabled, true);
  await h.wrapper.get('[data-plugin-filter]').setValue('нет-совпадений');
  assert.match(h.wrapper.text(), /Плагины не найдены/);
  assert.equal(h.settings.entityId, 'entry-1');
  assert.equal(h.wrapper.attributes('data-plugin-page'), 'entry-1');
  await h.wrapper.findAll('button').find((item) => item.text() === 'Сбросить фильтры').trigger('click');
  assert.equal(h.wrapper.findAll('[data-select-plugin]').length, PLUGIN_CATEGORIES.length);
  await h.wrapper.get('select[aria-label="Выберите плагин"]').setValue('entry-0');
  await h.flushPromises();
  assert.equal(h.settings.entityId, 'entry-0');
  assert.equal(h.wrapper.get('[data-select-plugin="entry-0"]').attributes('aria-pressed'), 'true');

  const installer = h.module.usePluginInstallStore();

  installer.recoveryError = { message: 'Требуется восстановление' };
  await h.flushPromises();
  assert.match(h.wrapper.text(), /Требуется восстановление/);
  assert.equal(h.wrapper.findAll('[role="switch"]').every((item) => item.element.disabled), true);
  installer.recoveryError = null;
  await h.flushPromises();
  assert.equal(h.wrapper.findAll('button').some((item) => item.text() === 'Установить из git'), false);
  assert.equal(h.settings.pageId, 'plugins.installed');

  h.settings.reveal({
    pageId: 'plugins.installed',
    entityId: 'ssh',
    tabId: 'parameters',
    fieldPath: ['values', 'outputLimitKiB'],
  });
  await h.flushPromises();
  assert.equal(h.settings.pageId, 'connections.ssh');
  assert.equal(h.settings.entityId, undefined);
  assert.equal(h.settings.tabId, undefined);
  assert.equal(h.settings.revealTarget, null);
  assert.equal(h.browser.document.activeElement === h.wrapper.get('input[type="number"]').element, true);
  assert.equal(h.wrapper.find('[data-plugin-filter]').exists(), false);
});

test('Без пользовательских пакетов: пустой магазин и явный адрес неизвестного system', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', {
    prepare({ plugins }) {
      plugins.list = ['ssh', 'future-system'].map((id) => ({
        id,
        name: id,
        system: true,
        enabled: false,
        settings: [],
        values: {},
      }));
    },
  });

  assert.equal(h.wrapper.findAll('[data-select-plugin]').length, 0);
  assert.equal(h.settings.entityId, undefined);
  assert.equal(h.wrapper.find('.settings-plugin-empty').exists(), true);
  assert.match(h.wrapper.text(), /[Gg]it/u);
  h.settings.selectPage('plugins.installed', 'future-system');
  await h.flushPromises();
  assert.equal(h.settings.pageId, 'plugins.installed');
  assert.equal(h.settings.entityId, 'future-system');
  assert.equal(h.wrapper.attributes('data-plugin-page'), 'future-system');
  assert.equal(h.wrapper.find('[role="switch"]').exists(), true);
  assert.equal(h.wrapper.findAll('[data-select-plugin]').length, 0);
  assert.equal(h.writes().length, 0);
});
