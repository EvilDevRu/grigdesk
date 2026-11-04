import assert from 'node:assert/strict';
import { constants } from 'node:crypto';
import { once } from 'node:events';
import https from 'node:https';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { AuthStore } from '../../server/src/lib/authStore.ts';
import { bindDevice, deviceOf, markRevoked } from '../../server/src/lib/clientAccess/principal.ts';
import trackerModule from '../../server/src/modules/tracker/index.ts';
import { ownTask, registerTasksModule, seedTasks, tasksFixture } from './helpers/grigdesk-tasks.js';

import authModule from '../../server/src/modules/auth/index.ts';
import authPlugin, { isLocalRequest, isSecureRequest } from '../../server/src/plugins/auth.ts';
import { makeCert, temporary } from '../relay/helpers.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const windowKey = 'TEST_WINDOW_KEY'.padEnd(43, '_');

/**
 * Настоящий TLS-вход отдаёт расшифрованный сокет основному HTTP-серверу Fastify.
 * Все сертификаты, сессии и порты изолированы; сборка app.ts и живой сервер не используются.
 */
async function principalFixture(t, registerModules = null) {
  const directory = await temporary(t);
  const identity = await makeCert(directory, 'server');
  const client = await makeCert(directory, 'client');
  const app = Fastify();
  const sockets = new Set();
  const authStore = new AuthStore({
    legacyAccountPath: path.join(directory, 'account.json'),
    sessionsPath: path.join(directory, 'sessions.json'),
  });
  const listener = tls.createServer({
    key: identity.keyPem,
    cert: identity.certPem,
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
    secureOptions: constants.SSL_OP_NO_TICKET,
    sessionTimeout: 1,
  }, (socket) => {
    const fp = socket.getPeerX509Certificate()?.fingerprint256.replaceAll(':', '').toLowerCase();

    if (fp === client.fp) {
      bindDevice(socket, {
        deviceId: 'test-device',
        fp,
      });
    }

    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    app.server.emit('connection', socket);
  });

  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }

    await Promise.all([
      app.close(),
      new Promise((resolve) => listener.close(resolve)),
    ]);
  });
  listener.on('newSession', (_id, _data, callback) => callback());
  listener.on('resumeSession', (_id, callback) => callback(null, null));
  await app.register(authPlugin, {
    authStore,
    cliToken: 'test-cli-token',
    internalToken: 'test-internal-token',
  });
  await app.register(authModule, {
    authStore,
    windowAuth: {
      origin: 'http://127.0.0.1:12345',
      key: windowKey,
    },
  });
  app.get('/api/private', async (request) => ({
    authKind: request.authKind,
    authPrincipal: request.authPrincipal,
    local: isLocalRequest(request),
    secure: isSecureRequest(request),
  }));

  if (registerModules) {
    await registerModules(app);
  }

  await app.listen({ host: '127.0.0.1', port: 0 });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');

  return {
    app,
    client,
    authStore,
    port: listener.address().port,
  };
}

/**
 * Запрос проходит TLS 1.3 с тестовым клиентским сертификатом без кэша сессий.
 * На каждый вызов создаётся отдельное соединение, которое закрывается после чтения ответа.
 */
function request(fixture, url = '/api/private', options = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = https.request({
      hostname: '127.0.0.1',
      port: fixture.port,
      path: url,
      key: fixture.client.keyPem,
      cert: fixture.client.certPem,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      agent: false,
      ...options,
    }, (incoming) => {
      const chunks = [];

      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        status: incoming.statusCode,
        headers: incoming.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });

    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('request_timeout')));
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('устройство: защищённый маршрут узнаёт session и субъект по TLS-сокету', async (t) => {
  const fixture = await principalFixture(t);
  const response = await request(fixture);

  assert.equal(response.status, 200);
  assert.equal(response.body.authKind, 'session');
  assert.deepEqual(response.body.authPrincipal, {
    kind: 'device',
    deviceId: 'test-device',
  });
});

test('устройство: поддельная cookie и верные CLI/internal-токены не меняют субъект', async (t) => {
  const fixture = await principalFixture(t);

  for (const cookie of ['grigdesk_sid=forged', `grigdesk_sid=${fixture.authStore.createSession().id}`]) {
    const response = await request(fixture, '/api/private', {
      headers: {
        cookie,
        'x-grigdesk-token': 'test-cli-token',
        'x-grigdesk-internal': 'test-internal-token',
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.authKind, 'session');
    assert.equal(response.body.authPrincipal.kind, 'device');
    assert.equal(response.body.authPrincipal.deviceId, 'test-device');
  }
});

test('устройство: TLS через loopback считается защищённым удалённым запросом', async (t) => {
  const fixture = await principalFixture(t);
  const response = await request(fixture);

  assert.equal(response.status, 200);
  assert.equal(response.body.local, false);
  assert.equal(response.body.secure, true);
});

test('устройство: auth/state подтверждает устройство и сохраняет прежний анонимный ответ', async (t) => {
  const fixture = await principalFixture(t);
  const device = await request(fixture, '/api/auth/state');

  assert.equal(device.status, 200);
  assert.deepEqual(device.body, {
    authenticated: true,
    method: 'device',
    configured: true,
    secure: true,
    clientScope: fixture.authStore.clientScope,
  });

  const anonymous = await request(fixture, '/api/auth/state', {
    key: undefined,
    cert: undefined,
  });

  assert.equal(anonymous.status, 200);
  assert.deepEqual(anonymous.body, {
    authenticated: false,
    method: 'window-key',
    configured: true,
    secure: true,
  });
});

test('устройство: даже верный ключ окна не обменивается на сессию', async (t) => {
  const fixture = await principalFixture(t);
  const response = await request(fixture, '/api/auth/window-session', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:12345',
      origin: 'http://127.0.0.1:12345',
      'x-grigdesk-window-key': windowKey,
    },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'local_only');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(fixture.authStore.sessions.size, 0);
});

test('устройство: отзыв распространяется на все записи отпечатка и на новые соединения', async (t) => {
  const fixture = await principalFixture(t);
  const agent = new https.Agent({
    keepAlive: true,
    maxCachedSessions: 0,
  });
  const first = new Socket();
  const second = new Socket();
  const other = new Socket();

  t.after(() => agent.destroy());
  bindDevice(first, {
    deviceId: 'test-device',
    fp: fixture.client.fp,
  });
  bindDevice(second, {
    deviceId: 'test-device',
    fp: fixture.client.fp,
  });
  bindDevice(other, {
    deviceId: 'other-device',
    fp: 'other-fingerprint',
  });

  const firstRecord = deviceOf(first);
  const secondRecord = deviceOf(second);

  assert.equal(firstRecord.revoked, false);
  assert.equal((await request(fixture, '/api/private', { agent })).status, 200);

  markRevoked(fixture.client.fp);

  assert.equal(firstRecord.revoked, true);
  assert.equal(secondRecord.revoked, true);
  assert.equal(deviceOf(other).revoked, false);

  for (const url of ['/api/private', '/api/auth/state', '/api/auth/window-session']) {
    const response = await request(fixture, url, {
      agent,
      method: url.endsWith('window-session') ? 'POST' : 'GET',
      headers: {
        'x-grigdesk-internal': 'test-internal-token',
        'x-grigdesk-token': 'test-cli-token',
      },
    });

    assert.equal(response.status, 403, url);
    assert.equal(response.body.error, 'device_revoked');
  }

  assert.equal((await request(fixture)).body.error, 'device_revoked');
});

test('DEVICE-B24-DETAIL-01: устройство читает карточку Б24 без cookie', async (t) => {
  const telegram = { links: [{ url: 'https://t.me/example_channel/42', text: 'Обсуждение' }] };
  const fx = await principalFixture(t, async (app) => {
    app.decorate('telegramDiscussion', async () => telegram);
    await app.register(trackerModule, {
      tracker: {
        async taskDetail(id) {
          assert.equal(String(id), '42');

          return {
            id: 42,
            title: 'Портальная задача',
            description: '<p>Исходный текст</p>'
          };
        },
      },
    });
  });
  const response = await request(fx, '/api/tracker/task/42');

  assert.equal(response.status, 200);
  assert.equal(response.body.description, '<p>Исходный текст</p>');
  assert.deepEqual(response.body.telegram, telegram);

  const anonymous = await request(fx, '/api/tracker/task/42', { key: undefined, cert: undefined });

  assert.equal(anonymous.status, 401);
  markRevoked(fx.client.fp);
  assert.equal((await request(fx, '/api/tracker/task/42')).status, 403);
});

test('LOCAL-DETAIL-03: устройство читает own и прежний Б24 по исходному TLS-транспорту', async (t) => {
  const storage = await tasksFixture(t, { configured: true });
  const task = ownTask();

  await seedTasks(storage.config, [task]);

  const fx = await principalFixture(t, async (app) => {
    await registerTasksModule(app, storage.moduleOptions);
    app.decorate('telegramDiscussion', async () => ({
      links: [{ url: 'https://t.me/example_channel/42' }],
    }));
    await app.register(trackerModule, { tracker: storage.moduleOptions.tracker });
  });
  const missing = await request(fx, '/api/grigdesk-tasks/42');

  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'grigdesk_task_not_found');

  const portal = await request(fx, '/api/tracker/task/42');

  assert.equal(portal.status, 200);
  assert.equal(portal.body.title, 'Задача портала');
  assert.equal(portal.body.telegram.links.length, 1);
  storage.portalCalls.length = 0;

  const own = await request(fx, `/api/grigdesk-tasks/${task.id}`);

  assert.equal(own.status, 200);
  assert.deepEqual(own.body, task);
  assert.deepEqual(storage.portalCalls, []);
});
