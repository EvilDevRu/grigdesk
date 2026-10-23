import assert from 'node:assert/strict';
import test from 'node:test';
import { clientRequest } from './helpers/clientAccess.js';
import { issuePhone, phoneAdmin, phoneFixture } from './helpers/phoneAccess.js';
import { freePort } from './helpers/pluginBootFixture.js';
/**
 * Все сценарии используют настоящий TLS, но публикуют только конкретный сетевой адрес.
 * Выдача не получает имя устройства и не должна начинаться с обязательной формы.
 */
async function ready(t) {
  const f = await phoneFixture(t);
  const port = await freePort();
  const result = await phoneAdmin(f, 'PUT', '/api/devices/access/direct', {
    enabled: true,
    addresses: [{ host: f.host, port }],
  });

  assert.equal(result.statusCode, 200, result.body);

  return { ...f, port };
}

test('PHONE-07: один QR/один client code на все пути', async (t) => {
  const f = await ready(t);
  const issued = await issuePhone(f);

  assert.equal(issued.payload.server.fp, f.identity.fp);
  assert.equal(issued.payload.server.name, f.config.serverName);
  assert.deepEqual(issued.payload.direct, [{ host: f.host, port: f.port }]);
  assert.equal(issued.expiresInMs, 600000);
  assert.equal(issued.payload.pair.code.length, 32);
  assert.ok(issued.attemptId);
  assert.match(issued.svg, /<svg/);
  assert.equal(issued.qr.rows.length, issued.qr.size);
  assert.ok(issued.qr.rows.every((row) => /^[01]+$/.test(row) && row.length === issued.qr.size));

  const paired = await clientRequest(f, '/api/client/pair', { code: issued.payload.pair.code });

  assert.equal(paired.status, 200);
  assert.equal(paired.body.device.name, 'Телефон');

  const repeat = await clientRequest(f, '/api/client/pair', { code: issued.payload.pair.code });

  assert.deepEqual(repeat.body.device, paired.body.device);
  assert.equal((await f.devices.list()).length, 1);
  assert.equal((await f.devices.list())[0].scope, 'client');

  const stranger = await clientRequest(f, '/api/client/pair', {
    code: issued.payload.pair.code,
  }, f.stranger);

  assert.equal(stranger.status, 401);
});
test('PHONE-08: connected только после authenticated hello', async (t) => {
  const f = await ready(t);
  const issued = await issuePhone(f);
  const url = `/api/devices/phone-pairing/${issued.attemptId}`;
  const progress = async () => (await phoneAdmin(f, 'GET', url)).json();

  assert.equal((await progress()).status, 'pending');

  const paired = await clientRequest(f, '/api/client/pair', { code: issued.payload.pair.code });

  assert.equal(paired.status, 200);
  assert.equal((await progress()).status, 'pending', 'pair ещё не подтверждает новый authenticated канал');
  await phoneAdmin(f, 'GET', '/api/client/hello');
  assert.equal((await progress()).status, 'pending', 'cookie не является телефоном');

  const other = await f.devices.add({
    name: 'Другой',
    fp: f.stranger.fp,
    scope: 'client'
  });

  await clientRequest(f, '/api/client/hello', undefined, f.stranger);
  assert.equal((await progress()).status, 'pending', `чужой device ${other.id} не подтверждает попытку`);
  await clientRequest(f, '/api/client/hello');

  const connected = await progress();

  assert.equal(connected.status, 'connected');
  assert.equal(connected.device.id, paired.body.device.id);
});
test('PHONE-09: session-only rename/revoke и no secrets', async (t) => {
  const f = await ready(t);
  const issued = await issuePhone(f);
  const paired = await clientRequest(f, '/api/client/pair', { code: issued.payload.pair.code });
  const id = paired.body.device.id;
  const operations = [
    ['GET', '/api/devices/access'],
    ['PUT', '/api/devices/access/direct', { enabled: false }],
    ['POST', '/api/devices/phone-pairing', {}],
    ['GET', `/api/devices/phone-pairing/${issued.attemptId}`],
    ['PATCH', `/api/devices/${id}`, { name: 'Новое имя' }],
    ['POST', `/api/devices/${id}/revoke`],
  ];

  for (const [method, url, payload] of operations) {
    for (const headers of [
      {},
      { 'x-grigdesk-token': 'phone-cli' },
      { 'x-grigdesk-internal': 'phone-internal' },
    ]) {
      const result = await phoneAdmin(f, method, url, payload, headers);

      assert.equal(result.statusCode, Object.keys(headers).length ? 403 : 401, `${method} ${url}`);
    }
  }
  for (const name of ['', 'x'.repeat(41)]) {
    const denied = await phoneAdmin(f, 'PATCH', `/api/devices/${id}`, { name });

    assert.equal(denied.statusCode, 400);
  }

  const renamed = await phoneAdmin(f, 'PATCH', `/api/devices/${id}`, { name: 'Мой телефон' });

  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal((await f.devices.list())[0].name, 'Мой телефон');

  for (const url of ['/api/devices', '/api/devices/access',
    `/api/devices/phone-pairing/${issued.attemptId}`]) {
    const publicResult = await phoneAdmin(f, 'GET', url);

    assert.equal(publicResult.statusCode, 200);
    assert.equal(publicResult.headers['cache-control'], 'no-store');

    for (const secret of [issued.payload.pair.code, f.client.fp]) {
      assert.equal(publicResult.body.includes(secret), false, url);
    }
  }

  assert.equal((await phoneAdmin(f, 'POST', `/api/devices/${id}/revoke`)).statusCode, 200);
  assert.equal((await clientRequest(f, '/api/private')).status, 403);
});
test('PHONE-09: срок кода и forwarded не обходят общий лимит bootstrap', async (t) => {
  const f = await ready(t);
  const issued = await issuePhone(f);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const client = attempt % 2 ? f.stranger : f.client;
    const response = await clientRequest(f, '/api/client/pair', {
      code: 'x'.repeat(32),
    }, client, { 'x-forwarded-for': `192.0.2.${attempt + 1}`, forwarded: `for=192.0.2.${attempt + 1}` });

    assert.equal(response.status, attempt < 5 ? 401 : 429);
  }

  assert.equal((await clientRequest(f, '/api/client/pair', {
    code: issued.payload.pair.code,
  })).status, 429);
  assert.equal((await f.devices.list()).length, 0);
});


test('PHONE-09: обновление QR не продлевает исходный срок и не принимает старый код', async (t) => {
  let now = Date.now();

  t.mock.method(Date, 'now', () => now);

  const f = await ready(t);
  const old = await issuePhone(f);

  now += 599000;

  const refreshed = await issuePhone(f);

  assert.notEqual(refreshed.payload.pair.code, old.payload.pair.code);
  assert.equal(old.payload.pair.exp + 599000, refreshed.payload.pair.exp);
  now += 1001;

  const progress = await phoneAdmin(f, 'GET', `/api/devices/phone-pairing/${old.attemptId}`);

  assert.equal(progress.statusCode, 200);
  assert.equal(progress.json().status, 'expired');
  assert.equal((await clientRequest(f, '/api/client/pair', { code: old.payload.pair.code })).status, 401);

  const paired = await clientRequest(f, '/api/client/pair', { code: refreshed.payload.pair.code });

  assert.equal(paired.status, 200);
});


test('PHONE-07: превышение ёмкости QR даёт qr_too_large вместо 503', async (t) => {
  const f = await ready(t);
  const longHost = 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.' + 'c'.repeat(63);
  const response = await phoneAdmin(f, 'POST', '/api/devices/phone-pairing', {
    direct: Array.from({ length: 8 }, (_, index) => ({
      host: `${index}.${longHost}.example`,
      port: f.port,
    })),
  });

  assert.ok(response.statusCode >= 400 && response.statusCode < 500, response.body);
  assert.equal(response.json().error, 'qr_too_large');
  assert.match(response.json().message, /сократ|адрес/i);
});
