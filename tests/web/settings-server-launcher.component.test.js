import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('Автозапуск: boot/login/missing, независимый ярлык и staged PUT', async (t) => {
  const h = await settingsHarness(t, 'system.startup', 'SystemPage', {
    /**
     * Режим юнита и состояние ярлыка меняются только ответом своего API.
     * Транспорт не запускает настоящий launcher и не трогает живой сервер.
     */
    prepare({ control }) {
      control.data.launcher.autostart = { unit: 'enabled', active: true, linger: false, mode: 'login' };
      control.handlers['/api/system/server'] = () => new Response(JSON.stringify(control.data.server));
      control.handlers['/api/system/launcher'] = () => new Response(JSON.stringify(control.data.launcher));
      control.handlers['/api/system/launcher/autostart'] = ({ body }) => {
        control.data.launcher.autostart = {
          unit: body.enabled ? 'enabled' : 'disabled',
          active: true,
          linger: true,
          mode: body.enabled ? 'boot' : 'off',
        };

        return new Response(JSON.stringify({ autostart: control.data.launcher.autostart }));
      };
      control.handlers['/api/system/launcher/shortcut'] = ({ method }) => {
        control.data.launcher.shortcut = { desktop: method === 'POST', menu: method === 'POST' };

        return new Response(JSON.stringify({ shortcut: control.data.launcher.shortcut }));
      };
    },
  });

  assert.match(h.wrapper.text(), /Только при входе.*loginctl enable-linger/);
  await h.wrapper.get('[role="switch"]').setValue(false);
  assert.equal(h.writes().length, 0);
  await h.settings.apply();
  assert.deepEqual(h.writes()[0].body, { enabled: false });
  assert.match(h.wrapper.text(), /живой процесс продолжает работать/);

  const shortcut = h.wrapper.findAll('button')
    .find((item) => /Создать ярлык|Удалить ярлык/.test(item.text()));

  await shortcut.trigger('click');
  await h.flushPromises();
  assert.equal(h.writes().at(-1).path, '/api/system/launcher/shortcut');
});
