import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { settingsHarness } from './helpers/settings-harness.js';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;

after(() => browser?.close());

const showcase = {
  id: 'showcase',
  system: true,
  name: 'Презентации',
  version: '0.1.0',
  description: 'Создание роликов.',
  enabled: true,
  needsRestart: false,
  setup: { path: '/api/showcase/setup' },
  settings: [{
    key: 'retentionDays',
    type: 'number',
    label: 'Срок хранения',
    min: 1,
    default: 30,
  }],
  values: { retentionDays: 30 },
};

/**
 * Настройки используют настоящий общий черновик и публичный ответ подготовки.
 * Одно окно сохраняет document Vue между сценариями, сеть остаётся синтетической.
 */
async function harness(t, prepare) {
  browser ||= await createUiBrowser();
  browser.document.body.innerHTML = '<div id="mount"></div>';

  return settingsHarness(t, 'tools.showcase', 'PluginPage', {
    browser,
    prepare({ plugins, control }) {
      plugins.list = [structuredClone(showcase)];
      control.handlers['/api/showcase/setup'] = () => Response.json({ items: [], checkedAt: 'fixture' });
      prepare?.({ plugins, control });
    },
  });
}

test('Презентации: запись отделена от альтернативных голосов, установка и отмена доступны', async (t) => {
  const items = [{
    id: 'browser',
    title: 'Браузер записи',
    status: 'ready',
    reason: 'Браузер установлен.',
    action: null,
    job: null,
  }, {
    id: 'media',
    title: 'Сборка видео',
    status: 'blocked',
    reason: 'Нет ffmpeg.',
    action: null,
    job: null,
  }, {
    id: 'voice:local',
    title: 'Локальный голос',
    status: 'blocked',
    reason: 'Не установлен.',
    action: { label: 'Установить голос', hint: 'Скачается модель.' },
    job: null,
  }];
  const reply = () => Response.json({ items, checkedAt: 'fixture' });
  const h = await harness(t, ({ control }) => {
    control.handlers['/api/showcase/setup'] = reply;
    control.handlers['/api/showcase/setup/voice%3Alocal'] = () => {
      items[2].job = {
        state: 'running',
        label: 'Скачивание модели',
        error: null,
      };

      return reply();
    };
    control.handlers['/api/showcase/setup/voice%3Alocal/cancel'] = () => {
      items[2].job = {
        state: 'cancelled',
        label: 'Установка отменена',
        error: null,
      };

      return reply();
    };
  });
  const recording = h.wrapper.get('[data-setup-group="recording"]');
  const voices = h.wrapper.get('[data-setup-group="voices"]');

  assert.match(h.wrapper.text(), /выберите уже работающий стенд/u);
  assert.equal(h.wrapper.find('.settings-plugin-title').exists(), false);
  assert.equal(recording.get('[data-setup-item="browser"] .setup-status').text(), 'Готово');
  assert.equal(recording.get('[data-setup-item="media"] .setup-status').text(), 'Нужна настройка');
  assert.equal(recording.find('[data-setup-item="voice:local"]').exists(), false);
  assert.match(voices.text(), /достаточно одного подходящего голоса/u);
  assert.equal(voices.get('.setup-items').isVisible(), false);
  assert.equal(h.writes().length, 0);

  await voices.get('.ui-disclosure-button').trigger('click');
  assert.equal(voices.get('.setup-items').isVisible(), true);
  await voices.findAll('button').find((button) => button.text() === 'Установить голос').trigger('click');
  await h.flushPromises();
  assert.match(voices.text(), /Устанавливается/u);
  await voices.findAll('button').find((button) => button.text() === 'Отменить').trigger('click');
  await h.flushPromises();
  assert.match(voices.text(), /Установка отменена/u);
  assert.deepEqual(h.writes().map((call) => call.path), [
    '/api/showcase/setup/voice%3Alocal',
    '/api/showcase/setup/voice%3Alocal/cancel',
  ]);
});

test('Презентации: переход ждёт включения и сохраняет выбор судьбы черновика', async (t) => {
  const h = await harness(t, ({ plugins }) => {
    plugins.list[0].enabled = false;
  });
  const open = () => h.wrapper.get('[data-showcase-open]');

  assert.equal(open().element.disabled, true);
  await h.wrapper.get('[role="switch"]').setValue(true);
  assert.equal(open().element.disabled, true);
  assert.equal(h.writes().length, 0);
  await h.settings.apply();
  await h.flushPromises();
  assert.equal(open().element.disabled, false);

  await h.wrapper.get('input[type="number"]').setValue('40');
  await open().trigger('click');
  assert.equal(h.settings.closeChoiceOpen, true);
  assert.deepEqual(h.control.navigations, []);
  await h.settings.chooseClose('continue');
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  await open().trigger('click');
  await h.settings.chooseClose('discard');
  await h.flushPromises();
  assert.deepEqual(h.control.navigations, ['/showcase']);
  assert.equal(h.settings.isOpen, false);
  assert.deepEqual(h.writes().map((call) => call.path), ['/api/plugins/showcase/toggle']);
});
