import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AuthStore } from '../../../server/src/lib/authStore.ts';
import { createClientBootstrap, registerClientPairRoute } from
  '../../../server/src/lib/clientAccess/bootstrap.ts';
import { readClientConfig } from '../../../server/src/lib/clientAccess/config.ts';
import { startClientListener } from '../../../server/src/lib/clientAccess/listener.ts';
import { ensureBrainIdentity } from '../../../server/src/lib/mobile/identity.ts';
import { MobileService } from '../../../server/src/lib/mobile/service.ts';
import devicesModule from '../../../server/src/modules/devices/index.ts';
import authPlugin from '../../../server/src/plugins/auth.ts';
import apiVersionPlugin from '../../../server/src/plugins/apiVersion.ts';
import { makeCert } from '../../relay/helpers.js';

const requireFromServer = createRequire(new URL('../../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
/**
 * Стенд повторяет связку devicesModule → owner → прежний onListen без запуска рабочего app.
 * Синтетические сети и DNS передаются только зависимостями owner, не через HTTP-настройки.
 */
export async function phoneFixture(t, options = {}) {
  const directory = options.directory || await mkdtemp(path.join(
    process.env.GRIGDESK_TEST_ARTIFACTS_DIR || os.tmpdir(), 'phone-access-'));
  const identity = await ensureBrainIdentity(directory);
  const client = await makeCert(directory, 'client');
  const stranger = await makeCert(directory, 'stranger');
  const mobile = new MobileService({
    directory,
    port: 0,
    vpnGate: async () => true,
    ...options.mobileOptions,
  });
  const devices = mobile.devices;
  const pairing = mobile.pairing;
  const authStore = new AuthStore({
    legacyAccountPath: path.join(directory, 'account.json'),
    sessionsPath: path.join(directory, 'sessions.json'),
  });
  const app = Fastify({ bodyLimit: 6 * 1024 * 1024 });
  const config = {
    mobileDir: directory,
    serverName: options.name || 'Сервер лаборатории',
    clientAccess: readClientConfig(options.env || {}),
  };
  const host = Object.values(os.networkInterfaces()).flat()
    .find((item) => item.family === 'IPv4' && !item.internal)?.address;

  assert.ok(host, 'Изолированный сетевой стенд требует IPv4-интерфейс');

  const dependencies = {
    networkInterfaces: () => ({
      lan: [{
          address: host,
        family: 'IPv4',
        internal: false
        }],
      loopback: [{
          address: '127.0.0.1',
        family: 'IPv4',
        internal: true
        }],
    }),
    lookup: async () => [{ address: host, family: 4 }],
    ...options.dependencies,
  };
  const bootstrapOptions = {
    pairing,
    identity: () => identity,
    name: config.serverName
  };
  const bootstrap = await createClientBootstrap(bootstrapOptions);
  let listener;

  t.after(async () => {
    await listener?.close();
    await mobile.close();
    await app.close();
    await bootstrap.close();

    if (!options.directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await app.register(apiVersionPlugin);
  await app.register(authPlugin, {
    authStore,
    cliToken: 'phone-cli',
    internalToken: 'phone-internal'
  });
  registerClientPairRoute(app, bootstrapOptions);
  await app.register(requireFromServer('@fastify/websocket'));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' },
    (_request, body, done) => done(null, body));
  app.post('/api/phone-file', async (request) => ({ size: request.body.length }));
  app.get('/api/phone-ws', { websocket: true }, (socket) => {
    socket.on('message', (bytes, binary) => socket.send(bytes, { binary }));
  });
  app.get('/api/private', async (request) => ({ deviceId: request.authPrincipal?.deviceId }));
  app.get('/api/phone-hold', async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.write('data: held\n\n');
  });
  app.get('/api/phone-stream', async (_request, reply) => {
    reply.type('text/event-stream');

    return 'event: hello\ndata: {"fixture":true}\n\n';
  });
  await app.register(devicesModule, {
    devices,
    pairing,
    listener: () => listener,
    identity: () => identity,
    address: config.clientAccess.address,
    name: config.serverName,
    disconnectMobile: (fp) => mobile.disconnectDevice(fp),
    access: {
      root: app,
      mobile,
      config,
      dependencies
    },
  });

  if (options.registerAdmin) {
    await options.registerAdmin(app, { mobile, identity });
  }

  await app.listen({ host: '127.0.0.1', port: 0 });
  listener = await startClientListener({
    addresses: config.clientAccess.addresses,
    identity,
    devices,
    app,
    bootstrap,
  });

  return {
    app,
    directory,
    identity,
    client,
    stranger,
    mobile,
    devices,
    pairing,
    listener,
    host,
    cookie: `grigdesk_sid=${authStore.createSession().id}`,
    config,
  };
}
/**
 * Административный запрос всегда идёт в тот же экземпляр сервера с настоящим auth guard.
 * Успех выдачи проверяется до разбора QR, чтобы исходный 404 был явной причиной RED.
 */
export function phoneAdmin(fixture, method, url, payload, headers) {
  return fixture.app.inject({
    method,
    url,
    headers: headers ?? { cookie: fixture.cookie },
    ...(payload === undefined ? {} : { payload }),
  });
}
/**
 * Разбирает только новый конверт после успешного ответа телефонного маршрута.
 * Тест не вызывает будущий кодек для извлечения ожиданий из собственной фикстуры.
 */
export async function issuePhone(fixture, payload = {}) {
  const response = await phoneAdmin(fixture, 'POST', '/api/devices/phone-pairing', payload);

  assert.equal(response.statusCode, 200, response.body);

  const result = response.json();

  assert.match(result.text, /^GRIGDESK:PHONE:2:/);

  return {
    ...result,
    payload: JSON.parse(Buffer.from(result.text.slice('GRIGDESK:PHONE:2:'.length), 'base64url')),
  };
}
