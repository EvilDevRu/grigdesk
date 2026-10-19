import assert from 'node:assert/strict';
import test from 'node:test';

import { clientFixture, clientRequest } from './helpers/clientAccess.js';

test('привязка: hello скрывает имя, client-код связывает сертификат с именем из кода', async (t) => {
  const fixture = await clientFixture(t);
  const hello = await clientRequest(fixture, '/api/client/hello');

  assert.equal(hello.status, 200);
  assert.equal(hello.body.name, 'GrigDesk');
  assert.equal(hello.body.fp, fixture.identity.fp);
  assert.equal(hello.body.device, null);
  assert.equal(hello.headers['x-grigdesk-api'], '0.1');

  const issued = fixture.pairing.issue({ scope: 'client', name: 'Ноутбук' });
  const paired = await clientRequest(fixture, '/api/client/pair', {
    code: issued.code,
    name: 'Подмена',
    fp: fixture.stranger.fp,
  });

  assert.equal(paired.status, 200);
  assert.equal(paired.body.device.name, 'Ноутбук');
  assert.equal((await fixture.devices.findByFp(fixture.client.fp)).scope, 'client');
  assert.equal(await fixture.devices.findByFp(fixture.stranger.fp), null);
  assert.equal((await clientRequest(fixture, '/api/private')).body.deviceId, paired.body.device.id);
});

test('привязка: потерянный ответ допускает повтор тем же сертификатом на новом соединении', async (t) => {
  const fixture = await clientFixture(t);
  const issued = fixture.pairing.issue({ scope: 'client', name: 'Ноутбук' });
  const first = await clientRequest(fixture, '/api/client/pair', { code: issued.code });
  const repeated = await clientRequest(fixture, '/api/client/pair', { code: issued.code });

  assert.equal(first.status, 200);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.device.id, first.body.device.id);
  assert.equal((await fixture.devices.list()).length, 1);
  assert.equal((await clientRequest(fixture, '/api/client/pair', { code: 'invalid' })).status, 401);

  const stolen = await clientRequest(fixture, '/api/client/pair', { code: issued.code }, fixture.stranger);

  assert.equal(stolen.status, 401);
});

test('привязка: чужой scope, истёкший код и шестая ошибка не дают устройство', async (t) => {
  let now = 1;
  const fixture = await clientFixture(t, { now: () => now });
  const old = fixture.pairing.issue();

  assert.equal((await clientRequest(fixture, '/api/client/pair', { code: old.code })).status, 401);

  const expired = fixture.pairing.issue({ scope: 'client', name: 'Ноутбук' });

  now = expired.exp + 1;
  assert.equal((await clientRequest(fixture, '/api/client/pair', { code: expired.code })).status, 401);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await clientRequest(fixture, '/api/client/pair', { code: 'invalid' })).status, 401);
  }

  assert.equal((await clientRequest(fixture, '/api/client/pair', { code: 'invalid' })).status, 401);
  assert.equal((await clientRequest(fixture, '/api/client/pair', { code: 'invalid' })).status, 429);
  assert.deepEqual(await fixture.devices.list(), []);
});
