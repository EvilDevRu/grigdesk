import assert from 'node:assert/strict';
import https from 'node:https';
import test from 'node:test';

import { DeviceStore } from '../../server/src/lib/mobile/store.ts';
import { makeCert } from '../relay/helpers.js';
import { freePort, pluginBootFixture } from './helpers/pluginBootFixture.js';

/**
 * Основной HTTP listen наступает раньше onListen клиентского входа.
 * Ждём только выделенный тесту TLS-порт, не обращаясь к адресу рабочего сервера.
 */
async function waitClient(port, client) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const result = await new Promise((resolve) => {
      const outgoing = https.get({
        hostname: '127.0.0.1',
        port,
        path: '/api/auth/state',
        key: client.keyPem,
        cert: client.certPem,
        rejectUnauthorized: false,
        agent: false,
      }, (incoming) => {
        let body = '';

        incoming.on('data', (chunk) => body += chunk);
        incoming.on('end', () => resolve({
          status: incoming.statusCode,
          body: JSON.parse(body),
          api: incoming.headers['x-grigdesk-api'],
        }));
      });

      outgoing.setTimeout(1000, () => outgoing.destroy());
      outgoing.on('error', () => resolve(null));
    });

    if (result) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return null;
}

test('клиентский вход: настоящий app запускает TLS после mobile.start', { timeout: 45000 }, async (t) => {
  const clientPort = await freePort();
  let client;
  const fixture = await pluginBootFixture(t, {
    env: { GRIGDESK_CLIENT_LISTEN: `127.0.0.1:${clientPort}` },
    before: async ({ root, env }) => {
      client = await makeCert(root, 'client');

      const devices = new DeviceStore(env.GRIGDESK_MOBILE_DIR);

      await devices.add({
        name: 'Тестовый клиент',
        fp: client.fp,
        scope: 'client',
      });
    },
  });
  const state = await waitClient(clientPort, client);

  assert.ok(state, 'onListen должен открыть настроенный клиентский TLS-вход');
  assert.equal(state.status, 200);
  assert.equal(state.api, '0.1');
  assert.equal(state.body.authenticated, true);
  assert.equal(state.body.method, 'device');
  assert.equal((await fixture.get('/api/health')).status, 200);
});
