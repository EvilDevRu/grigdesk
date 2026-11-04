import assert from 'node:assert/strict';
import test from 'node:test';
import { PLUGIN_CATEGORIES } from '../../shared/plugins/pluginsContracts.ts';
import { settingsHarness } from './helpers/settings-harness.js';
import { webInstallInfo } from './helpers/pluginInstallFixtures.js';

test('Список плагинов: только пользовательские, фильтры и переход к системной странице', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', {
    stubs: { teleport: true },
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
  await h.wrapper.get('[data-select-plugin="entry-1"] button').trigger('click');
  await h.flushPromises();
  assert.equal(h.settings.entityId, 'entry-1');
  assert.equal(h.wrapper.get('[data-select-plugin="entry-1"] button').attributes('aria-pressed'), 'true');
  assert.equal(h.wrapper.get('[data-select-plugin="entry-1"]').classes().includes('is-selected'), true);
  await h.wrapper.get('[data-plugin-enable-action]').trigger('click');
  assert.equal(h.plugins.byId('entry-1').enabled, false);
  assert.equal(h.writes().length, 0);
  await h.settings.apply();
  assert.equal(h.plugins.byId('entry-1').enabled, true);
  await h.wrapper.get('[data-plugin-filter]').setValue('нет-совпадений');
  assert.match(h.wrapper.text(), /Плагины не найдены/);
  assert.equal(h.settings.entityId, 'entry-1');
  assert.equal(h.wrapper.attributes('data-plugin-page'), 'entry-1');
  await h.wrapper.get('[data-plugin-filter-options]').trigger('click');
  await h.flushPromises();
  await h.wrapper.findAll('button').find((item) => item.text() === 'Сбросить фильтры').trigger('click');
  assert.equal(h.wrapper.findAll('[data-select-plugin]').length, PLUGIN_CATEGORIES.length);
  await h.wrapper.get('select[aria-label="Выберите плагин"]').setValue('entry-0');
  await h.flushPromises();
  assert.equal(h.settings.entityId, 'entry-0');
  assert.equal(h.wrapper.get('[data-select-plugin="entry-0"] button').attributes('aria-pressed'), 'true');

  const installer = h.module.usePluginInstallStore();

  installer.recoveryError = { message: 'Требуется восстановление' };
  await h.flushPromises();
  assert.match(h.wrapper.text(), /Требуется восстановление/);
  assert.equal(h.wrapper.get('[data-plugin-enable-action]').element.disabled, true);
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
  assert.equal(h.wrapper.find('[data-plugin-enable-action]').exists(), true);
  assert.equal(h.wrapper.findAll('[data-select-plugin]').length, 0);
  assert.equal(h.writes().length, 0);
});

test('Флажок списка сохраняет выбор и общий черновик до Apply', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', {
    prepare({ plugins }) {
      plugins.list = ['first', 'second'].map((id) => ({
        id,
        name: id,
        enabled: false,
        system: false,
        settings: [],
        values: {},
      }));
    },
  });

  await h.wrapper.get('[data-plugin-enabled="second"]').setValue(true);
  await h.flushPromises();
  assert.equal(h.settings.entityId, 'first');
  assert.equal(h.plugins.byId('second').enabled, false);
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  assert.equal(h.writes().length, 0);

  await h.wrapper.get('[data-select-plugin="second"] button').trigger('click');
  await h.flushPromises();
  assert.equal(h.wrapper.get('[data-plugin-enable-action]').text(), 'Выключить');
  await h.wrapper.get('[data-plugin-enable-action]').trigger('click');
  assert.equal(h.wrapper.get('[data-plugin-enabled="second"]').element.checked, false);
  assert.equal(h.settings.snapshot.dirtyCount, 0);

  await h.wrapper.get('[data-plugin-enabled="first"]').setValue(true);
  await h.flushPromises();
  await h.settings.apply();
  assert.equal(h.plugins.byId('first').enabled, true);
  assert.equal(h.settings.entityId, 'second');

  h.module.usePluginInstallStore().recoveryError = { message: 'Требуется восстановление' };
  await h.flushPromises();
  assert.equal(h.wrapper.findAll('[data-plugin-enabled]').every((item) => item.element.disabled), true);
});

test('Источник открывается отдельной вкладкой и привлекает внимание при обновлении', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', {
    prepare({ plugins }) {
      plugins.list = [{
        id: 'demo',
        name: 'Демо',
        enabled: false,
        serverError: 'Ошибка запуска плагина',
        settings: [],
        values: {},
      }];
    },
  });

  assert.equal(h.wrapper.get('[data-plugin-details-tab="parameters"]').attributes('aria-selected'), 'true');
  assert.equal(h.wrapper.get('[data-role="plugin-source"]').isVisible(), false);
  await h.wrapper.get('[data-plugin-details-tab="source"]').trigger('click');
  assert.equal(h.wrapper.get('[data-role="plugin-source"]').isVisible(), true);
  assert.equal(h.wrapper.get('.settings-plugin-runtime-error').isVisible(), true);
  await h.wrapper.get('[data-plugin-details-tab="parameters"]').trigger('click');

  h.plugins.list[0].install = webInstallInfo({ updateAvailable: true });
  await h.flushPromises();
  assert.equal(h.wrapper.get('[data-plugin-details-tab="source"]').attributes('aria-selected'), 'true');
  assert.equal(h.wrapper.get('[data-role="plugin-source-update"]').isVisible(), true);
  assert.equal(h.writes().length, 0);
});

test('Поиск поля открывает параметры из источника и сохраняет черновик между вкладками', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', {
    entityId: 'sample',
  });

  await h.wrapper.get('input[aria-label="Лимит"]').setValue(24);
  await h.wrapper.get('[data-plugin-details-tab="source"]').trigger('click');
  assert.equal(h.wrapper.get('input[aria-label="Лимит"]').isVisible(), false);

  h.settings.reveal({
    pageId: 'plugins.installed',
    entityId: 'sample',
    fieldPath: ['values', 'limit'],
  });
  await h.flushPromises();
  assert.equal(h.wrapper.get('[data-plugin-details-tab="parameters"]').attributes('aria-selected'), 'true');
  assert.equal(h.wrapper.get('input[aria-label="Лимит"]').isVisible(), true);
  assert.equal(h.wrapper.get('input[aria-label="Лимит"]').element.value, '24');
  assert.equal(h.browser.document.activeElement, h.wrapper.get('input[aria-label="Лимит"]').element);
  assert.equal(h.writes().length, 0);

  h.settings.reveal({
    pageId: 'plugins.installed',
    entityId: 'sample',
    fieldPath: ['enabled'],
  });
  await h.flushPromises();
  assert.equal(h.browser.document.activeElement, h.wrapper.get('[data-plugin-enable-action]').element);
});
