import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createServer } from '../../web/node_modules/vite/dist/node/index.js';
import localApiPlugin from '../../web/scripts/localApiPlugin.ts';
import { AuthStore } from '../../server/src/lib/authStore.ts';
import { writeWindowKey } from '../../server/src/lib/windowKey.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import apiVersionPlugin from '../../server/src/plugins/apiVersion.ts';
import authModule from '../../server/src/modules/auth/index.ts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');
const { WebSocket, WebSocketServer } = requireServer('ws');

/**
 * Настоящие auth-модуль и Vite используют только собственные файлы и случайные порты.
 * Счётчики видят обмен ключа и прикладные эффекты без состояния рабочего приложения.
 */
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-dev-auth-'));
  const keyFile = path.join(directory, 'private/key');
  const key = await writeWindowKey(keyFile);
  const store = new AuthStore({
    legacyAccountPath: path.join(directory, 'account.json'),
    sessionsPath: path.join(directory, 'sessions.json'),
  });
  const windowAuth = { origin: '', key };
  const calls = [];
  const app = Fastify();
  let valid = true;
  let vite;
  let sockets;

  t.after(async () => {
    await vite?.close();
    sockets?.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await app.register(apiVersionPlugin);
  app.addHook('onRequest', async (req, reply) => {
    calls.push({
      path: req.url,
      method: req.method,
      headers: req.headers,
    });

    if (!valid && req.url === '/api/private') {
      valid = true;
      reply.code(401).send({ error: 'expired' });
    }
  });
  await app.register(authPlugin, { authStore: store });
  await app.register(authModule, { authStore: store, windowAuth });
  app.all('/api/private', async (req) => ({ authKind: req.authKind }));
  app.get('/shots/probe', async () => ({ ok: true }));
  app.get('/api/events', async (_req, reply) => {
    reply.header('content-type', 'text/event-stream');

    return 'event: hello\ndata: {}\n\n';
  });
  windowAuth.origin = await app.listen({ host: '127.0.0.1', port: 0 });
  sockets = new WebSocketServer({ noServer: true });
  app.server.on('upgrade', (req, socket, head) => {
    calls.push({
      path: req.url,
      method: 'UPGRADE',
      headers: req.headers,
    });

    if (!store.isValidSession(req.headers.cookie?.split('=')[1])) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');

      return;
    }

    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => ws.send(data));
    });
  });
  vite = await createServer({
    configFile: false,
    root: new URL('../../web', import.meta.url).pathname,
    logLevel: 'silent',
    plugins: [localApiPlugin({
      port: Number(new URL(windowAuth.origin).port),
      env: { GRIGDESK_WINDOW_KEY_PATH: keyFile },
    })],
    server: {
      host: '127.0.0.1',
      port: 0,
      watch: null,
    },
    optimizeDeps: { noDiscovery: true },
  });
  await vite.listen();

  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;

  return {
    origin,
    calls,
    keyFile,
    expire: () => {
      valid = false;
    },
  };
}

/**
 * Низкоуровневый клиент проверяет Host и Sec-Fetch-Site без подмены socket.
 * Ответ вычитывается полностью, чтобы тест не оставлял соединений upstream.
 */
async function request(origin, route, headers = {}, method = 'GET') {
  return await new Promise((resolve, reject) => {
    const req = http.request(new URL(route, origin), { method, headers }, (res) => {
      const chunks = [];

      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });

    req.on('error', reject);
    req.end();
  });
}

test('dev: настоящий вход по ключу доступен странице без cookie и CLI-токена', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([
    request(f.origin, '/api/auth/state'),
    request(f.origin, '/api/private'),
    request(f.origin, '/shots/probe'),
  ]);

  assert.equal(JSON.parse(results[0].body).authenticated, true);
  assert.equal(JSON.parse(results[1].body).authKind, 'session');
  assert.equal(JSON.parse(results[2].body).ok, true);
  assert.equal(f.calls.filter((call) => call.path === '/api/auth/window-session').length, 1);

  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(result.headers['x-frame-options'], 'DENY');
  }
});

test('dev: чужой Origin, Host и cross-site не доходят даже до обмена ключа', async (t) => {
  const f = await fixture(t);

  for (const headers of [
    { origin: 'https://stranger.test' },
    { host: 'stranger.test' },
    { host: '127.0.0.1:1' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ]) {
    assert.equal((await request(f.origin, '/api/private', headers)).status, 403);
  }

  assert.equal(f.calls.length, 0);
});

test('dev: входящие секреты снимаются, SSE идёт через настоящую сессию', async (t) => {
  const f = await fixture(t);
  const response = await request(f.origin, '/api/events', {
    origin: f.origin,
    cookie: 'grigdesk_sid=foreign',
    'x-grigdesk-token': 'foreign',
    'x-grigdesk-window-key': 'foreign',
    'x-forwarded-for': 'stranger.test',
  });
  const forwarded = f.calls.find((call) => call.path === '/api/events').headers;

  assert.equal(response.status, 200);
  assert.match(response.body, /event: hello/u);
  assert.match(forwarded.cookie, /^grigdesk_sid=/u);
  assert.notEqual(forwarded.cookie, 'grigdesk_sid=foreign');
  assert.equal(forwarded['x-grigdesk-token'], undefined);
  assert.equal(forwarded['x-grigdesk-window-key'], undefined);
  assert.equal(forwarded['x-forwarded-for'], undefined);
  assert.notEqual(forwarded.origin, f.origin);
});

test('dev: GET восстанавливается после 401, отправленный POST не повторяется', async (t) => {
  const f = await fixture(t);

  f.expire();
  assert.equal((await request(f.origin, '/api/private')).status, 200);
  assert.equal(f.calls.filter((call) => call.path === '/api/private').length, 2);
  f.expire();
  assert.equal((await request(f.origin, '/api/private', {}, 'POST')).status, 401);
  assert.equal(f.calls.filter((call) => call.path === '/api/private' && call.method === 'POST').length, 1);
});

test('dev: небезопасный ключ закрывает доступ без поддельного authenticated:true', async (t) => {
  const f = await fixture(t);

  await chmod(f.keyFile, 0o644);

  const response = await request(f.origin, '/api/auth/state');

  assert.equal(response.status, 503);
  assert.equal(JSON.parse(response.body).authenticated, undefined);
  assert.equal(f.calls.length, 0);
});

test('dev: WebSocket получает сессию и проверяет Origin до upgrade', async (t) => {
  const f = await fixture(t);
  const url = f.origin.replace('http:', 'ws:') + '/api/terminal';
  const ws = new WebSocket(url, { origin: f.origin });

  await once(ws, 'open');

  const message = once(ws, 'message');

  ws.send(Buffer.from([1, 2, 3]));
  assert.deepEqual((await message)[0], Buffer.from([1, 2, 3]));
  ws.close();
  await once(ws, 'close');

  const denied = new WebSocket(url, { origin: 'https://stranger.test' });

  denied.on('error', () => {});
  await assert.rejects(once(denied, 'open'), /403/u);
  assert.equal(f.calls.filter((call) => call.method === 'UPGRADE').length, 1);
});

test('dev: сетевой host и HTTPS не открывают авторизованный транспорт', async () => {
  for (const server of [{ host: '0.0.0.0' }, { host: true }, { https: {} }]) {
    await assert.rejects(createServer({
      configFile: false,
      logLevel: 'silent',
      plugins: [localApiPlugin({ port: 1, env: {} })],
      server: { ...server, watch: null },
      optimizeDeps: { noDiscovery: true },
    }), /только на loopback HTTP/u);
  }
});
