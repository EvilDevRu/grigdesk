import assert from 'node:assert/strict';
import test from 'node:test';

import { relayUi } from './helpers/relayDeployment.js';

process.env.NODE_ENV = 'test';

test('RD-PHONE-UI-01: capability routeUpdate даёт scanner/string для существующей машины', async (t) => {
  const h = await relayUi(t, { connections: true, capabilities: ['routeUpdate', 'scan'] });

  await h.click(/Параметры подключения/iu);
  await h.click(/Изменить адрес|адрес/iu);
  await h.click(/Обновить маршрут|маршрут.*QR/iu);
  await h.click(/Сканировать|Сканировать QR/iu);
  assert.equal(h.text().includes('GRIGDESK:PHONE:2:SCANNER_SECRET'), false);
  await h.click(/Обновить|Подтвердить/iu);
  assert.deepEqual(h.requests.filter((call) => call.method === 'PATCH').map((call) => call.body), [
    { routePairing: 'GRIGDESK:PHONE:2:SCANNER_SECRET' },
  ]);
  assert.equal(h.requests.find((call) => call.method === 'PATCH').url, 'a');
  assert.equal(document.querySelectorAll('textarea').length, 0);
});

test('RD-PHONE-UI-01: cancel и поздний scanner после смены profile не обновляют другую машину', async (t) => {
  let finish;
  const scanned = new Promise((resolve) => finish = resolve);
  const h = await relayUi(t, { connections: true, capabilities: ['routeUpdate', 'scan'] });

  h.shell.scan = () => scanned;
  await h.click(/Параметры подключения/iu);
  await h.click(/Изменить адрес|адрес/iu);
  await h.click(/Обновить маршрут|маршрут.*QR/iu);
  await h.click(/Сканировать/iu);
  await h.click(/Закрыть|Отмена/iu);
  h.shell.profile = {
    ...h.shell.profile,
    id: 'b',
    name: 'Сервер Б'
  };
  finish({ pairing: 'GRIGDESK:PHONE:2:LATE_SECRET' });
  await h.flushPromises();
  assert.equal(h.requests.filter((call) => call.method === 'PATCH').length, 0);
  assert.equal(h.text().includes('LATE_SECRET'), false);
});

test('RD-PHONE-UI-01: без capability сохраняется прежнее direct редактирование', async (t) => {
  const h = await relayUi(t, {
    connections: true,
    capabilities: [],
    prompt: 'https://new.example:443',
  });

  await h.click(/Параметры подключения/iu);
  await h.click(/Изменить адрес|адрес/iu);
  assert.deepEqual(h.requests.filter((call) => call.method === 'PATCH').map((call) => call.body), [
    { address: 'https://new.example:443' },
  ]);
  assert.equal(Boolean(h.button(/Обновить маршрут/iu)), false);
});

test('RD-PHONE-UI-01: вставка строки меняет routes существующего профиля без add', async (t) => {
  const h = await relayUi(t, { connections: true, capabilities: ['routeUpdate'] });

  await h.click(/Параметры подключения/iu);
  await h.click(/Изменить адрес|адрес/iu);
  await h.click(/Обновить маршрут|маршрут.*QR/iu);

  const textarea = document.querySelector('textarea');

  assert.equal(Boolean(textarea), true);
  textarea.value = 'GRIGDESK:PHONE:2:PASTE_SECRET';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await h.flushPromises();
  await h.click(/Обновить|Подтвердить/iu);
  assert.deepEqual(h.requests.filter((call) => call.method === 'PATCH').map((call) => call.body), [
    { routePairing: 'GRIGDESK:PHONE:2:PASTE_SECRET' },
  ]);
  assert.equal(h.requests.some((call) => call.method === 'POST' && /profiles/u.test(call.url)), false);
  assert.equal(JSON.stringify(h.shell).includes('PASTE_SECRET'), false);
});
