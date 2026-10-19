import assert from 'node:assert/strict';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import tls from 'node:tls';

import { AuthStore } from '../../../server/src/lib/authStore.ts';
import {
  createClientBootstrap,
  registerClientPairRoute,
} from '../../../server/src/lib/clientAccess/bootstrap.ts';
import { startClientListener } from '../../../server/src/lib/clientAccess/listener.ts';
import { ensureBrainIdentity } from '../../../server/src/lib/mobile/identity.ts';
import { PairingCodes } from '../../../server/src/lib/mobile/pairing.ts';
import { DeviceStore } from '../../../server/src/lib/mobile/store.ts';
import authPlugin from '../../../server/src/plugins/auth.ts';
import apiVersionPlugin from '../../../server/src/plugins/apiVersion.ts';
import { makeCert, temporary } from '../../relay/helpers.js';

const requireFromServer = createRequire(new URL('../../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

/**
 * Общий стенд привязки и устройств собирает реальный TLS-вход и основной гард.
 * Имена, ключи, порты и файлы синтетические; время кодов можно подменить без ожидания десяти минут.
 */
export async function clientFixture(t, options = {}) {
  const directory = await temporary(t);
  const identity = await ensureBrainIdentity(directory);
  const client = await makeCert(directory, 'client');
  const stranger = await makeCert(directory, 'stranger');
  const devices = new DeviceStore(directory);
  const pairing = new PairingCodes({ devices, now: options.now });
  const authStore = new AuthStore({
    legacyAccountPath: path.join(directory, 'account.json'),
    sessionsPath: path.join(directory, 'sessions.json'),
  });
  const app = Fastify();
  const bootstrap = await createClientBootstrap({
    pairing,
    identity: () => identity,
    name: 'Скрытое имя машины',
  });
  let listener;

  t.after(async () => {
    await listener?.close();
    await Promise.all([app.close(), bootstrap.close()]);
  });
  await app.register(apiVersionPlugin);
  await app.register(authPlugin, {
    authStore,
    cliToken: 'test-cli',
    internalToken: 'test-internal',
  });
  registerClientPairRoute(app, {
    pairing,
    identity: () => identity,
    name: 'Скрытое имя машины',
  });
  app.get('/api/private', async (request) => ({ deviceId: request.authPrincipal?.deviceId }));
  await options.register?.({
    app,
    devices,
    pairing,
    identity,
    listener: () => listener,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  listener = await startClientListener({
    addresses: [{ host: '127.0.0.1', port: 0 }],
    identity,
    devices,
    app,
    bootstrap,
  });

  return {
    app,
    devices,
    pairing,
    identity,
    client,
    stranger,
    listener,
    port: Number(listener.state().addresses[0].split(':')[1]),
    cookie: `grigdesk_sid=${authStore.createSession().id}`,
  };
}

/**
 * Проверяет сертификат сервера в рукопожатии до отправки HTTP-заголовков.
 * Каждый вызов открывает новый TLS без возобновления и полностью вычитывает JSON-ответ.
 */
export async function clientRequest(fixture, url, body, client = fixture.client) {
  const socket = tls.connect({
    host: '127.0.0.1',
    port: fixture.port,
    key: client?.keyPem,
    cert: client?.certPem,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
  });

  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('secureConnect', resolve);
  });
  assert.equal(socket.getPeerX509Certificate().fingerprint256.replaceAll(':', '').toLowerCase(),
    fixture.identity.fp);

  const agent = new https.Agent({ maxCachedSessions: 0 });

  agent.createConnection = () => socket;

  return new Promise((resolve, reject) => {
    const outgoing = https.request({
      hostname: '127.0.0.1',
      port: fixture.port,
      path: url,
      method: body === undefined ? 'GET' : 'POST',
      agent,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
    }, (incoming) => {
      let text = '';

      incoming.on('data', (chunk) => text += chunk);
      incoming.on('end', () => {
        agent.destroy();
        resolve({
          status: incoming.statusCode,
          headers: incoming.headers,
          body: text ? JSON.parse(text) : null,
        });
      });
    });

    outgoing.on('error', (error) => {
      agent.destroy();
      reject(error);
    });
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
