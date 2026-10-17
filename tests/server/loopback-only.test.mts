import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import type { FastifyInstance } from '../../server/node_modules/fastify/fastify.js';
import { AuthStore } from '../../server/src/lib/authStore.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import authModule from '../../server/src/modules/auth/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const configUrl = new URL('../../server/src/config.ts', import.meta.url).href;
const origin = 'http://127.0.0.1:28140';
const windowKey = 'LOOPBACK_WINDOW_KEY_MARKER'.padEnd(43, '_');

interface ConfigProbe {
  host: string;
  port: number;
  githubWebhookBaseUrl: string;
}

/**
 * Конфигурация читается в отдельном процессе с синтетическим окружением.
 * Проба не наследует настройки Cockpit и возвращает только проверяемые поля.
 */
async function readConfig(t: TestContext, extraEnv: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-loopback-config-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const source = `
    import { config } from ${JSON.stringify(configUrl)};
    process.stdout.write(JSON.stringify({
      host: config.host,
      port: config.port,
      githubWebhookBaseUrl: config.githubWebhookBaseUrl,
    }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      NODE_ENV: 'test',
      ...extraEnv,
    },
  });

  return JSON.parse(output) as ConfigProbe;
}

/**
 * Сессия выдаётся только обменом ключа окна, а общий гард проверяется настоящим плагином.
 * Fastify использует адрес сокета и не доверяет заголовкам пересылки.
 */
async function authFixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-loopback-auth-'));
  const authStore = new AuthStore({
    legacyAccountPath: path.join(root, 'account.json'),
    sessionsPath: path.join(root, 'sessions.json'),
  });
  const app: FastifyInstance = Fastify({ logger: false });

  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  await app.register(authPlugin, { authStore });
  await app.register(authModule, { authStore, windowAuth: { origin, key: windowKey } });
  app.get('/api/private', async (request) => ({ ip: request.ip, protocol: request.protocol }));

  return app;
}

/**
 * Cookie выдаётся только обменом ключа и остаётся ограниченной хостом.
 * Снятие сессии удалённым путём выхода больше не существует и её не отзывает.
 */
function assertLocalCookie(value: string | string[] | undefined): string {
  assert.equal(typeof value, 'string');

  const cookie = value as string;

  assert.match(cookie, /(?:^|; )Path=\//u);
  assert.match(cookie, /(?:^|; )HttpOnly(?:;|$)/u);
  assert.match(cookie, /(?:^|; )SameSite=Lax(?:;|$)/u);
  assert.doesNotMatch(cookie, /(?:^|; )(?:Domain=|Secure(?:;|$))/iu);
  assert.match(cookie, /(?:^|; )Max-Age=[1-9]\d*(?:;|$)/u);

  return cookie.split(';', 1)[0]!;
}

test('LO-01: сервер выбирает только loopback и сохраняет настройку порта', async (t) => {
  for (const host of [undefined, '0.0.0.0', '::', '192.0.2.10']) {
    const config = await readConfig(t, host === undefined ? {} : { COCKPIT_HOST: host });

    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 8140);
  }

  assert.equal((await readConfig(t, { COCKPIT_PORT: '28140' })).port, 28140);
});

test('LO-02: GitHub callback задаётся только явной переменной', async (t) => {
  const legacy = await readConfig(t, { COCKPIT_PUBLIC_DOMAIN: 'example.test' });
  const explicit = await readConfig(t, {
    COCKPIT_GITHUB_WEBHOOK_BASE_URL: 'https://hooks.example.test/hooks/github',
  });

  assert.equal(legacy.githubWebhookBaseUrl, '');
  assert.equal(explicit.githubWebhookBaseUrl, 'https://hooks.example.test/hooks/github');
});

test('LO-08: cookie обмена ключа ограничена хостом, а удалённый выход не отзывает сессию', async (t) => {
  const app = await authFixture(t);
  const headers = {
    host: new URL(origin).host,
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '192.0.2.10',
  };
  const forwarded = await app.inject({
    method: 'POST',
    url: '/api/auth/window-session',
    remoteAddress: '127.0.0.1',
    headers: {
      ...headers,
      'x-cockpit-window-key': windowKey,
    },
  });

  assert.equal(forwarded.statusCode, 403);
  assert.equal(forwarded.json().error, 'local_only');
  assert.equal(forwarded.headers['set-cookie'], undefined);

  const exchange = await app.inject({
    method: 'POST',
    url: '/api/auth/window-session',
    remoteAddress: '127.0.0.1',
    headers: {
      host: new URL(origin).host,
      'x-cockpit-window-key': windowKey,
    },
  });

  assert.equal(exchange.statusCode, 200);

  const cookie = assertLocalCookie(exchange.headers['set-cookie']);
  const authorized = { host: new URL(origin).host, cookie };
  const privateView = await app.inject({
    method: 'GET',
    url: '/api/private',
    remoteAddress: '127.0.0.1',
    headers: authorized,
  });

  assert.equal(privateView.statusCode, 200);
  assert.deepEqual(privateView.json(), { ip: '127.0.0.1', protocol: 'http' });

  const removedLogout = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: authorized,
  });

  assert.equal(removedLogout.statusCode, 404);
  assert.equal(removedLogout.headers['set-cookie'], undefined);
  assert.equal((await app.inject({
    url: '/api/private',
    headers: { cookie },
  })).statusCode, 200);
});

test('удалённые парольные пути недоступны и с локального адреса', async (t) => {
  const app = await authFixture(t);

  for (const path of ['/api/auth/setup', '/api/auth/login', '/api/auth/password',
    '/api/auth/logout-all']) {
    const anonymous = await app.inject({
      method: 'POST',
      url: path,
      remoteAddress: '127.0.0.1',
      payload: { login: 'test', password: 'test-password-123' },
    });
    const withCookie = await app.inject({
      method: 'POST',
      url: path,
      remoteAddress: '127.0.0.1',
      headers: { cookie: 'cockpit_sid=fixture-session' },
      payload: { login: 'test', password: 'test-password-123' },
    });

    assert.ok([401, 404].includes(anonymous.statusCode), `${path}: ${anonymous.statusCode}`);
    assert.equal(anonymous.headers['set-cookie'], undefined, path);
    assert.equal(anonymous.json().needsSetup, undefined, path);
    assert.equal(withCookie.statusCode, 404, path);
    assert.equal(withCookie.headers['set-cookie'], undefined, path);
  }
});
