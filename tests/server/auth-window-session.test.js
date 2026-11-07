import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { AuthStore } from '../../server/src/lib/authStore.ts';
import { writeWindowKey } from '../../server/src/lib/windowKey.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import authModule from '../../server/src/modules/auth/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const origin = 'http://127.0.0.1:28140';
const windowKey = 'WINDOW_KEY_UNIQUE_MARKER'.padEnd(43, '_');
const credentials = {
  login: 'test',
  password: 'test-password-123',
};

/**
 * AuthStore и журнал принадлежат одному временному root, реальный app не импортируется.
 * Настоящий общий гард позволяет отличить session от CLI и internal авторизации.
 */
async function authFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-window-auth-'));
  const authStore = new AuthStore({
    legacyAccountPath: path.join(root, 'account.json'),
    sessionsPath: path.join(root, 'sessions.json'),
    now: options.now,
  });
  let log = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      log += chunk;
      done();
    },
  });
  const app = Fastify({ logger: {
    level: 'info',
    stream,
  } });
  const windowAuth = options.windowAuth ?? {
    origin,
    key: windowKey,
  };

  t.after(async () => {
    await app.close();
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  await app.register(authPlugin, {
    authStore,
    cliToken: 'test-cli-token',
    internalToken: 'test-internal-token',
  });
  await app.register(authModule, {
    authStore,
    ...(options.withOption === false ? {} : { windowAuth }),
  });
  app.get('/api/private', async (request) => ({ authKind: request.authKind }));

  return {
    app,
    authStore,
    root,
    windowAuth,
    log: () => log,
  };
}

/**
 * Адрес сокета и Host задаются явно, без доверия к окружению тестового процесса.
 * Подслучаи меняют только те поля, отказ которых проверяют.
 */
function request(fixture, options = {}) {
  return fixture.app.inject({
    method: 'POST',
    url: '/api/auth/window-session',
    remoteAddress: '127.0.0.1',
    ...options,
    headers: {
      host: new URL(fixture.windowAuth.origin).host,
      ...options.headers,
    },
  });
}

/**
 * Отказы проверяются вместе с отсутствием cookie и запретом кэширования.
 * Это не позволяет случайному другому auth-пути скрыть ошибку обмена ключа.
 */
function assertDenied(response, status, error) {
  assert.equal(response.statusCode, status);
  assert.equal(response.json().error, error);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
}

test('DW-A1: ключ выдаёт сессию', async (t) => {
  const fixture = await authFixture(t);
  const response = await request(fixture, { headers: { 'x-grigdesk-window-key': windowKey } });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });

  const setCookie = response.headers['set-cookie'];

  assert.equal(typeof setCookie, 'string');
  assert.match(setCookie, /; Path=\/; HttpOnly; SameSite=Lax; Max-Age=[1-9]\d*$/u);
  assert.doesNotMatch(setCookie, /(?:Domain=|; Secure)/iu);

  const cookie = setCookie.split(';')[0];
  const state = await request(fixture, {
    method: 'GET',
    url: '/api/auth/state',
    headers: { cookie },
  });
  const privateView = await request(fixture, {
    method: 'GET',
    url: '/api/private',
    headers: { cookie },
  });

  assert.equal(state.json().authenticated, true);
  assert.equal(privateView.statusCode, 200);
  assert.deepEqual(privateView.json(), { authKind: 'session' });

  const rotated = 'ROTATED_WINDOW_KEY'.padEnd(43, '_');

  fixture.windowAuth.key = rotated;
  assertDenied(await request(fixture, { headers: { 'x-grigdesk-window-key': windowKey } }),
    401, 'bad_window_key');
  assert.equal((await request(fixture, {
    headers: { 'x-grigdesk-window-key': rotated },
  })).statusCode, 200);
});

test('DW-A2: неверный ключ не создаёт сессию', async (t) => {
  const fixture = await authFixture(t);

  for (const key of [undefined, 'B'.repeat(43), '', 'A'.repeat(42), 'A'.repeat(44), '!'.repeat(43),
    [windowKey, windowKey]]) {
    const headers = key === undefined ? {} : { 'x-grigdesk-window-key': key };

    assertDenied(await request(fixture, { headers }), 401, 'bad_window_key');
    assert.equal(fixture.authStore.sessions.size, 0);
  }
});

test('DW-A3: локальность по сокету и всем forwarded', async (t) => {
  const fixture = await authFixture(t);
  const headers = { 'x-grigdesk-window-key': windowKey };

  assertDenied(await request(fixture, {
    remoteAddress: '192.0.2.10',
    headers,
  }), 403, 'local_only');

  for (const header of ['forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host']) {
    for (const value of ['', 'test']) {
      assertDenied(await request(fixture, {
        headers: {
          ...headers,
          [header]: value,
        },
      }), 403, 'local_only');
    }
  }

  assert.equal(fixture.authStore.sessions.size, 0);

  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal((await request(fixture, {
      remoteAddress,
      headers,
    })).statusCode, 200);
  }
});

test('DW-A4: другой способ авторизации не заменяет ключ', async (t) => {
  const fixture = await authFixture(t);
  const cookie = `grigdesk_sid=${fixture.authStore.createSession().id}`;
  const alternatives = [
    { 'x-grigdesk-token': 'test-cli-token' },
    { 'x-grigdesk-internal': 'test-internal-token' },
    { cookie },
  ];

  for (const headers of alternatives) {
    assertDenied(await request(fixture, { headers }), 401, 'bad_window_key');
  }

  assert.equal((await request(fixture, {
    method: 'GET',
    url: '/api/private',
  })).statusCode, 401);

  for (const [index, authKind] of ['cli', 'internal', 'session'].entries()) {
    const response = await request(fixture, {
      method: 'GET',
      url: '/api/private',
      headers: alternatives[index],
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().authKind, authKind);
  }

  const response = await request(fixture, {
    headers: {
      ...alternatives[0],
      'x-grigdesk-window-key': windowKey,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal((await request(fixture, {
    method: 'GET',
    url: '/api/private',
    headers: { cookie: response.headers['set-cookie'].split(';')[0] },
  })).json().authKind, 'session');
});

test('DW-A5: парольные пути и выход удалены', async (t) => {
  const fixture = await authFixture(t);
  const cookie = `grigdesk_sid=${fixture.authStore.createSession().id}`;
  const variants = [
    ['без cookie', {}],
    ['с сессией', { cookie }],
    ['с CLI-токеном', { 'x-grigdesk-token': 'test-cli-token' }],
    ['с internal-токеном', { 'x-grigdesk-internal': 'test-internal-token' }],
  ];

  for (const path of ['/api/auth/login', '/api/auth/setup', '/api/auth/password',
    '/api/auth/logout', '/api/auth/logout-all']) {
    for (const [label, headers] of variants) {
      const before = fixture.authStore.sessions.size;
      const response = await request(fixture, {
        url: path,
        headers,
        payload: credentials,
      });
      const place = `${path} ${label}`;

      assert.equal(response.headers['set-cookie'], undefined, place);
      assert.equal(fixture.authStore.sessions.size, before, place);
      assert.doesNotMatch(String(response.headers['content-type'] ?? ''), /text\/html/u, place);

      if (headers.cookie !== undefined || headers['x-grigdesk-token'] !== undefined
        || headers['x-grigdesk-internal'] !== undefined) {
        assert.equal(response.statusCode, 404, place);
        assert.match(String(response.headers['content-type'] ?? ''), /application\/json/u, place);
      } else {
        assert.ok([401, 404].includes(response.statusCode), `${place}: ${response.statusCode}`);
        assert.equal(response.json().needsSetup, undefined, place);
      }
    }
  }

  assert.equal((await request(fixture, {
    method: 'GET',
    url: '/api/private',
    headers: { cookie },
  })).statusCode, 200);
});

test('DW-A11: состояние входа описывает вход по ключу', async (t) => {
  const fixture = await authFixture(t);
  const anonymous = await request(fixture, { method: 'GET', url: '/api/auth/state' });

  assert.equal(anonymous.statusCode, 200);
  assert.deepEqual(Object.keys(anonymous.json()).sort(),
    ['authenticated', 'configured', 'method', 'secure']);
  assert.deepEqual(anonymous.json(), {
    method: 'window-key',
    configured: true,
    authenticated: false,
    secure: false,
  });
  assert.equal(anonymous.headers['cache-control'], 'no-store');

  const exchange = await request(fixture, { headers: { 'x-grigdesk-window-key': windowKey } });
  const authorized = await request(fixture, {
    method: 'GET',
    url: '/api/auth/state',
    headers: { cookie: exchange.headers['set-cookie'].split(';')[0] },
  });

  assert.equal(authorized.json().authenticated, true);
  assert.equal(authorized.json().configured, true);
  assert.equal(authorized.json().method, 'window-key');
  assert.equal(authorized.headers['cache-control'], 'no-store');
  assert.equal(JSON.stringify(authorized.json()).includes('hash'), false);

  const withoutKey = await authFixture(t, { windowAuth: { origin, key: null } });

  assert.equal((await request(withoutKey, {
    method: 'GET',
    url: '/api/auth/state',
  })).json().configured, false);
});

test('DW-A12: отказ гарда не обещает пароль и не кэшируется', async (t) => {
  const fixture = await authFixture(t);
  const denied = await request(fixture, { method: 'GET', url: '/api/private' });

  assert.equal(denied.statusCode, 401);
  assert.equal(denied.headers['cache-control'], 'no-store');
  assert.deepEqual(denied.json(), {
    error: 'unauthorized',
    message: 'Требуется вход в GrigDesk.',
  });
});

test('DW-A6: ключ недоступен', async (t) => {
  const noOption = await authFixture(t, { withOption: false });
  const nullKey = await authFixture(t, { windowAuth: {
    origin,
    key: null,
  } });

  assertDenied(await request(noOption), 503, 'window_key_unavailable');
  assertDenied(await request(nullKey, {
    remoteAddress: '192.0.2.10',
    headers: {
      host: 'foreign.test',
      'x-grigdesk-window-key': windowKey,
    },
  }), 503, 'window_key_unavailable');
  await chmod(nullKey.root, 0o750);
  await assert.rejects(writeWindowKey(path.join(nullKey.root, 'key')));
  assertDenied(await request(nullKey), 503, 'window_key_unavailable');
});

test('DW-A7: Origin и Host не доверяют странице', async (t) => {
  const fixture = await authFixture(t);
  const wrongHeaders = [
    { origin: 'https://foreign.test' },
    { origin: 'null' },
    { origin: 'http://127.0.0.1:28141' },
    { origin: origin + '/' },
    { host: 'rebind.test:28140' },
    { host: '127.0.0.1:28141' },
    { 'sec-fetch-site': 'cross-site' },
  ];

  for (const headers of wrongHeaders) {
    assertDenied(await request(fixture, {
      headers: {
        ...headers,
        'x-grigdesk-window-key': windowKey,
      },
    }), 403, 'bad_window_origin');
    assertDenied(await request(fixture, {
      headers: {
        ...headers,
        'x-grigdesk-window-key': 'B'.repeat(43),
      },
    }), 403, 'bad_window_origin');
  }

  for (const headers of [{}, { origin }]) {
    assert.equal((await request(fixture, {
      headers: {
        ...headers,
        'x-grigdesk-window-key': windowKey,
      },
    })).statusCode, 200);
  }

  const standardPort = await authFixture(t, {
    windowAuth: {
      origin: 'http://127.0.0.1',
      key: windowKey,
    },
  });

  for (const host of ['127.0.0.1', '127.0.0.1:80']) {
    assert.equal((await request(standardPort, {
      headers: {
        host,
        origin: 'http://127.0.0.1',
        'x-grigdesk-window-key': windowKey,
      },
    })).statusCode, 200);
  }
});

test('DW-A8: секрет не журналируется и ответ не кэшируется', async (t) => {
  const fixture = await authFixture(t);
  const badKey = 'BAD_WINDOW_KEY_UNIQUE_MARKER'.padEnd(43, '_');
  const success = await request(fixture, { headers: { 'x-grigdesk-window-key': windowKey } });
  const failed = await request(fixture, { headers: { 'x-grigdesk-window-key': badKey } });

  assert.equal(success.statusCode, 200);
  assertDenied(failed, 401, 'bad_window_key');
  assert.equal(success.headers['cache-control'], 'no-store');

  const cookie = success.headers['set-cookie'].split(';')[0].split('=')[1];

  assert.equal(fixture.log().includes(windowKey), false);
  assert.equal(fixture.log().includes(badKey), false);
  assert.equal(fixture.log().includes(cookie), false);
});

test('DW-A9: неудачные обмены не блокируют вход, а удалённый выход не отзывает сессию', async (t) => {
  const fixture = await authFixture(t);

  for (let index = 0; index < 12; index += 1) {
    assertDenied(await request(fixture), 401, 'bad_window_key');
  }

  const response = await request(fixture, { headers: { 'x-grigdesk-window-key': windowKey } });
  const cookie = response.headers['set-cookie'].split(';')[0];
  const removedLogout = await request(fixture, {
    url: '/api/auth/logout',
    headers: { cookie },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(removedLogout.statusCode, 404);
  assert.equal(removedLogout.headers['set-cookie'], undefined);
  assert.equal((await request(fixture, {
    method: 'GET',
    url: '/api/private',
    headers: { cookie },
  })).statusCode, 200);
});

test('DW-A10: форма, preflight и query не выдают сессию', async (t) => {
  const fixture = await authFixture(t);
  const cases = [
    { payload: { key: windowKey } },
    { url: '/api/auth/window-session?key=' + windowKey },
    {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'key=' + windowKey,
    },
    { method: 'OPTIONS' },
  ];

  for (const options of cases) {
    const response = await request(fixture, options);

    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(fixture.authStore.sessions.size, 0);

    if (options.method !== 'OPTIONS') {
      assert.notEqual(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  }
});

test('ключ окна: short=1 даёт сессию на 600 секунд, обычный вход сохраняет 400 дней', async (t) => {
  let now = 1;
  const fixture = await authFixture(t, { now: () => now });
  const short = await request(fixture, {
    url: '/api/auth/window-session?short=1',
    headers: { 'x-grigdesk-window-key': windowKey },
  });

  assert.equal(short.statusCode, 200);
  assert.match(short.headers['set-cookie'], /Max-Age=600(?:;|$)/);

  const sid = short.headers['set-cookie'].split(';')[0].split('=')[1];

  assert.equal(fixture.authStore.isValidSession(sid), true);
  now += 600000;
  assert.equal(fixture.authStore.isValidSession(sid), false);

  const regular = await request(fixture, { headers: { 'x-grigdesk-window-key': windowKey } });

  assert.match(regular.headers['set-cookie'], /Max-Age=34560000(?:;|$)/);
});
