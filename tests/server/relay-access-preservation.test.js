import assert from 'node:assert/strict';
import test from 'node:test';

import { clientRequest } from './helpers/clientAccess.js';
import { phoneFixture, phoneAdmin, issuePhone } from './helpers/phoneAccess.js';
import { freePort } from './helpers/pluginBootFixture.js';
import { deploymentFixture, fileSnapshot } from './helpers/relayDeployment.js';

test('RP-01: offline и новый owner сохраняют identity, env и устройства побайтно', async (t) => {
  const f = await deploymentFixture(t);
  const relay = await f.mobile.addRelay({
    name: 'Дом',
    host: '127.0.0.1',
    port: 443
  });

  await f.mobile.devices.add({
    name: 'Телефон',
    fp: 'a'.repeat(64),
    scope: 'client'
  });

  const env = await f.mobile.relayEnv(relay.id);
  const before = await fileSnapshot(f.directory);

  assert.equal((await f.mobile.status()).relays[0].link.state, 'offline');
  await f.mobile.close();

  const restored = await deploymentFixture(t, { directory: f.directory });

  assert.equal(await restored.mobile.relayEnv(relay.id), env);
  assert.deepEqual(await fileSnapshot(f.directory), before);
  assert.equal((await restored.mobile.devices.list()).length, 1);
  assert.equal((await restored.mobile.relays.list()).length, 1);
});

test('RP-02: два действительных PHONE:2 с одним сертификатом сохраняют deviceId', async (t) => {
  const f = await phoneFixture(t);

  f.port = await freePort();

  const enabled = await phoneAdmin(f, 'PUT', '/api/devices/access/direct', {
    enabled: true,
    addresses: [{ host: f.host, port: f.port }],
  });

  assert.equal(enabled.statusCode, 200, enabled.body);

  const ids = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const qr = await issuePhone(f);
    const pair = await clientRequest(f, '/api/client/pair', { code: qr.payload.pair.code });

    assert.equal(pair.status, 200);
    ids.push(pair.body.device.id);
    assert.equal((await phoneAdmin(f, 'GET',
      `/api/devices/phone-pairing/${qr.attemptId}`)).json().status, 'pending');

    const hello = await clientRequest(f, '/api/client/hello');

    assert.equal(hello.status, 200);
    assert.equal(hello.body.device.id, ids[0]);
    assert.equal((await phoneAdmin(f, 'GET',
      `/api/devices/phone-pairing/${qr.attemptId}`)).json().status, 'connected');
  }

  assert.equal(ids[0], ids[1]);
  assert.equal((await f.devices.list()).length, 1);
});
