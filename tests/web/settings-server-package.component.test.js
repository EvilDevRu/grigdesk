import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { settingsHarness } from './helpers/settings-harness.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('SEA-UI-01: версия пакета предлагает установку пакета без source-действий', async (t) => {
  await installUiBrowser(t);

  const { createSSRApp } = await import('../../web/node_modules/vue/index.mjs');
  const { renderToString } = await import('../../web/node_modules/@vue/server-renderer/index.js');
  const Card = await compileVue(webFile('src/views/settings/PackagedServerVersion.vue'));
  const html = await renderToString(createSSRApp(Card, {
    version: '1.2.3',
    clientVersion: '4.5.6',
    message: 'Установите новый пакет GrigDesk',
  }));

  assert.match(html, /1\.2\.3/);
  assert.match(html, /4\.5\.6/);
  assert.match(html, /Установите новый пакет GrigDesk/);
  assert.doesNotMatch(html, /button|checkout|git|npm|Пересобрать|Проверить обновления/i);
});

test('SEA-UI-02: общий модал показывает пакет и не опрашивает source-пересборку', async (t) => {
  const fixture = await settingsHarness(t, 'system.updates', 'SystemPage', {
    /**
     * Настоящий store получает пакетный DTO через транспорт страницы настроек.
     * Старые source-флаги намеренно включены: capability имеет приоритет над ними.
     */
    prepare({ control }) {
      control.data.release.running.version = '2.3.4';
      control.data.release.updateCapability = {
        kind: 'package',
        message: 'Установите новый пакет GrigDesk',
      };
      control.data.release.canApplyCheckout = true;
      control.data.release.canInstallRelease = true;
      control.handlers['/api/system/version'] = () => new Response(JSON.stringify(control.data.release));
      control.handlers['/api/system/web-rebuild'] = () => new Response(JSON.stringify({ rebuild: null }));
    },
  });

  assert.match(fixture.wrapper.text(), /Версия сервера: 2\.3\.4/);
  assert.match(fixture.wrapper.text(), /Установите новый пакет GrigDesk/);
  assert.doesNotMatch(fixture.wrapper.text(),
    /Рабочая копия|Применить локальные|Пересобрать интерфейс/);
  assert.equal(fixture.control.calls.some((call) => call.path === '/api/system/web-rebuild'), false);
  assert.equal(fixture.writes().length, 0);
});
