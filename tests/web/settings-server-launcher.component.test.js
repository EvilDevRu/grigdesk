import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('Автозапуск сервера сохраняется через Apply, клиентские ярлыки не идут в серверный API', async (t) => {
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
    },
  });

  assert.match(h.wrapper.text(), /Только при входе.*loginctl enable-linger/);
  await h.wrapper.get('[data-startup-scope="server"] [role="switch"]').setValue(false);
  assert.equal(h.writes().length, 0);
  await h.settings.apply();
  assert.deepEqual(h.writes()[0].body, { enabled: false });
  assert.match(h.wrapper.text(), /живой процесс продолжает работать/);
  assert.match(h.wrapper.get('[data-startup-scope="application"]').text(), /обновлённом приложении/);
  assert.equal(h.control.calls.some((call) => call.path.includes('/launcher/shortcut')), false);
});

test('удалённый сервер: автозапуск окна и ярлык сохраняются на клиенте независимо от юнита', async (t) => {
  let native = {
    executablePath: '/opt/GrigDesk/grigdesk-app',
    autostart: false,
    shortcut: { desktop: false, menu: false },
  };
  const h = await settingsHarness(t, 'system.startup', 'SystemPage', {
    /**
     * Серверный юнит отсутствует на удалённой машине, а native-порт окна доступен.
     * Раздельные ответы позволяют доказать адрес назначения каждой записи.
     */
    prepare({ control }) {
      control.data.launcher.autostart = {
        unit: 'missing',
        active: false,
        linger: null,
        mode: 'unavailable',
      };
      control.handlers['/api/system/server'] = () => Response.json(control.data.server);
      control.handlers['/api/system/launcher'] = () => Response.json(control.data.launcher);
      control.handlers['/__shell/launcher'] = ({ body }) => {
        if (body && 'autostart' in body) {
          native.autostart = body.autostart;
        }

        if (body && 'shortcut' in body) {
          native.shortcut.menu = body.shortcut;
        }

        return Response.json(native);
      };
    },
  });
  const shell = h.module.useShellStore();

  t.after(() => h.module.setUiLocale('ru'));

  shell.apply({
    rev: 1,
    status: 'online',
    profile: {
      id: 'remote',
      name: 'Удалённая машина',
      kind: 'remote',
    },
    profiles: [],
    localAvailable: false,
    capabilities: ['applicationLauncher'],
  });
  await h.wrapper.setProps({ active: false });
  await h.wrapper.setProps({ active: true });
  await h.flushPromises();

  const application = h.wrapper.get('[data-startup-scope="application"]');
  const server = h.wrapper.get('[data-startup-scope="server"]');

  assert.match(server.text(), /Удалённая машина/);
  assert.match(application.text(), /\/opt\/GrigDesk\/grigdesk-app/);
  assert.equal(server.get('[role="switch"]').attributes('disabled') !== undefined, true);
  await application.get('[role="switch"]').setValue(true);
  assert.equal(h.writes().length, 0);

  const shortcut = application.findAll('button').find((item) => item.text() === 'Создать ярлык');

  assert.equal(shortcut.attributes('disabled'), undefined);
  await shortcut.trigger('click');
  await h.flushPromises();
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  assert.deepEqual(h.writes()[0], {
    path: '/__shell/launcher',
    method: 'POST',
    body: { shortcut: true },
  });
  await h.settings.apply();
  assert.deepEqual(h.writes()[1].body, { autostart: true });
  assert.equal(h.settings.snapshot.dirtyCount, 0);
  assert.equal(native.autostart, true);
  assert.equal(h.writes().every((call) => call.path === '/__shell/launcher'), true);

  await h.module.setUiLocale('en');
  await h.flushPromises();
  assert.equal(application.get('h4').text(), 'Application');
  assert.equal(server.get('h4').text(), 'Server');
  assert.equal(application.get('[role="switch"]').attributes('aria-label'),
    'Open the application when I sign in');
  assert.equal(server.get('[role="switch"]').attributes('aria-label'),
    'Start the server automatically');
  assert.match(application.text(), /Application file.*\/opt\/GrigDesk\/grigdesk-app/);
});
