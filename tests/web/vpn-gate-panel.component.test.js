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

  assert.equal(h.wrapper.find('[data-vpn-gate-save]').exists(), false);
  assert.equal(h.settings.snapshot.dirtyCount, 0);

  await h.wrapper.find('[data-vpn-gate-require]').setValue(false);
  await h.wrapper.find('[data-vpn-gate-iface]').setValue('tun0');
  await h.flushPromises();
  assert.equal(h.settings.snapshot.dirtyCount, 2);
  assert.equal(h.writes().length, 0, 'ввод не пишет до общего применения');

  h.settings.selectPage('system.updates');
  await h.flushPromises();
  h.settings.selectPage('system.startup');
  await h.flushPromises();
  assert.equal(h.wrapper.find('[data-vpn-gate-iface]').element.value, 'tun0');
  assert.equal(h.settings.snapshot.dirtyCount, 2, 'переход между разделами сохраняет черновик');

  await h.settings.apply('apply');
  await h.flushPromises();

  const puts = h.writes().filter((call) => call.path === '/api/system/vpn-gate');

  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body, { requireVpn: false, iface: 'tun0', probe: '' });
  assert.equal(h.settings.snapshot.dirtyCount, 0);
  assert.equal(h.settings.isOpen, true, 'Применить оставляет настройки открытыми');
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

/**
 * Ошибка общего применения сохраняет пользовательский ввод и доступность повтора.
 * Повторный OK подтверждает нормализованный сервером ответ и закрывает настройки.
 */
test('SYS-VPN: отказ сохраняет черновик, повторный OK сохраняет и закрывает', async (t) => {
  const state = {
    requireVpn: false,
    iface: 'wg0',
    probe: '',
    defaults: { probe: '1.1.1.1' },
    restartRequired: false,
    active: {
      requireVpn: false,
      iface: 'wg0',
      probe: '',
    },
  };
  const h = await startupHarness(t, state);
  const original = h.control.handlers['/api/system/vpn-gate'];

  h.control.handlers['/api/system/vpn-gate'] = (call) => call.method === 'PUT'
    ? new Response(JSON.stringify({ error: 'Сбой записи' }), { status: 500 })
    : original(call);
  await h.wrapper.find('[data-vpn-gate-probe]').setValue(' 8.8.8.8 ');
  await h.settings.apply('ok');
  await h.flushPromises();
  assert.equal(h.settings.isOpen, true);
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  assert.equal(h.wrapper.find('[data-vpn-gate-probe]').element.value, ' 8.8.8.8 ');

  h.control.handlers['/api/system/vpn-gate'] = original;
  await h.settings.apply('ok');
  await h.flushPromises();
  assert.equal(h.settings.snapshot.dirtyCount, 0);
  assert.equal(h.settings.isOpen, false);
  assert.equal(state.iface, 'wg0', 'полный PUT сохраняет неизменённый интерфейс');
  assert.equal(state.requireVpn, false);
  assert.equal(state.probe, '8.8.8.8');
});

test('SYS-VPN: отмена отбрасывает черновик без записи', async (t) => {
  const h = await startupHarness(t, {
    requireVpn: false,
    iface: '',
    probe: '',
    defaults: { probe: '1.1.1.1' },
    restartRequired: false,
    active: {
      requireVpn: false,
      iface: '',
      probe: '',
    },
  });

  await h.wrapper.find('[data-vpn-gate-require]').setValue(true);
  await h.settings.chooseClose('discard');
  await h.flushPromises();
  assert.equal(h.writes().length, 0);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
});
