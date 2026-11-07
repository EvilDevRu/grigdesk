import assert from 'node:assert/strict';
import test from 'node:test';

import { settingsHarness } from './helpers/settings-harness.js';

/**
 * Карточка и ответы принадлежат одной синтетической версии сервера.
 * Настоящий store и общий Apply читают needsRestart из этих ответов, без второго эталона.
 */
async function harness(t, card = {}) {
  return settingsHarness(t, 'plugins.installed', 'PluginPage', {
    entityId: 'runtime',
    prepare({ plugins }) {
      plugins.list = [{
        id: 'runtime',
        name: 'Runtime',
        system: false,
        enabled: true,
        needsRestart: false,
        settings: [{
          key: 'name',
          type: 'text',
          label: 'Имя',
        }],
        values: { name: 'До' },
        ...card,
      }];
    },
  });
}

/**
 * Меняем поле общей сессии, как переключатель страницы, и ждём подтверждения Apply.
 * До HTTP ACK runtime store сохраняет прежнее подтверждённое значение.
 */
async function applyEnabled(h, enabled, needsRestart) {
  h.control.handlers['/api/plugins/runtime/toggle'] = ({ body }) => new Response(JSON.stringify({
    ok: true,
    enabled: body.enabled,
    needsRestart,
  }));
  h.settings.setField('pluginEnabled:runtime', 'enabled', enabled);
  await h.settings.apply();
  await h.flushPromises();
}

test('UI-01: loaded ACK false снимает ожидание; GET false после boot тоже', async (t) => {
  const h = await harness(t, { needsRestart: true });

  await applyEnabled(h, false, false);
  assert.equal(h.plugins.byId('runtime').needsRestart, false);
  assert.equal(Boolean(h.plugins.restartPending.runtime), false);
  assert.equal(h.wrapper.text().includes('Ждёт перезапуска'), false);
  h.plugins.restartPending.runtime = true;
  h.control.handlers['/api/plugins'] = () => new Response(JSON.stringify({
    plugins: [{ ...h.plugins.byId('runtime'), needsRestart: false }],
  }));
  await h.plugins.load();
  await h.flushPromises();
  assert.equal(Boolean(h.plugins.restartPending.runtime), false);
  assert.equal(h.wrapper.text().includes('Ждёт перезапуска'), false);
});

test('UI-01: dormant on ACK true показывает ожидание, off ACK false снимает', async (t) => {
  const h = await harness(t, { enabled: false, needsRestart: false });

  await applyEnabled(h, true, true);
  assert.equal(h.plugins.byId('runtime').needsRestart, true);
  assert.equal(h.plugins.restartPending.runtime, true);
  assert.equal(h.wrapper.text().includes('Ждёт перезапуска'), true);
  await applyEnabled(h, false, false);
  assert.equal(h.plugins.byId('runtime').needsRestart, false);
  assert.equal(Boolean(h.plugins.restartPending.runtime), false);
  assert.equal(h.wrapper.text().includes('Ждёт перезапуска'), false);
});

test('UI-01b: GET dormant-on показывает «Ждёт перезапуска» после загрузки вкладки', async (t) => {
  const h = await harness(t);

  h.plugins.restartPending = {};
  h.control.handlers['/api/plugins'] = () => new Response(JSON.stringify({
    plugins: [{
      ...h.plugins.byId('runtime'),
      enabled: true,
      needsRestart: true,
    }],
  }));
  await h.plugins.load();
  await h.flushPromises();
  assert.equal(h.wrapper.text().includes('Ждёт перезапуска'), true);

  const stale = 'Изменение состояния серверной части потребует перезапуска.';

  assert.equal(h.wrapper.text().includes(stale), false);
});

for (const touch of [false, true]) {
  test(`UI-02: serverError виден текстом, touch=${touch}`, async (t) => {
    const message = '<img src=x onerror="globalThis.pluginInjected=true"> Два серверных входа.';
    const h = await harness(t);

    h.browser.document.documentElement.dataset.uiTouch = String(touch);
    h.browser.window.innerWidth = touch ? 360 : 1200;
    h.control.handlers['/api/plugins'] = () => new Response(JSON.stringify({
      plugins: [{ ...h.plugins.byId('runtime'), serverError: message }],
    }));
    await h.plugins.load();
    await h.flushPromises();
    assert.equal(h.plugins.byId('runtime').serverError, message);
    assert.equal(h.wrapper.text().includes(message), true);
    assert.equal(h.wrapper.find('img[src="x"]').exists(), false);
    assert.equal(globalThis.pluginInjected, undefined);
  });
}

test('UI-02: отказ подготовки виден, dirty поле и baseline сохранены', async (t) => {
  const h = await harness(t);

  h.control.handlers['/api/plugins/runtime/settings'] = () => new Response(JSON.stringify({
    error: 'plugin_change_rejected',
    message: 'Плагин отклонил изменения настроек.',
  }), { status: 409 });
  h.settings.setField('pluginSettings:runtime', '["values","name"]', 'После');
  await h.settings.apply();
  await h.flushPromises();
  assert.equal(h.plugins.byId('runtime').values.name, 'До');
  assert.equal(h.settings.getBaseline('pluginSettings:runtime')['["values","name"]'], 'До');
  assert.equal(h.settings.getValue('pluginSettings:runtime', '["values","name"]'), 'После');
  assert.equal(h.settings.snapshot.resources.find((item) => item.id === 'pluginSettings:runtime')
    .fields.find((field) => field.key === '["values","name"]').dirty, true);
  assert.equal(h.wrapper.text().includes('Плагин отклонил изменения настроек.'), true);
});
