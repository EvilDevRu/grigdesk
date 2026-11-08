import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, phoneHarness } from './helpers/phoneAccess.js';

process.env.NODE_ENV = 'test';

for (const kind of ['local', 'remote']) {
  test(`PHONE-10: два входа/один выбранный сервер (${kind})`, async (t) => {
    const h = await phoneHarness(t, { settings: true, kind });

    assert.equal(h.requests.some((call) => call.method === 'POST'), false);
    await h.click(/Подключить телефон/, 0);
    assert.equal(document.querySelectorAll('.ui-dialog').length, 1);
    assert.match(document.querySelector('.ui-dialog').textContent, /Сервер А/);
    assert.equal(h.requests.filter((call) => call.url === '/api/devices/phone-pairing').length, 1);
    assert.ok(h.requests.every((call) => call.owner === 'a'));
    await h.click(/Закрыть/);
    await h.click(/Подключить телефон/, 1);
    assert.equal(document.querySelectorAll('.ui-dialog').length, 1);
    assert.equal(h.requests.filter((call) => call.url === '/api/devices/phone-pairing').length, 2);
  });
}

test('PHONE-10: кнопка доступна без native shell и использует имя сервера из status', async (t) => {
  const h = await phoneHarness(t);

  h.shell.apply(null);
  await h.flushPromises();
  await h.click(/Подключить телефон/);
  assert.match(document.querySelector('.ui-dialog').textContent, /Сервер А/);
});
test('PHONE-11: QR сразу, TTL/copy/refresh, подтверждённый success', async (t) => {
  const h = await phoneHarness(t);
  const copied = [];

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value) => copied.push(value) },
  });
  await h.click(/Подключить телефон/);

  const dialog = document.querySelector('.ui-dialog');

  assert.ok(dialog.querySelector('img'));
  assert.equal(dialog.querySelector('textarea').value, h.issued.text);
  assert.equal(Boolean(dialog.querySelector('input[required]')), false);
  assert.match(dialog.textContent, /Android/);
  assert.match(dialog.textContent, /скан|встав/i);
  assert.match(dialog.textContent, /600/);
  assert.doesNotMatch(dialog.textContent, /Телефон подключён/);

  const issued = h.requests.find((call) => call.url === '/api/devices/phone-pairing');

  assert.equal(issued.body?.name, undefined);
  assert.equal(issued.body?.address, undefined);
  await h.click(/Копировать/);
  assert.deepEqual(copied, [h.issued.text]);
  h.connected();
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await h.flushPromises();
  assert.match(document.querySelector('.ui-dialog').textContent, /подключён/i);
});
test('PHONE-11: истёкший код скрыт, копирование запрещено, обновление явное', async (t) => {
  const h = await phoneHarness(t);

  h.issued.expiresInMs = 30;
  await h.click(/Подключить телефон/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await h.flushPromises();

  const dialog = document.querySelector('.ui-dialog');

  assert.equal(Boolean(dialog.querySelector('img')), false);
  assert.equal(dialog.querySelector('textarea')?.value || '', '');
  assert.match(dialog.textContent, /ист[её]к/i);
  assert.equal(h.requests.filter((call) => call.method === 'POST').length, 1);
  h.issued.expiresInMs = 600000;
  await h.click(/Обновить/);
  assert.equal(h.requests.filter((call) => call.url === '/api/devices/phone-pairing').length, 2);
});

for (const completion of ['resolve', 'reject']) {
  test(`PHONE-12: late ${completion} после close/switch/reopen отброшен`, async (t) => {
    const pending = deferred();
    const answers = { 'POST /api/devices/phone-pairing': () => pending.promise };
    const h = await phoneHarness(t, { answers });
    // Не ждём flushPromises незавершённого API: клик запускает запрос и отдаёт управление.
    document.querySelector('button').click();
    await new Promise((resolve) => setImmediate(resolve));
    await h.click(/Закрыть/);
    h.shell.apply({
      rev: 2,
      status: 'online',
      profile: {
        id: 'b',
        name: 'Сервер Б',
        kind: 'remote',
        address: 'https://b.example:443'
      },
      profiles: [],
      capabilities: [],
      localAvailable: true,
    });
    h.auth.clientScope = 'scope-b';
    h.status.name = 'Сервер Б';
    h.issued.text = 'GRIGDESK:PHONE:2:SYNTHETIC_SECRET_B';
    delete answers['POST /api/devices/phone-pairing'];
    await h.click(/Подключить телефон/);

    if (completion === 'resolve') {
      pending.resolve({ ...h.issued, text: 'GRIGDESK:PHONE:2:STALE_SECRET_A' });
    }
    else {
      pending.reject(new Error('Старый сервер недоступен'));
    }

    await h.flushPromises();
    assert.match(document.querySelector('.ui-dialog').textContent, /Сервер Б/);
    assert.equal(document.querySelector('textarea').value, h.issued.text);
    assert.doesNotMatch(document.body.textContent, /STALE_SECRET_A|Старый сервер недоступен/);
    await h.click(/Закрыть/);
    assert.equal(Boolean(document.querySelector('textarea')), false);

    const stored = [...Object.keys(localStorage), ...Object.keys(sessionStorage)]
      .map((key) => localStorage.getItem(key) || sessionStorage.getItem(key)).join(' ');

    assert.doesNotMatch(stored, /SYNTHETIC_SECRET|STALE_SECRET/);
  });
}

test('PHONE-10: выключенный доступ включается явно для сети выбранного сервера', async (t) => {
  const h = await phoneHarness(t);

  h.status.source = 'off';
  h.status.direct = {
    state: 'disabled',
    addresses: [],
    error: null
  };
  h.answers['PUT /api/devices/access/direct'] = () => {
    h.status.source = 'saved';
    h.status.direct = {
      state: 'online',
      addresses: ['192.0.2.10:8145'],
      error: null
    };

    return structuredClone(h.status);
  };
  await h.click(/Подключить телефон/);
  assert.equal(h.requests.filter((call) => call.method === 'POST').length, 0);
  assert.equal(Boolean(document.querySelector('.ui-dialog img')), false);
  assert.doesNotMatch(document.querySelector('.ui-dialog').textContent, /GRIGDESK_CLIENT_LISTEN/);
  await h.click(/Включить/);

  const enabled = h.requests.find((call) => call.method === 'PUT');

  assert.ok(enabled);
  assert.equal(enabled.owner, 'a');
  assert.equal(enabled.body.enabled, true);
  assert.ok(JSON.stringify(enabled.body).includes('192.0.2.10'));
  assert.ok(document.querySelector('.ui-dialog img'));
});

test('PHONE-10: server→relay waiting_vpn не требует VPN телефона', async (t) => {
  const h = await phoneHarness(t);

  h.status.direct = {
    state: 'disabled',
    addresses: [],
    error: null
  };
  h.status.relays = [{
    id: 'r12345678',
    name: 'Ретранслятор владельца',
    host: 'relay.example',
    port: 443,
    compatibility: 'supported',
    link: {
      state: 'waiting_vpn',
      lastError: 'Маршрут сервера недоступен',
      pipes: 0
    },
  }];
  h.answers['POST /api/devices/phone-pairing'] = () => {
    throw Object.assign(new Error('Сервер не подключён к ретранслятору'), {
      data: { error: 'relay_unavailable' },
    });
  };
  await h.click(/Подключить телефон/);

  const dialog = document.querySelector('.ui-dialog');

  assert.match(dialog.textContent, /[Сс]ервер/);
  assert.match(dialog.textContent, /ретранслятор/);
  assert.doesNotMatch(dialog.textContent, /(?:включите|установите)[^.!?]*VPN[^.!?]*телефон/i);
  assert.ok([...dialog.querySelectorAll('button')].some((button) => /[Нн]астро/.test(button.textContent)));
});

test('PHONE-12: потеря авторизации убирает QR и прекращает опрос', async (t) => {
  const h = await phoneHarness(t);

  await h.click(/Подключить телефон/);
  assert.ok(document.querySelector('textarea'));
  h.auth.authenticated = false;
  await h.flushPromises();

  const requests = h.requests.length;

  assert.equal(Boolean(document.querySelector('.ui-dialog')), false);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(h.requests.length, requests);
});

test('PHONE-12: медленный phone QR не передаёт секреты в журнал окна', async (t) => {
  const { api, setApiLogSink } = await import('../../web/src/shared/apiClient.ts');
  const previous = globalThis.fetch;
  const events = [];
  const secret = 'GRIGDESK:PHONE:2:SYNTHETIC_SECRET';
  let clock = 0;

  t.mock.method(performance, 'now', () => clock += 11000);
  setApiLogSink((event, data) => events.push({ event, data }));
  globalThis.fetch = async () => Response.json({ text: secret, svg: '<svg />' });
  t.after(() => {
    globalThis.fetch = previous;
    setApiLogSink(null);
  });

  const result = await api.post('/api/devices/phone-pairing', {});

  assert.equal(result.text, secret);
  assert.ok(events.length > 0);
  assert.equal(JSON.stringify(events).includes(secret), false);
});
