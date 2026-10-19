import assert from 'node:assert/strict';
import https from 'node:https';

import { decodePairing } from '../../../../shared/client/pairingPayload.ts';
import { ensureBrainIdentity } from '../../../../server/src/lib/mobile/identity.ts';
import { freePort } from './common.mts';
import { server } from './harness.mts';

const root = process.argv[2]!;
const port = await freePort();
const client = await ensureBrainIdentity('/D/fixture-client');
const run = await server(root, {
  GRIGDESK_CLIENT_LISTEN: `127.0.0.1:${port}`,
  GRIGDESK_SERVER_NAME: 'SEA fixture server',
});

interface ClientResponse {
  status: number | undefined;
  api: string | string[] | undefined;
  body: Record<string, unknown>;
}

/**
 * Новый TLS-сокет предъявляет только сертификат одноразовой фикстуры.
 * Cookie основного входа не используется, проверяется настоящий device principal.
 */
function requestClient(route: string, body?: unknown): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = https.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method: body === undefined ? 'GET' : 'POST',
      key: client.keyPem,
      cert: client.certPem,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      agent: false,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
    }, (incoming) => {
      let text = '';

      incoming.on('data', (chunk: Buffer) => text += chunk.toString());
      incoming.once('error', reject);
      incoming.once('end', () => {
        try {
          resolve({
            status: incoming.statusCode,
            api: incoming.headers['x-grigdesk-api'],
            body: JSON.parse(text),
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    outgoing.setTimeout(1000, () => outgoing.destroy(new Error('TLS fixture timeout')));
    outgoing.once('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/**
 * HTTP готов раньше onListen TLS-входа, поэтому готовность доказывает его hello.
 * Срок ограничен, последняя ошибка сохраняется для диагностики реального пакета.
 */
async function clientHello(): Promise<ClientResponse> {
  const deadline = Date.now() + 10000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await requestClient('/api/client/hello');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(`Клиентский вход SEA не поднялся: ${String(lastError)}\n${run.log()}`);
}

try {
  const hello = await clientHello();

  assert.equal(hello.status, 200);
  assert.equal(hello.api, '0.1');
  assert.equal(hello.body.name, 'GrigDesk');
  assert.equal((await requestClient('/api/health')).status, 401);

  const issued = await run.request('/api/devices/pairing', 'POST', { name: 'SEA fixture device' });
  const payload = decodePairing(issued.text);
  const paired = await requestClient('/api/client/pair', { code: payload.code, name: 'SEA fixture device' });
  const device = paired.body.device as { id: string };

  assert.equal(payload.port, port);
  assert.equal(paired.status, 200);
  assert.equal((await requestClient('/api/health')).status, 200);

  const auth = await requestClient('/api/auth/state');

  assert.equal(auth.body.authenticated, true);
  assert.equal(auth.body.method, 'device');
  assert.equal((await requestClient('/api/client/hello')).body.name, 'SEA fixture server');
  assert.equal((await run.request('/api/devices')).devices[0].id, device.id);
  await run.request(`/api/devices/${device.id}/revoke`, 'POST');

  const revoked = await requestClient('/api/health');

  assert.equal(revoked.status, 403);
  assert.equal(revoked.body.error, 'device_revoked');
  console.log(JSON.stringify({
    clientTls: true,
    bootstrap: true,
    pairing: true,
    revoked: true,
  }));
} finally {
  assert.equal((await run.stop()).code, 0, run.log());
}
