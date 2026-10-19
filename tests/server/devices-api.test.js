import assert from 'node:assert/strict';
import test from 'node:test';

import { decodePairing } from '../../shared/client/pairingPayload.ts';
import devicesModule from '../../server/src/modules/devices/index.ts';
import { clientFixture, clientRequest } from './helpers/clientAccess.js';

/**
 * Административный API использует тот же DeviceStore и listener, что настоящий TLS-вход.
 * Подмена статуса даёт проверить выключенный и неоднозначный вход без открытия сетевых портов.
 */
async function fixture(t, options = {}) {
  const mobileDisconnected = [];
  const result = await clientFixture(t, {
    register: async ({ app, devices, pairing, identity, listener }) => {
      await app.register(devicesModule, {
        devices,
        pairing,
        identity: () => identity,
        name: 'Имя машины',
        address: options.address ?? null,
        listener: () => options.state ? { state: () => options.state } : listener(),
        disconnectMobile: (fp) => mobileDisconnected.push(fp),
      });
    },
  });

  return { ...result, mobileDisconnected };
}

test('устройства: session допускается, CLI/internal получают session_required', async (t) => {
  const f = await fixture(t);

  for (const headers of [
    { cookie: f.cookie },
    { 'x-grigdesk-token': 'test-cli' },
    { 'x-grigdesk-internal': 'test-internal' },
  ]) {
    const response = await f.app.inject({ url: '/api/devices', headers });

    assert.equal(response.statusCode, headers.cookie ? 200 : 403);

    if (!headers.cookie) {
      assert.equal(response.json().error, 'session_required');
    }
  }
});

test('устройства: выдача строки выбирает body, настройку и единственный адрес слушателя', async (t) => {
  const f = await fixture(t, { address: 'configured.example:8443' });

  for (const [input, expected] of [
    [{ name: 'Ноутбук', address: 'explicit.example:443' }, 'explicit.example:443'],
    [{ name: 'Ноутбук' }, 'configured.example:8443'],
  ]) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/devices/pairing',
      headers: { cookie: f.cookie },
      payload: input,
    });

    assert.equal(response.statusCode, 200);

    const body = response.json();
    const payload = decodePairing(body.text);

    assert.equal(`${payload.host}:${payload.port}`, expected);
    assert.equal(body.address, expected);
    assert.equal(payload.fp, f.identity.fp);
    assert.equal(body.qr.rows.length, body.qr.size);
    assert.ok(body.qr.rows.every((row) => /^[01]+$/.test(row) && row.length === body.qr.size));
    assert.match(body.svg, /<svg/);

    const paired = await clientRequest(f, '/api/client/pair', { code: payload.code });

    assert.equal(paired.status, 200);
  }

  const auto = await fixture(t);
  const response = await auto.app.inject({
    method: 'POST',
    url: '/api/devices/pairing',
    headers: { cookie: auto.cookie },
    payload: { name: 'Ноутбук' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().address, `127.0.0.1:${auto.port}`);
});

test('устройства: выключенный и неоднозначный вход дают явные 409', async (t) => {
  for (const [state, error] of [
    [{
      state: 'disabled',
      addresses: [],
      error: null,
    }, 'client_listener_off'],
    [{
      state: 'online',
      addresses: ['0.0.0.0:443'],
      error: null,
    }, 'client_address_unknown'],
    [{
      state: 'online',
      addresses: ['192.0.2.1:443', '192.0.2.2:443'],
      error: null,
    }, 'client_address_unknown'],
  ]) {
    const f = await fixture(t, { state });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/devices/pairing',
      headers: { cookie: f.cookie },
      payload: { name: 'Ноутбук' },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, error);
  }
});

test('устройства: список скрывает пины/коды, hello узнаёт устройство, отзыв рвёт TLS', async (t) => {
  const f = await fixture(t);
  const issued = f.pairing.issue({ scope: 'client', name: 'Ноутбук' });
  const paired = await clientRequest(f, '/api/client/pair', { code: issued.code });
  const id = paired.body.device.id;
  const hello = await clientRequest(f, '/api/client/hello');

  assert.equal(hello.status, 200);
  assert.equal(hello.body.name, 'Имя машины');
  assert.equal(hello.body.device.id, id);

  const listing = await f.app.inject({ url: '/api/devices', headers: { cookie: f.cookie } });
  const record = listing.json().devices[0];

  assert.equal(record.id, id);
  assert.equal(record.scope, 'client');
  assert.equal(record.fp, undefined);
  assert.equal(record.code, undefined);
  assert.ok(!listing.body.includes(f.client.fp));
  assert.ok(!listing.body.includes(issued.code));

  const response = await f.app.inject({
    method: 'POST',
    url: `/api/devices/${id}/revoke`,
    headers: { cookie: f.cookie },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(f.mobileDisconnected, [f.client.fp]);
  assert.equal((await clientRequest(f, '/api/private')).status, 403);
});

test('S6: битый JSON и неподдерживаемый Content-Type сохраняют исходные4xx', async (t) => {
  const f = await fixture(t);

  for (const [type, payload, expected] of [
    ['application/json', '{', 400],
    ['application/unsupported', 'fixture', 415],
  ]) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/devices/pairing',
      headers: { cookie: f.cookie, 'content-type': type },
      payload,

    });

    assert.equal(response.statusCode, expected);
    assert.notEqual(response.json().error, 'client_unavailable');
  }
});

test('W13: список TLS-клиента помечает его собственное устройство', async (t) => {
  const f = await fixture(t);
  const issued = f.pairing.issue({ scope: 'client', name: 'Фикстура' });
  const paired = await clientRequest(f, '/api/client/pair', { code: issued.code });
  const listing = await clientRequest(f, '/api/devices');

  assert.equal(listing.status, 200);
  assert.equal(listing.body.currentDeviceId, paired.body.device.id);
});
