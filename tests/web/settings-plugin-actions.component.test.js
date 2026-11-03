import assert from 'node:assert/strict';
import test from 'node:test';

import { settingsHarness } from './helpers/settings-harness.js';
import { webInstallInfo } from './helpers/pluginInstallFixtures.js';

/**
 * Два пользовательских пакета позволяют проверить независимость общих черновиков.
 * Сеть удаления и обновления задаётся в каждом сценарии без настоящих плагинов машины.
 */
function prepare({ plugins }) {
  plugins.list = ['demo', 'second'].map((id) => ({
    id,
    name: id,
    version: '1.0.0',
    system: false,
    enabled: false,
    settings: [{
      key: 'text',
      label: 'Текст',
      type: 'string',
      default: '',
    }],
    values: { text: '' },
  }));
}

test('Кнопки обновления и удаления доступны прямо в шапке, включая ручной пакет', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', {
    prepare,
    stubs: { teleport: true },
  });

  assert.equal(h.wrapper.get('[data-plugin-update-action]').isVisible(), true);
  assert.equal(h.wrapper.get('[data-plugin-remove-action]').isVisible(), true);
  assert.equal(h.wrapper.get('[data-plugin-update-action]').attributes('aria-label'), 'Обновить');
  assert.equal(h.wrapper.get('[data-plugin-remove-action]').attributes('aria-label'), 'Удалить');
  assert.equal(h.wrapper.get('[data-plugin-update-action]').text(), '');
  assert.equal(h.wrapper.get('[data-plugin-remove-action]').text(), '');
  assert.equal(h.wrapper.get('[data-plugin-details-tab="parameters"]').attributes('aria-selected'), 'true');
  await h.wrapper.get('[data-plugin-update-action]').trigger('click');
  await h.flushPromises();
  assert.equal(h.wrapper.find('[data-role="plugin-install-dialog"]').exists(), true);
  assert.equal(h.writes().length, 0);
});

test('Обновление managed-плагина открывает выбор версий его сохранённого источника', async (t) => {
  const info = webInstallInfo();
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', {
    stubs: { teleport: true },
    prepare(context) {
      prepare(context);
      context.plugins.list[0].install = info;
      context.control.handlers['/api/plugin-installs/versions'] = () => new Response(JSON.stringify({
        source: info.source,
        versions: [{
          version: info.version,
          tag: info.tag,
          sha: info.sha,
        }],
      }));
    },
  });

  await h.wrapper.get('[data-plugin-update-action]').trigger('click');
  await h.flushPromises();
  assert.deepEqual(h.writes().map((call) => ({ path: call.path, body: call.body })), [{
    path: '/api/plugin-installs/versions', body: { url: info.source.url },
  }]);
  assert.match(h.wrapper.text(), /Обновление «demo»/u);
});

test('Удаление подтверждается и отменяет только черновик удалённого плагина', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', { prepare });

  h.settings.setField('pluginSettings:demo', '["values","text"]', 'Удаляемый черновик');
  await h.wrapper.get('[data-select-plugin="second"] button').trigger('click');
  await h.flushPromises();
  h.settings.setField('pluginSettings:second', '["values","text"]', 'Остаётся');
  await h.wrapper.get('[data-select-plugin="demo"] button').trigger('click');
  await h.flushPromises();
  h.control.answer = false;
  await h.wrapper.get('[data-plugin-remove-action]').trigger('click');
  await h.flushPromises();
  assert.equal(h.writes().length, 0);
  assert.equal(h.settings.snapshot.dirtyCount, 2);

  h.control.answer = true;
  h.control.handlers['/api/plugin-installs/plugins/demo/remove'] = () =>
    new Response(JSON.stringify({ id: 'demo', restartRequired: true }));
  h.control.handlers['/api/plugins'] = () => new Response(JSON.stringify({
    plugins: h.plugins.list.filter((entry) => entry.id !== 'demo'),
  }));
  await h.wrapper.get('[data-plugin-remove-action]').trigger('click');
  await h.flushPromises();
  assert.equal(h.writes().length, 1);
  assert.equal(h.plugins.byId('demo'), null);
  assert.equal(h.settings.entityId, 'second');
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  assert.equal(h.settings.getValue('pluginSettings:second', '["values","text"]'), 'Остаётся');
  assert.match(h.wrapper.get('[data-plugin-removed]').text(), /удалён.*Перезапустите/u);
  await h.wrapper.get('[data-plugin-removed] button').trigger('click');
  await h.flushPromises();
  assert.equal(h.wrapper.find('[data-plugin-removed]').exists(), false);
  assert.equal(h.settings.snapshot.dirtyCount, 1);
});

test('Отказ удаления сохраняет ввод и показывает причину в карточке', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', { prepare });

  h.settings.setField('pluginSettings:demo', '["values","text"]', 'Черновик');
  h.control.handlers['/api/plugin-installs/plugins/demo/remove'] = () => new Response(JSON.stringify({
    error: 'plugin_stop_required', message: 'Выключите плагин и перезапустите GrigDesk.',
  }), { status: 409 });
  await h.wrapper.get('[data-plugin-remove-action]').trigger('click');
  await h.flushPromises();
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  assert.equal(h.settings.entityId, 'demo');
  assert.match(h.wrapper.get('[data-plugin-action-error]').text(), /перезапустите/u);
  assert.equal(h.wrapper.find('[data-plugin-removed]').exists(), false);
  await h.wrapper.get('[data-plugin-action-error] button').trigger('click');
  await h.flushPromises();
  assert.equal(h.wrapper.find('[data-plugin-action-error]').exists(), false);
  assert.equal(h.writes().length, 1);
  assert.equal(h.settings.snapshot.dirtyCount, 1);
});

test('Recovery закрывает действия, системные плагины их не получают', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', { prepare });
  const installer = h.module.usePluginInstallStore();

  installer.recoveryError = { code: 'recovery_required', message: 'Восстановление' };
  await h.flushPromises();
  assert.equal(h.wrapper.get('[data-plugin-update-action]').element.disabled, true);
  assert.equal(h.wrapper.get('[data-plugin-remove-action]').element.disabled, true);
  installer.recoveryError = null;
  h.plugins.list[0].system = true;
  await h.flushPromises();
  assert.equal(h.wrapper.find('[data-plugin-update-action]').exists(), false);
  assert.equal(h.wrapper.find('[data-plugin-remove-action]').exists(), false);
});

test('Смена выбранного плагина во время подтверждения не удаляет прежнюю карточку', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', { prepare });
  const confirmation = Promise.withResolvers();

  t.after(() => confirmation.resolve(false));
  h.control.answer = confirmation.promise;
  await h.wrapper.get('[data-plugin-remove-action]').trigger('click');
  await h.wrapper.get('[data-select-plugin="second"] button').trigger('click');
  await h.flushPromises();
  confirmation.resolve(true);
  await h.flushPromises();
  assert.equal(h.settings.entityId, 'second');
  assert.equal(h.writes().length, 0);
  assert.equal(h.plugins.list.length, 2);
});
