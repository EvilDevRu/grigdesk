import assert from 'node:assert/strict';
import https from 'node:https';
import test from 'node:test';
import tls from 'node:tls';

import { ensureBrainIdentity } from '../../server/src/lib/mobile/identity.ts';
import { startMobileServer } from '../../server/src/lib/mobile/mobileServer.ts';
import { PairingCodes } from '../../server/src/lib/mobile/pairing.ts';
import { DeviceStore } from '../../server/src/lib/mobile/store.ts';
import { makeCert, temporary } from '../relay/helpers.js';

/**
 * Проверяет пин до передачи HTTP по уже готовому TLS-сокету.
 * Клиент не доверяет системным CA и использует только синтетические ключи.
 */
async function request(server, identity, client, path, method = 'GET', body, headers = {}) {
  const socket = tls.connect({
    host: '127.0.0.1',
    port: server.port,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
    ...(client
      ? {
          key: client.keyPem,
          cert: client.certPem,
        }
      : {}),
  });

  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });
  assert.equal(
    socket.getPeerX509Certificate().fingerprint256.replaceAll(':', '').toLowerCase(),
    identity.fp,
  );

  const agent = new https.Agent();

  agent.createConnection = () => socket;

  return new Promise((resolve, reject) => {
    const outgoing = https.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path,
        method,
        agent,
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
      },
      (incoming) => {
        let result = '';

        incoming.on('data', (chunk) => {
          result += chunk;
        });
        incoming.on('end', () => {
          agent.destroy();
          resolve({
            status: incoming.statusCode,
            body: JSON.parse(result),
          });
        });
      },
    );

    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('MB-09…MB-12/MB-25/MB-30: guard, pair, отзыв и durable POST на отдельном loopback', async (t) => {
  const directory = await temporary(t);
  const identity = await ensureBrainIdentity(directory);
  const client = await makeCert(directory, 'device');
  const devices = new DeviceStore(directory);
  const pairing = new PairingCodes({ devices });
  let effects = 0;
  const server = await startMobileServer({
    identity,
    deviceStore: devices,
    pairing,
    directory,
    port: 0,
    registerRoutes(app) {
      app.get('/api/mobile/v1/chats', () => ({ chats: [] }));
      app.post('/api/mobile/v1/test', () => ({ value: ++effects }));
    },
  });

  t.after(() => server.close());
  assert.equal(server.app.server.address().address, '127.0.0.1');
  assert.equal((await request(server, identity, null, '/api/mobile/v1/hello')).body.device, null);
  assert.equal((await request(server, identity, null, '/api/mobile/v1/chats')).status, 401);
  assert.equal(
    (await request(server, identity, null, '/api/mobile/v1/pair', 'POST', {})).body.error,
    'no_client_cert',
  );

  const code = pairing.issue().code;
  const paired = await request(server, identity, client, '/api/mobile/v1/pair', 'POST', {
    code,
    name: 'Телефон',
  });

  assert.equal(paired.status, 200);
  assert.equal(
    (await request(server, identity, client, '/api/mobile/v1/hello')).body.device.name,
    'Телефон',
  );

  const headers = {
    'Idempotency-Key': 'operation-one',
    'X-Cockpit-Operation-Created-At': String(Date.now()),
  };
  const first = await request(server, identity, client, '/api/mobile/v1/test', 'POST', {}, headers);

  assert.deepEqual(
    await request(server, identity, client, '/api/mobile/v1/test', 'POST', {}, headers),
    first,
  );
  assert.equal(effects, 1);
  assert.equal(
    (await request(server, identity, client, '/api/mobile/v1/test', 'POST', {})).status,
    400,
  );

  const device = await devices.findByFp(client.fp);

  await devices.revoke(device.id);
  server.disconnectDevice(client.fp);
  assert.equal(
    (await request(server, identity, client, '/api/mobile/v1/chats')).body.error,
    'device_revoked',
  );
});
