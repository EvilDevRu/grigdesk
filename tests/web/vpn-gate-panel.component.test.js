import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

const LAUNCHER = {
  autostart: { unit: 'enabled', active: true, linger: true, mode: 'boot' },
  shortcut: { desktopDir: null, desktop: false, menu: false },
};

/**
 * Стенд страницы «Система → Запуск» с живым состоянием ворот.
 * PUT меняет то же состояние, что читает GET: интерфейс обязан показать ответ сервера.
 */
async function startupHarness(t, vpnState) {
  return settingsHarness(t, 'system.startup', 'SystemPage', {
    prepare({ control }) {
      control.handlers['/api/system/server'] = () => new Response(JSON.stringify({
        mode: 'manual',
        systemd: false,
        pid: 42,
        uptimeSec: 100,
      }));
      control.handlers['/api/system/launcher'] = () => new Response(JSON.stringify(LAUNCHER));
      control.handlers['/api/system/vpn-gate'] = (call) => {
        if (call.method === 'PUT') {
          Object.assign(vpnState, {
            requireVpn: call.body.requireVpn,
            iface: call.body.iface,
            probe: call.body.probe,
            restartRequired: true,
          });
        }

        return new Response(JSON.stringify(vpnState));
      };
    },
  });
}

test('SYS-VPN: секция ворот читает конфигурацию и сохраняет её одним запросом', async (t) => {
  const vpnState = {
    requireVpn: true,
    iface: 'wg0',
    probe: '',
    defaults: { probe: '1.1.1.1' },
    restartRequired: false,
    active: { requireVpn: true, iface: 'wg0', probe: '' },
  };
  const h = await startupHarness(t, vpnState);

  assert.match(h.wrapper.text(), /Ворота VPN/);
  assert.equal(h.wrapper.find('[data-vpn-gate-require]').element.checked, true);
  assert.equal(h.wrapper.find('[data-vpn-gate-iface]').element.value, 'wg0');

  const save = h.wrapper.find('[data-vpn-gate-save]');

  assert.notEqual(save.attributes('disabled'), undefined, 'без правок сохранение недоступно');

  await h.wrapper.find('[data-vpn-gate-require]').setValue(false);
  await h.wrapper.find('[data-vpn-gate-iface]').setValue('tun0');
  await h.flushPromises();
  assert.equal(save.attributes('disabled'), undefined, 'правка разблокирует сохранение');

  await save.trigger('click');
  await h.flushPromises();

  const puts = h.writes().filter((call) => call.path === '/api/system/vpn-gate');

  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body, { requireVpn: false, iface: 'tun0', probe: '' });
  assert.match(h.wrapper.find('[data-vpn-gate-message]').text(), /сохранены/);
  assert.ok(h.wrapper.find('[data-vpn-gate-restart]').exists(), 'ответ сервера требует перезапуска');
});

test('SYS-VPN: сломанный ответ чтения показывается ошибкой и не открывает форму', async (t) => {
  const h = await settingsHarness(t, 'system.startup', 'SystemPage', {
    prepare({ control }) {
      control.handlers['/api/system/server'] = () => new Response(JSON.stringify({
        mode: 'manual',
        systemd: false,
        pid: 42,
        uptimeSec: 100,
      }));
      control.handlers['/api/system/launcher'] = () => new Response(JSON.stringify(LAUNCHER));
      control.handlers['/api/system/vpn-gate'] = () => new Response(JSON.stringify({}));
    },
  });

  assert.match(h.wrapper.find('[data-vpn-gate-error]').text(), /VPN-ворота/);
  assert.equal(h.wrapper.find('[data-vpn-gate-save]').exists(), false);
});
