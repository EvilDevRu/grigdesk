import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

import { AuthStore } from '../../server/src/lib/authStore.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import authModule from '../../server/src/modules/auth/index.ts';
import staticPlugin from '../../server/src/plugins/static.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const origin = 'http://127.0.0.1:28140';
const windowKey = 'DESKTOP_ONLY_WINDOW_KEY_MARKER'.padEnd(43, '_');
const SHELL_MARKER = 'SPA_SHELL_MARKER_UNIQUE';
const ASSET_MARKER = 'SPA_ASSET_MARKER_UNIQUE';
const SHOT_MARKER = 'SHOT_MARKER_UNIQUE';
const DENIED_TITLE = 'GrigDesk открывается в приложении';
const legacyCookie = 'grigdesk_sid=legacy-session-marker';

/**
 * Старый каталог интерфейса намеренно оставлен рядом с настоящими auth/static.
 * Его маркеры не должны появляться ни при каких учётных данных; снимки остаются закрыты.
 */
async function accessFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-desktop-only-'));
  const webDist = path.join(root, 'web-dist');
  const pluginWeb = path.join(root, 'plugin-web');
  const stateDir = path.join(root, 'state');

  await mkdir(path.join(webDist, 'assets'), { recursive: true });
  await mkdir(pluginWeb, { recursive: true });
  await mkdir(path.join(stateDir, 'shots'), { recursive: true });
  await writeFile(path.join(webDist, 'index.html'),
    `<!doctype html><html><body><div id="app">${SHELL_MARKER}</div></body></html>`);
  await writeFile(path.join(webDist, 'assets', 'app-fixture.js'), `window.${ASSET_MARKER} = 1;\n`);
  await writeFile(path.join(webDist, 'logo-fixture.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(stateDir, 'shots', 't1-fixture.png'), SHOT_MARKER);
  await writeFile(path.join(pluginWeb, 'index.html'), `<p>${SHELL_MARKER} plugin</p>`);

  const authStore = new AuthStore({
    legacyAccountPath: path.join(root, 'auth/account.json'),
    sessionsPath: path.join(root, 'auth/sessions.json'),
  });
  const app = Fastify({ logger: false });

  await app.register(requireFromServer('@fastify/websocket'));
  await app.register(authPlugin, {
    authStore,
    cliToken: 'test-cli-token',
    internalToken: 'test-internal-token',
  });
  await app.register(authModule, { authStore, windowAuth: { origin, key: windowKey } });
  await app.register(staticPlugin, { stateDir });
  app.get('/api/private', async (request) => ({ authKind: request.authKind }));
  app.post('/api/private', async (request) => ({ authKind: request.authKind }));
  await app.register(async (scope) => {
    scope.get('/value', async () => ({ ok: true }));
    scope.get('/stream', async (_request, reply) => {
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.write('data: hello\n\n');
    });
    scope.get('/ws', { websocket: true }, (socket) => {
      socket.send('upgraded');
    });
    await scope.register(requireFromServer('@fastify/static'), {
      root: pluginWeb,
      prefix: '/web/',
      decorateReply: false,
    });
  }, { prefix: '/api/ext/demo' });

  let githubReached = false;

  app.post('/hooks/github/:ingressRef', async () => {
    githubReached = true;

    return { ok: true };
  });

  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const exchange = await app.inject({
    method: 'POST',
    url: '/api/auth/window-session',
    remoteAddress: '127.0.0.1',
    headers: {
      host: new URL(origin).host,
      'x-grigdesk-window-key': windowKey,
    },
  });

  assert.equal(exchange.statusCode, 200, exchange.payload);

  return {
    app,
    address,
    authStore,
    githubReached: () => githubReached,
    sessionCookie: exchange.headers['set-cookie'].split(';')[0],
  };
}

/** Upgrade проверяется настоящим сокетом: отказ обязан быть HTTP-ответом, а не 101. */
function upgradeRequest(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.alloc(16, 1).toString('base64'),
        ...headers,
      },
    }, resolve);

    request.on('error', reject);
  });
}

test('DO-01: UI и ассеты отсутствуют, снимки и API требуют входа', async (t) => {
  const fixture = await accessFixture(t);
  const absent = [
    ['GET', '/'],
    ['HEAD', '/'],
    ['GET', '/index.html'],
    ['GET', '/chats'],
    ['GET', '/assets/app-fixture.js'],
    ['HEAD', '/assets/app-fixture.js'],
  ];

  for (const [method, url] of absent) {
    for (const headers of [{}, { cookie: legacyCookie }, { cookie: fixture.sessionCookie }]) {
      const response = await fixture.app.inject({
        method,
        url,
        headers,
      });
      const place = `${method} ${url}`;

      assert.equal(response.statusCode, 404, place);
      assert.equal(response.payload.includes(SHELL_MARKER), false, place);
      assert.equal(response.payload.includes(ASSET_MARKER), false, place);
      assert.equal(response.headers['cache-control'], 'no-store', place);
    }
  }

  for (const url of ['/shots/t1-fixture.png', '/api/private', '/api/ext/demo/web/', '/%61pi/private']) {
    for (const headers of [{}, { cookie: legacyCookie }]) {
      const response = await fixture.app.inject({
        url,
        headers,
      });

      assert.equal(response.statusCode, 401, url);
      assert.equal(response.payload.includes(SHELL_MARKER), false, url);
      assert.equal(response.payload.includes(ASSET_MARKER), false, url);
      assert.equal(response.payload.includes(SHOT_MARKER), false, url);
      assert.equal(response.headers['cache-control'], 'no-store', url);
    }

    const allowed = await fixture.app.inject({
      url,
      headers: { cookie: fixture.sessionCookie },
    });

    assert.equal(allowed.statusCode, 200, url);
  }
});

test('DO-02: навигация получает публичную инструкцию, ассет — JSON404', async (t) => {
  const fixture = await accessFixture(t);
  const navigation = await fixture.app.inject({
    method: 'GET',
    url: '/chats',
    headers: { accept: 'text/html,application/xhtml+xml' },
  });

  assert.equal(navigation.statusCode, 200);
  assert.match(navigation.headers['content-type'], /text\/html/u);
  assert.equal(navigation.payload.includes(DENIED_TITLE), true);
  assert.equal(navigation.payload.includes('<script'), false);
  assert.equal(/<[^>]+(?:src|href)=/u.test(navigation.payload), false);
  assert.equal(navigation.payload.includes('пароль'), false);
  assert.equal(navigation.payload.includes(SHELL_MARKER), false);
  assert.equal(navigation.headers['cache-control'], 'no-store');

  const asset = await fixture.app.inject({
    method: 'GET',
    url: '/assets/app-fixture.js',
    headers: { accept: '*/*' },
  });

  assert.equal(asset.statusCode, 404);
  assert.match(asset.headers['content-type'], /application\/json/u);
  assert.deepEqual(asset.json(), { error: 'not_found' });

  const electron = await fixture.app.inject({
    method: 'GET',
    url: '/',
    headers: {
      accept: 'text/html',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) GrigDeskWindow/main Electron/44.7.0',
    },
  });

  assert.equal(electron.statusCode, 200);
  assert.equal(electron.payload, navigation.payload);
});

test('DO-03: неизвестные API и POST не отдают SPA ни с сессией, ни без', async (t) => {
  const cases = [
    ['GET', '/api/unknown'],
    ['GET', '/%61pi/unknown'],
    ['GET', '/api/unknown?encoded=%2F'],
    ['POST', '/unknown'],
    ['POST', '/api/unknown'],
  ];

  const fixture = await accessFixture(t);

  for (const [method, url] of cases) {
    for (const headers of [{}, { cookie: fixture.sessionCookie }]) {
      const response = await fixture.app.inject({
        method,
        url,
        headers,
      });
      const place = `${method} ${url} ${JSON.stringify(headers)}`;

      assert.ok([401, 404].includes(response.statusCode), `${place}: ${response.statusCode}`);
      assert.equal(response.payload.includes(SHELL_MARKER), false, place);
      assert.equal(response.payload.includes('<html'), false, place);
    }

    const withSession = await fixture.app.inject({
      method,
      url,
      headers: { cookie: fixture.sessionCookie },
    });

    assert.equal(withSession.statusCode, 404, `${method} ${url} с сессией`);
    assert.match(withSession.headers['content-type'], /application\/json/u, `${method} ${url}`);
  }
});

test('DO-04: WebSocket защищённого маршрута не поднимается без сессии', async (t) => {
  const fixture = await accessFixture(t);
  const target = `${fixture.address}/api/ext/demo/ws`;
  const denied = await upgradeRequest(target);

  denied.resume();
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.headers.upgrade, undefined);

  const WebSocket = requireFromServer('ws');
  const client = new WebSocket(target.replace('http:', 'ws:'), {
    headers: { cookie: fixture.sessionCookie },
  });
  const [message] = await once(client, 'message');

  assert.equal(String(message), 'upgraded');
  client.close();
  await once(client, 'close');
});

test('DO-05: SSE защищённого маршрута закрыт без сессии', async (t) => {
  const fixture = await accessFixture(t);
  const denied = await new Promise((resolve, reject) => {
    http.get(`${fixture.address}/api/ext/demo/stream`, resolve).on('error', reject);
  });

  assert.equal(denied.statusCode, 401);
  denied.resume();
  await once(denied, 'end');

  const allowed = await new Promise((resolve, reject) => {
    http.get(`${fixture.address}/api/ext/demo/stream`, {
      headers: { cookie: fixture.sessionCookie },
    }, resolve).on('error', reject);
  });

  assert.equal(allowed.statusCode, 200);

  const reader = allowed[Symbol.asyncIterator]();
  const first = await reader.next();

  assert.equal(String(first.value).includes('data: hello'), true);
  await reader.return?.();
  allowed.destroy();
});

test('DO-06: CLI/internal открывают API и снимки, UI остаётся отсутствующим', async (t) => {
  const fixture = await accessFixture(t);

  const tokens = [
    { 'x-grigdesk-token': 'test-cli-token' },
    { 'x-grigdesk-internal': 'test-internal-token' },
  ];

  for (const token of tokens) {
    for (const [method, url] of [['GET', '/shots/t1-fixture.png'], ['GET', '/api/private'],
      ['GET', '/%61pi/private']]) {
      const response = await fixture.app.inject({
        method,
        url,
        headers: token,
      });

      assert.equal(response.statusCode, 200, `${method} ${url} ${JSON.stringify(token)}`);
    }

    for (const url of ['/', '/assets/app-fixture.js']) {
      const response = await fixture.app.inject({
        url,
        headers: token,
      });

      assert.equal(response.statusCode, 404, url);
      assert.equal(response.payload.includes(SHELL_MARKER), false, url);
      assert.equal(response.payload.includes(ASSET_MARKER), false, url);
    }
  }

  assert.equal((await fixture.app.inject({
    method: 'GET',
    url: '/api/private',
    headers: { 'x-grigdesk-token': 'test-cli-token' },
  })).json().authKind, 'cli');
});

test('DO-07: снятие cookie закрывает снимки, условный запрос не даёт304', async (t) => {
  const fixture = await accessFixture(t);
  const first = await fixture.app.inject({
    method: 'GET',
    url: '/shots/t1-fixture.png',
    headers: { cookie: fixture.sessionCookie },
  });
  const etag = first.headers.etag;

  assert.equal(first.statusCode, 200);

  const conditional = await fixture.app.inject({
    method: 'GET',
    url: '/shots/t1-fixture.png',
    headers: { 'if-none-match': String(etag) },
  });

  assert.equal(conditional.statusCode, 401);
  assert.equal(conditional.payload.includes(SHOT_MARKER), false);

  fixture.authStore.sessions.clear();

  const revoked = await fixture.app.inject({
    method: 'GET',
    url: '/shots/t1-fixture.png',
    headers: { cookie: fixture.sessionCookie },
  });

  assert.equal(revoked.statusCode, 401);
  assert.equal(revoked.payload.includes(SHOT_MARKER), false);
});

test('DO-08: нечитаемая cookie даёт 401, а не 500', async (t) => {
  const fixture = await accessFixture(t);

  for (const cookie of ['grigdesk_sid=%E0%A4%A', 'grigdesk_sid=%', 'grigdesk_sid=%zz']) {
    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/private',
      headers: { cookie },
    });

    assert.equal(response.statusCode, 401, cookie);
    assert.equal(response.statusCode === 500, false, cookie);
  }
});

test('DO-09: подписанный GitHub-хук доходит до своей проверки подписи', async (t) => {
  const fixture = await accessFixture(t);
  const response = await fixture.app.inject({
    method: 'POST',
    url: '/hooks/github/fixture-ref',
    payload: { fixture: true },
  });

  assert.equal(response.statusCode, 200, response.payload);
  assert.equal(fixture.githubReached(), true);
});

test('DO-10: браузерный fetch с Sec-Fetch-Dest: empty получает JSON 401', async (t) => {
  const fixture = await accessFixture(t);

  for (const url of ['/api/private', '/shots/t1-fixture.png']) {
    const response = await fixture.app.inject({
      method: 'GET',
      url,
      headers: { 'sec-fetch-dest': 'empty', accept: '*/*' },
    });

    assert.equal(response.statusCode, 401);
    assert.match(response.headers['content-type'], /application\/json/u, url);
    assert.equal(response.json().error, 'unauthorized');
  }
});
