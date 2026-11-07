import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';

import { AuthStore } from '../../server/src/lib/authStore.ts';
import { startClientListener } from '../../server/src/lib/clientAccess/listener.ts';
import { ensureBrainIdentity } from '../../server/src/lib/mobile/identity.ts';
import { DeviceStore } from '../../server/src/lib/mobile/store.ts';
import apiVersionPlugin from '../../server/src/plugins/apiVersion.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import ssePlugin from '../../server/src/plugins/sse.ts';
import { makeCert, temporary } from '../relay/helpers.js';
import { freePort } from './helpers/pluginBootFixture.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const websocket = requireFromServer('@fastify/websocket');
const WebSocket = requireFromServer('ws');

/**
 * Клиентский вход использует настоящие identity, DeviceStore и общий гард основного API.
 * Непривязанное соединение направляется отдельному bootstrap с наблюдаемым ответом 401.
 */
async function listenerFixture(t, options = {}) {
  const directory = await temporary(t);
  const identity = await ensureBrainIdentity(directory);
  const client = await makeCert(directory, 'client');
  const devices = new DeviceStore(directory);
  const app = Fastify({ bodyLimit: 6 * 1024 * 1024 });
  const bootstrap = Fastify();
  let listener;
  let effects = 0;

  t.after(async () => {
    await listener?.close();
    await Promise.all([app.close(), bootstrap.close()]);
  });
  await app.register(apiVersionPlugin);
  await app.register(authPlugin, {
    authStore: new AuthStore({
      legacyAccountPath: path.join(directory, 'account.json'),
      sessionsPath: path.join(directory, 'sessions.json'),
    }),
    cliToken: 'test-cli-token',
  });
  app.get('/api/private', async (request) => {
    effects += 1;

    return {
      protocol: request.protocol,
      device: request.authPrincipal,
    };
  });
  app.get('/health', async () => ({ ok: true }));
  await options.registerRoutes?.(app, directory);
  await app.listen({ host: '127.0.0.1', port: 0 });
  await bootstrap.register(apiVersionPlugin);
  bootstrap.setNotFoundHandler((_request, reply) => reply.code(401).send({ error: 'bootstrap' }));
  await bootstrap.ready();

  const device = options.unknown ? null : await devices.add({
    name: 'Тестовый клиент',
    fp: client.fp,
    scope: options.scope ?? 'client',
  });

  listener = await startClientListener({
    addresses: options.addresses ?? [{ host: '127.0.0.1', port: 0 }],
    identity,
    devices,
    app,
    bootstrap,
  });

  return {
    identity,
    client,
    devices,
    device,
    listener,
    app,
    bootstrap,
    effects: () => effects,
    port: Number(listener.state().addresses[0]?.split(':')[1]),
  };
}

/**
 * Запросы не используют общий TLS-кэш и закрывают соединение после полного ответа.
 * Все статусы читаются как данные: отказ входа не маскируется сетевой ошибкой клиента.
 */
function request(fixture, url = '/api/private', options = {}, body) {
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
      const reused = incoming.socket.isSessionReused();
      const peer = incoming.socket.getPeerX509Certificate()?.fingerprint256.replaceAll(':', '').toLowerCase();

      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');

        resolve({
          status: incoming.statusCode,
          headers: incoming.headers,
          body: text ? JSON.parse(text) : null,
          reused,
          peer,
        });
      });
    });

    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('request_timeout')));
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

/**
 * Держит поток открытым и отдаёт IncomingMessage до получения полного тела.
 * Это позволяет проверять доставку отдельных событий и разрыв соединения при отзыве.
 */
function openStream(fixture) {
  return new Promise((resolve, reject) => {
    const outgoing = https.get({
      hostname: '127.0.0.1',
      port: fixture.port,
      path: '/api/events',
      key: fixture.client.keyPem,
      cert: fixture.client.certPem,
      rejectUnauthorized: false,
      agent: false,
    }, resolve);

    outgoing.on('error', reject);
  });
}

/**
 * WebSocket проходит тот же TLS-вход и общий гард, что обычные HTTP-запросы.
 * Возвращаем готовый сокет с очисткой, чтобы не удерживать тест после упавшего утверждения.
 */
async function openWebSocket(t, fixture) {
  const socket = new WebSocket(`wss://127.0.0.1:${fixture.port}/api/ws`, {
    key: fixture.client.keyPem,
    cert: fixture.client.certPem,
    rejectUnauthorized: false,
  });

  t.after(() => socket.terminate());
  await once(socket, 'open');

  return socket;
}

/**
 * Открывает настоящий SSE-плагин и двунаправленный бинарный WebSocket.
 * Upload возвращает измеренную длину тела, а не размер, сообщённый клиентом в заголовке.
 */
async function registerTransportRoutes(app, directory) {
  await app.register(ssePlugin, { stateDir: directory });
  await app.register(websocket);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  app.post('/api/upload', async (request) => ({ size: request.body.length }));
  app.get('/api/ws', { websocket: true }, (socket) => {
    socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
}

/**
 * Проверяем разрыв за ограниченный срок, а после успеха снимаем сторож ожидания.
 * Отсутствующий disconnect становится ложным результатом утверждения, а не вечным зависанием файла.
 */
async function completesSoon(operation) {
  let timer;

  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('DeviceStore: scope сохраняется, у старых записей читается mobile-v1', async (t) => {
  const directory = await temporary(t);
  const devices = new DeviceStore(directory);
  const device = await devices.add({
    name: 'Новый клиент',
    fp: '1'.repeat(64),
    scope: 'client',
  });

  assert.equal(device.scope, 'client');
  assert.equal((await devices.findByFp(device.fp)).scope, 'client');

  const file = path.join(directory, 'devices.json');
  const legacy = JSON.parse(await readFile(file, 'utf8'));

  delete legacy.devices[0].scope;
  await writeFile(file, JSON.stringify(legacy));
  assert.equal((await devices.list())[0].scope, 'mobile-v1');
});

test('клиентский вход: client-сертификат попадает в основной app как HTTPS-устройство', async (t) => {
  const fixture = await listenerFixture(t);
  const response = await request(fixture);

  assert.equal(response.status, 200);
  assert.equal(response.body.protocol, 'https');
  assert.equal(response.body.device.kind, 'device');
  assert.equal(response.body.device.deviceId, fixture.device.id);
  assert.equal(response.headers['x-grigdesk-api'], '0.1');
  assert.equal(fixture.effects(), 1);
});

test('клиентский вход: mobile-v1 не получает основной API даже с верным CLI-токеном', async (t) => {
  const fixture = await listenerFixture(t, { scope: 'mobile-v1' });
  const response = await request(fixture, '/api/private', {
    headers: { 'x-grigdesk-token': 'test-cli-token' },
  });

  assert.equal(response.status, 403);
  assert.equal(fixture.effects(), 0);
});

test('клиентский вход: неизвестный сертификат и отсутствие сертификата идут в bootstrap', async (t) => {
  const fixture = await listenerFixture(t, { unknown: true });

  for (const options of [{}, { key: undefined, cert: undefined }]) {
    const response = await request(fixture, '/api/private', options);

    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'bootstrap');
    assert.equal(fixture.effects(), 0);
  }
});

test('клиентский вход: настоящий SSE частями, загрузка 5 МиБ и бинарный WebSocket 70 КиБ', async (t) => {
  const fixture = await listenerFixture(t, { registerRoutes: registerTransportRoutes });
  const incoming = await openStream(fixture);

  t.after(() => incoming.destroy());
  assert.equal(incoming.statusCode, 200);
  assert.equal(incoming.headers['x-grigdesk-api'], '0.1');

  const events = incoming[Symbol.asyncIterator]();
  const first = await events.next();

  assert.match(first.value.toString(), /event: hello/);
  fixture.app.sse.broadcast('test-one', { value: 1 });

  const second = await events.next();

  assert.match(second.value.toString(), /event: test-one/);
  fixture.app.sse.broadcast('test-two', { value: 2 });

  const third = await events.next();

  assert.match(third.value.toString(), /event: test-two/);
  incoming.destroy();

  const payload = randomBytes(5 * 1024 * 1024);
  const upload = await request(fixture, '/api/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
  }, payload);

  assert.equal(upload.status, 200);
  assert.equal(upload.body.size, payload.length);

  const socket = await openWebSocket(t, fixture);
  const echoed = once(socket, 'message');
  const binary = randomBytes(70 * 1024);

  socket.send(binary);

  const [data, isBinary] = await echoed;

  assert.equal(isBinary, true);
  assert.deepEqual(data, binary);
});

test('клиентский вход: отзыв разрывает WebSocket и долгий SSE, новый запрос получает 403', async (t) => {
  const fixture = await listenerFixture(t, { registerRoutes: registerTransportRoutes });
  const incoming = await openStream(fixture);

  incoming.on('error', () => {});
  incoming.resume();

  const socket = await openWebSocket(t, fixture);
  const streamClosed = new Promise((resolve) => incoming.once('close', resolve));
  const socketClosed = once(socket, 'close');

  await fixture.devices.revoke(fixture.device.id);
  fixture.listener.disconnect(fixture.client.fp);

  assert.equal(await completesSoon(Promise.all([streamClosed, socketClosed])), true);
  assert.equal(socket.readyState, WebSocket.CLOSED);

  const response = await request(fixture);

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'device_revoked');
  assert.equal(fixture.effects(), 0);
});

test('клиентский вход: второе соединение не возобновляет TLS-сессию и сохраняет сертификаты', async (t) => {
  const fixture = await listenerFixture(t);
  const agent = new https.Agent({
    keepAlive: false,
    maxCachedSessions: 8,
  });

  t.after(() => agent.destroy());

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await request(fixture, '/api/private', { agent });

    assert.equal(response.status, 200);
    assert.equal(response.reused, false);
    assert.equal(response.peer, fixture.identity.fp);
    assert.equal(response.body.device.deviceId, fixture.device.id);
  }
});

test('клиентский вход: занятый порт даёт state=error, основной app продолжает отвечать', async (t) => {
  const occupied = net.createServer();

  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');

  let fixture;

  await assert.doesNotReject(async () => {
    fixture = await listenerFixture(t, {
      addresses: [{ host: '127.0.0.1', port: occupied.address().port }],
    });
  });

  assert.equal(fixture.listener.state().state, 'error');
  assert.match(fixture.listener.state().error, /EADDRINUSE/);
  assert.deepEqual(fixture.listener.state().addresses, []);
  assert.equal((await fixture.app.inject('/health')).statusCode, 200);
});

test('клиентский вход: close закрывает переданный WebSocket и допускает повторный вызов', async (t) => {
  const fixture = await listenerFixture(t, { registerRoutes: registerTransportRoutes });
  const socket = await openWebSocket(t, fixture);
  const closed = once(socket, 'close');

  await fixture.listener.close();

  assert.equal(await completesSoon(closed), true);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.equal(fixture.listener.state().state, 'disabled');
  await fixture.listener.close();
});

test('клиентский вход: пустой список адресов оставляет вход выключенным', async (t) => {
  const fixture = await listenerFixture(t, { addresses: [] });

  assert.deepEqual(fixture.listener.state(), {
    state: 'disabled',
    addresses: [],
    error: null,
  });
  assert.equal((await fixture.app.inject('/health')).statusCode, 200);
});

test('клиентский вход: 25-е соединение одного сертификата не попадает в основной app', async (t) => {
  const fixture = await listenerFixture(t, { registerRoutes: registerTransportRoutes });

  for (let index = 0; index < 24; index += 1) {
    const incoming = await openStream(fixture);

    incoming.on('error', () => {});
    incoming.resume();
    assert.equal(incoming.statusCode, 200);
  }

  const excess = await request(fixture);

  assert.equal(excess.status, 403);
  assert.equal(excess.body.error, 'connection_limit');
  assert.equal(fixture.effects(), 0);
});

test('клиентский вход: общий предел 256 учитывает ещё не завершившие TLS сокеты', async (t) => {
  const fixture = await listenerFixture(t);
  const sockets = [];

  t.after(() => sockets.forEach((socket) => socket.destroy()));

  for (let index = 0; index < 256; index += 1) {
    const socket = net.connect({
      port: fixture.port,
      host: '127.0.0.1',
      localAddress: `127.1.${Math.floor(index / 254)}.${index % 254 + 1}`
    });

    sockets.push(socket);
    await once(socket, 'connect');
  }

  const excess = net.connect(fixture.port, '127.0.0.1');
  const closed = new Promise((resolve) => excess.once('close', resolve));

  sockets.push(excess);
  await once(excess, 'connect');
  assert.equal(await completesSoon(closed), true);
  assert.equal(sockets.slice(0, 256).every((socket) => !socket.destroyed), true);
});

test('клиентский вход: отказ второго bind закрывает уже открытый первый адрес', async (t) => {
  const occupied = net.createServer();

  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');

  const firstPort = await freePort();
  const fixture = await listenerFixture(t, {
    addresses: [
      { host: '127.0.0.1', port: firstPort },
      { host: '127.0.0.1', port: occupied.address().port },
    ],
  });
  const result = await new Promise((resolve) => {
    const socket = net.connect(firstPort, '127.0.0.1');

    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error) => resolve(error.code));
  });

  assert.equal(fixture.listener.state().state, 'error');
  assert.deepEqual(fixture.listener.state().addresses, []);
  assert.equal(result, 'ECONNREFUSED');
});


test('S1: молчащие непривязанные TLS не занимают места привязанного устройства', async (t) => {
  const fixture = await listenerFixture(t);
  const sockets = [];

  t.after(() => sockets.forEach((socket) => socket.destroy()));

  for (let index = 0; index < 48; index += 1) {
    const socket = tls.connect({
      host: '127.0.0.1',
      port: fixture.port,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3'
    });

    socket.on('error', () => {});
    sockets.push(socket);
    await new Promise((resolve) => {
      socket.once('secureConnect', resolve);
      socket.once('close', resolve);
    });
    socket.resume();
  }

  await delay(100);
  assert.ok(sockets.filter((socket) => !socket.destroyed).length <= 16);
  assert.equal((await request(fixture)).status, 200);
  await delay(3300);
  assert.equal(sockets.filter((socket) => !socket.destroyed).length, 0);
});

test('S1: байты незавершённого bootstrap не продлевают общий срок соединения',
  { timeout: 15000 }, async (t) => {
    const fixture = await listenerFixture(t);
    const socket = tls.connect({
      host: '127.0.0.1',
      port: fixture.port,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3'
    });

    t.after(() => socket.destroy());
    socket.on('error', () => {});
    await once(socket, 'secureConnect');
    socket.resume();
    socket.write('GET /api/client/hello HTTP/1.1\r\nX-Fixture: ');

    const drip = setInterval(() => socket.write('x'), 500);

    t.after(() => clearInterval(drip));
    await Promise.race([once(socket, 'close'), delay(11500)]);
    assert.equal(socket.destroyed, true);
  });

test('S4: отказ записи lastSeen не разрывает авторизованное соединение', async (t) => {
  const fixture = await listenerFixture(t);

  fixture.devices.touch = async () => {
    throw new Error('fixture_read_only');
  };

  const result = await request(fixture).catch(() => ({ status: 0 }));

  assert.equal(result.status, 200);
});


test('R1: незавершённые TLS одного IP ограничены16 и освобождаются по сроку',
  { timeout: 10000 }, async (t) => {
    const fixture = await listenerFixture(t);
    const sockets = [];

    t.after(() => sockets.forEach((socket) => socket.destroy()));

    for (let index = 0; index < 24; index += 1) {
      const socket = net.connect({
        host: '127.0.0.1',
        port: fixture.port,
        localAddress: '127.0.0.2'
      });

      socket.on('error', () => {});
      sockets.push(socket);
      await once(socket, 'connect');
      socket.resume();
    }

    await delay(100);
    assert.ok(sockets.filter((socket) => !socket.destroyed).length <= 16);
    assert.equal((await request(fixture)).status, 200);
    await delay(5500);
    assert.equal(sockets.filter((socket) => !socket.destroyed).length, 0);
  });

test('R1: таймаут ClientHello закрывает сырой TCP', { timeout: 9000 }, async (t) => {
  const fixture = await listenerFixture(t);
  const socket = net.connect(fixture.port, '127.0.0.1');

  t.after(() => socket.destroy());
  socket.on('error', () => {});
  socket.resume();
  await once(socket, 'connect');
  await delay(5600);
  assert.equal(socket.destroyed, true);
});
