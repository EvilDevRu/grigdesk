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
const credentials = { login: 'test', password: 'test-password-123' };

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
 * Вход и общий гард проверяются с настоящим хранилищем во временном каталоге.
 * Fastify использует адрес сокета и не доверяет заголовкам пересылки.
 */
async function authFixture(t: TestContext, configured = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-loopback-auth-'));
  const authStore = new AuthStore({
    accountPath: path.join(root, 'account.json'),
    sessionsPath: path.join(root, 'sessions.json'),
  });
  const app: FastifyInstance = Fastify({ logger: false });

  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  if (configured) {
    authStore.setCredentials(credentials);
  }

  await app.register(authPlugin, { authStore });
  await app.register(authModule, { authStore });
  app.get('/api/private', async (request) => ({ ip: request.ip, protocol: request.protocol }));

  return app;
}

/**
 * Cookie остаётся ограниченной выдавшим её хостом, а HTTP не получает Secure.
 * Проверяем атрибуты и для создания сессии, и для её удаления.
 */
function assertLocalCookie(value: string | string[] | undefined, cleared = false): string {
  assert.equal(typeof value, 'string');

  const cookie = value as string;

  assert.match(cookie, /(?:^|; )Path=\//u);
  assert.match(cookie, /(?:^|; )HttpOnly(?:;|$)/u);
  assert.match(cookie, /(?:^|; )SameSite=Lax(?:;|$)/u);
  assert.doesNotMatch(cookie, /(?:^|; )(?:Domain=|Secure(?:;|$))/iu);

  if (cleared) {
    assert.match(cookie, /(?:^|; )Max-Age=0(?:;|$)/u);
  } else {
    assert.match(cookie, /(?:^|; )Max-Age=[1-9]\d*(?:;|$)/u);
  }

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

test('LO-08: локальный вход, cookie и выход игнорируют forwarded protocol/ip', async (t) => {
  const app = await authFixture(t);
  const headers = {
    host: 'example.test',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '192.0.2.10',
  };
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: '127.0.0.1',
    headers,
    payload: credentials,
  });

  assert.equal(login.statusCode, 200);

  const cookie = assertLocalCookie(login.headers['set-cookie']);
  const authorized = { ...headers, cookie };
  const privateView = await app.inject({
    method: 'GET',
    url: '/api/private',
    remoteAddress: '127.0.0.1',
    headers: authorized,
  });

  assert.equal(privateView.statusCode, 200);
  assert.deepEqual(privateView.json(), { ip: '127.0.0.1', protocol: 'http' });

  const logout = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: authorized,
  });

  assert.equal(logout.statusCode, 200);
  assertLocalCookie(logout.headers['set-cookie'], true);
  assert.equal((await app.inject({ url: '/api/private', headers: { cookie } })).statusCode, 401);
});

test('первичная настройка допускает localhost и отвергает каждый forwarded-заголовок', async (t) => {
  const local = await authFixture(t, false);
  const setup = await local.inject({
    method: 'POST',
    url: '/api/auth/setup',
    remoteAddress: '127.0.0.1',
    payload: credentials,
  });

  assert.equal(setup.statusCode, 200);
  assertLocalCookie(setup.headers['set-cookie']);

  for (const header of ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded']) {
    const app = await authFixture(t, false);
    const denied = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      remoteAddress: '127.0.0.1',
      headers: { [header]: 'test' },
      payload: credentials,
    });

    assert.equal(denied.statusCode, 403, header);
    assert.equal(denied.json().error, 'setup_local_only');
  }
});
