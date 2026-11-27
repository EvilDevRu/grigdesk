import assert from 'node:assert/strict';
import test from 'node:test';
import { issuePhone, phoneAdmin, phoneFixture } from './helpers/phoneAccess.js';
import { configuredRelay, relayRequest } from './helpers/phoneRelay.js';

test('PHONE-06: client relay при выключенном direct', { timeout: 15000 }, async (t) => {
  const f = await phoneFixture(t);
  const status = await phoneAdmin(f, 'GET', '/api/devices/access');

  assert.equal(status.statusCode, 200, status.body);

  const relay = await configuredRelay(t, f);
  const issued = await issuePhone(f, { relayId: relay.id });

  assert.deepEqual(issued.payload.direct, []);
  assert.equal(issued.payload.relay.id, relay.id);
  assert.equal(issued.payload.relay.token, relay.deviceToken);
  assert.equal(issued.payload.relay.fp, relay.fp);
  assert.equal(issued.payload.relay.protocol, 2);
  assert.equal(issued.payload.server.fp, f.identity.fp);

  const paired = await relayRequest(f, relay, '/api/client/pair', { code: issued.payload.pair.code });

  assert.equal(paired.status, 200);
  assert.equal((await relayRequest(f, relay, '/api/client/hello')).body.device.id, paired.body.device.id);
  assert.equal((await relayRequest(f, relay, '/api/private')).status, 200);
  assert.equal((await f.devices.list()).length, 1);

  const disabled = await phoneAdmin(f, 'PUT', '/api/devices/access/direct', { enabled: false });

  assert.equal(disabled.statusCode, 200);
  assert.equal((await relayRequest(f, relay, '/api/private')).status, 200);
});
test('PHONE-06/09: scope v1 и отзыв client не обходятся новым relay', { timeout: 15000 }, async (t) => {
  const f = await phoneFixture(t);
  const status = await phoneAdmin(f, 'GET', '/api/devices/access');

  assert.equal(status.statusCode, 200, status.body);

  const relay = await configuredRelay(t, f);

  await f.devices.add({
    name: 'Старый телефон',
    fp: f.stranger.fp,
    scope: 'mobile-v1'
  });

  const forbidden = await relayRequest(f, relay, '/api/private', undefined, f.stranger);

  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error, 'device_scope_forbidden');

  const issued = await issuePhone(f);
  const paired = await relayRequest(f, relay, '/api/client/pair', { code: issued.payload.pair.code });

  assert.equal(paired.status, 200);
  assert.equal((await phoneAdmin(f, 'POST', `/api/devices/${paired.body.device.id}/revoke`)).statusCode, 200);
  // Внешний token общий: relay пропускает, но private client TLS обязан отказать до API.
  const revoked = await relayRequest(f, relay, '/api/private');

  assert.equal(revoked.status, 403);
  assert.equal(revoked.body.error, 'device_revoked');
  assert.equal(revoked.body.deviceId, undefined);
});
test('PHONE-06: подмена relay в теле не выдаёт секреты чужого сервера', async (t) => {
  const f = await phoneFixture(t);
  const response = await phoneAdmin(f, 'POST', '/api/devices/phone-pairing', {
    relayId: 'rdeadbeef',
    relay: { host: 'attacker.example', token: 'attacker-token' },
  });

  assert.ok(response.statusCode >= 400 && response.statusCode < 500, response.body);
  assert.equal(response.json().text, undefined);
  assert.equal((await f.mobile.relays.list()).length, 0);
});
