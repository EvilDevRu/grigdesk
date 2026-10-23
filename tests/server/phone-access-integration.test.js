import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import https from 'node:https';
import tls from 'node:tls';

import { connect, hello } from '../relay/helpers.js';
import { clientRequest } from './helpers/clientAccess.js';
import { issuePhone, phoneAdmin, phoneFixture } from './helpers/phoneAccess.js';
import { configuredRelay, relayRequest } from './helpers/phoneRelay.js';
import { freePort } from './helpers/pluginBootFixture.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const WebSocket = requireFromServer('ws');

/**
 * WebSocket проходит настоящий двойной TLS; оба pin проверяются до HTTP upgrade.
 * Клиент и агент принадлежат тесту и закрываются даже при отказе авторизации.
 */
async function relayWebSocket(t, f) {
  const outer = await connect(f.relay.port, f.relay.fp);

  t.after(() => outer.destroy());

  const ack = await hello(outer, {
    v: 2,
    role: 'device',
    target: 'client',
    token: f.relay.deviceToken,
  });

  assert.equal(ack.ok, true);

  const inner = tls.connect({
    socket: outer,
    key: f.client.keyPem,
    cert: f.client.certPem,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
  });

  await once(inner, 'secureConnect');

  const serverPin = inner.getPeerX509Certificate().fingerprint256.replaceAll(':', '').toLowerCase();

  assert.equal(serverPin, f.identity.fp);

  const agent = new https.Agent({ maxCachedSessions: 0 });

  agent.createConnection = () => inner;

  const ws = new WebSocket(`wss://127.0.0.1:${f.relay.port}/api/phone-ws`, { agent });

  t.after(() => {
    ws.terminate();
    agent.destroy();
  });
  await once(ws, 'open');

  return ws;
}

test('PHONE-16: две серверные личности и оба пути сохраняют владельца/отзыв', {
  timeout: 30000,
}, async (t) => {
  const local = await phoneFixture(t, { name: 'Локальная машина' });
  const remote = await phoneFixture(t, { name: 'Удалённая машина' });

  assert.notEqual(local.identity.fp, remote.identity.fp);

  for (const f of [local, remote]) {
    f.port = await freePort();

    const enabled = await phoneAdmin(f, 'PUT', '/api/devices/access/direct', {
      enabled: true,
      addresses: [{ host: f.host, port: f.port }],
    });

    assert.equal(enabled.statusCode, 200, enabled.body);
    f.relay = await configuredRelay(t, f);
    f.issued = await issuePhone(f);
    assert.equal(f.issued.payload.server.fp, f.identity.fp);
    assert.equal(f.issued.payload.server.name, f.config.serverName);
    assert.deepEqual(f.issued.payload.direct, [{ host: f.host, port: f.port }]);
    assert.equal(f.issued.payload.relay.id, f.relay.id);

    const paired = await clientRequest(f, '/api/client/pair', { code: f.issued.payload.pair.code });

    assert.equal(paired.status, 200);
    f.deviceId = paired.body.device.id;
    assert.equal((await relayRequest(f, f.relay, '/api/client/hello')).body.device.id, f.deviceId);
    assert.equal((await f.devices.list()).length, 1);
    assert.match((await relayRequest(f, f.relay, '/api/phone-stream')).text, /event: hello/);

    const file = Buffer.alloc(5 * 1024 * 1024, 37);

    assert.equal((await clientRequest(f, '/api/phone-file', file)).body.size, file.length);
    assert.equal((await relayRequest(f, f.relay, '/api/phone-file', file)).body.size, file.length);
    f.ws = await relayWebSocket(t, f);

    const received = once(f.ws, 'message');
    const bytes = Buffer.alloc(70 * 1024, 173);

    f.ws.send(bytes, { binary: true });
    assert.deepEqual((await received)[0], bytes);
  }

  const wrongOwner = await clientRequest(remote, '/api/client/pair', {
    code: local.issued.payload.pair.code,
  }, local.stranger);

  assert.equal(wrongOwner.status, 401);
  assert.notEqual(local.deviceId, remote.deviceId);

  const disconnected = once(local.ws, 'close');

  assert.equal((await phoneAdmin(local, 'POST', `/api/devices/${local.deviceId}/revoke`)).statusCode, 200);
  await disconnected;
  assert.equal(remote.ws.readyState, WebSocket.OPEN);
  assert.equal((await clientRequest(local, '/api/private')).status, 403);
  assert.equal((await relayRequest(local, local.relay, '/api/private')).status, 403);
  assert.equal((await clientRequest(remote, '/api/private')).status, 200);
  assert.equal((await relayRequest(remote, remote.relay, '/api/private')).status, 200);
});
