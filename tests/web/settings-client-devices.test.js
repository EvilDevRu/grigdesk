import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';
import { phoneBrowser } from './helpers/phoneBrowser.js';

test('PHONE-13: страница доступа не требует стартовой формы', async (t) => {
  const h = await settingsHarness(t, 'connections.devices', 'DevicesPage', {
    browser: phoneBrowser(),
    prepare({ control }) {
      control.handlers['/api/devices'] = () => Response.json({
        listener: { state: 'online', addresses: [] },
        devices: [],
      });
      control.handlers['/api/devices/access'] = () => Response.json({
        name: 'Сервер',
        source: 'off',
        direct: { state: 'disabled', addresses: [] },
        networks: [],
        relays: [],
      });
    },
  });

  assert.equal(h.wrapper.findAll('input').length, 0);
  assert.match(h.wrapper.text(), /Подключить телефон/);
  assert.equal(h.writes().length, 0);
});

test('PHONE-13: способы связи и устройства с rename/lastSeen/revoke', async (t) => {
  const { phoneHarness } = await import('./helpers/phoneAccess.js');
  const rows = [{
    id: 'd12345678',
    name: 'Телефон владельца',
    scope: 'client',
    lastSeenAt: 1700000000000,
    revokedAt: null,
  }];
  const h = await phoneHarness(t, {
    settings: true,
    answers: {
      'GET /api/devices': () => ({
        devices: structuredClone(rows),
        listener: { state: 'online', addresses: ['192.0.2.10:8145'] },
        currentDeviceId: 'd12345678',
      }),
      'PATCH /api/devices/d12345678': ({ body }) => {
        rows[0].name = body.name;

        return { ok: true };
      },
      'POST /api/devices/d12345678/revoke': () => {
        rows[0].revokedAt = Date.now();

        return { ok: true };
      },
    },
  });

  assert.match(h.wrapper.text(), /Прям|напрям/i);
  assert.match(h.wrapper.text(), /[Рр]етранслятор/);
  assert.match(h.wrapper.text(), /Телефон владельца/);
  assert.match(h.wrapper.text(), /[Пп]оследний вход/);
  assert.match(h.wrapper.text(), /это устройство/);
  await h.click(/Переименовать/);

  const input = document.querySelector('.ui-dialog input');

  assert.ok(input);
  input.value = 'Новое имя телефона';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await h.click(/Сохранить/);
  assert.equal(rows[0].name, 'Новое имя телефона');
  assert.match(h.wrapper.text(), /Новое имя телефона/);
  await h.click(/Отозвать/);
  await h.click(/Отмена/);
  assert.equal(h.requests.some((call) => call.url.endsWith('/revoke')), false);
  await h.click(/Отозвать/);

  const dialog = document.querySelector('.ui-dialog');
  const confirm = [...dialog.querySelectorAll('button')].find((button) =>
    /Отозвать/.test(button.textContent));

  assert.ok(confirm);
  confirm.click();
  await h.flushPromises();
  assert.ok(rows[0].revokedAt);
  assert.match(h.wrapper.text(), /[Оо]тозван/);
});

test('PHONE-14: уже открытые настройки нормализуют старый alias', async (t) => {
  const h = await settingsHarness(t, 'connections.b24', 'DevicesPage', {
    browser: phoneBrowser(),
    prepare({ control }) {
      control.handlers['/api/devices'] = () => Response.json({
        devices: [],
        listener: { state: 'disabled' },
      });
      control.handlers['/api/devices/access'] = () => Response.json({
        name: 'Сервер',
        source: 'off',
        direct: { state: 'disabled', addresses: [] },
        networks: [],
        relays: [],
      });
    },
  });

  h.settings.requestOpen({ pageId: 'connections.mobile' });
  assert.equal(h.settings.pageId, 'connections.devices');
  h.settings.selectPage('connections.b24');
  h.settings.selectPage('connections.mobile');
  assert.equal(h.settings.pageId, 'connections.devices');
});
