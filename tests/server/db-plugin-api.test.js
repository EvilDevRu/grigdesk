import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { config } from '../../server/src/config.ts';
import { SYSTEM, isEnabled } from '../../server/src/lib/pluginsRegistry.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function dbModule() {
  try {
    return await import('../../server/src/modules/db/index.ts');
  } catch (error) {
    assert.fail(`live-gated API плагина «Базы» ещё не реализован: ${error.message}`);
  }
}

test('плагин «Базы» зарегистрирован системным и выключен по умолчанию', () => {
  const db = SYSTEM.find((plugin) => plugin.id === 'db');

  assert.deepEqual({
    system: db?.system,
    defaultEnabled: db?.defaultEnabled,
    enabledWithoutPrefs: db ? isEnabled({}, db) : null,
    nav: db?.nav,
  }, {
    system: true,
    defaultEnabled: false,
    enabledWithoutPrefs: false,
    nav: {
      path: '/db',
      label: 'Базы',
      icon: 'db',
      group: 'dock',
      order: 50,
    },
  });
});

test('безопасные настройки БД имеют утверждённые значения по умолчанию', () => {
  const settings = Object.fromEntries(
    (SYSTEM.find((plugin) => plugin.id === 'db')?.settings || [])
      .map((setting) => [setting.key, setting.default]),
  );

  assert.deepEqual(settings, {
    allowDdlAdmin: false,
    autoRead: false,
    autoReadProd: false,
    strictClientPolicy: false,
    maxRows: 1000,
    maxBytesKiB: 256,
    timeoutSeconds: 15,
    autoReadPerMinute: 10,
    idleCloseMinutes: 15,
  });
});

test('профили и журнал БД вынесены из prefs в приватные пути', () => {
  assert.deepEqual({
    profiles: config.dbProfilesPath?.endsWith('/state/db/profiles.json'),
    audit: config.dbAuditDir?.endsWith('/state/db/audit'),
    prefsIsDbState: config.prefsPath?.includes('/db/'),
  }, {
    profiles: true,
    audit: true,
    prefsIsDbState: false,
  });
});

test('каждый DB route проверяет живое выключение плагина', async (t) => {
  const module = await dbModule();
  const app = Fastify({ logger: false });
  app.decorateRequest('authKind', null);
  app.addHook('onRequest', async (request) => {
    request.authKind = 'session';
  });
  app.decorate('pluginEnabled', () => false);
  const service = new Proxy({}, {
    get() {
      return async () => ({ ok: true, engines: [], profiles: [], sessions: [], items: [] });
    },
  });
  await app.register(module.default, { service });
  t.after(() => app.close());
  const requests = [
    ['GET', '/api/db/engines'],
    ['GET', '/api/db/profiles'],
    ['POST', '/api/db/profiles', {}],
    ['PUT', '/api/db/profiles/fixture', {}],
    ['DELETE', '/api/db/profiles/fixture'],
    ['POST', '/api/db/profiles/fixture/sessions', Buffer.from('password')],
    ['GET', '/api/db/sessions'],
    ['PUT', '/api/db/sessions/session-a/agent-access', { allowed: true }],
    ['DELETE', '/api/db/sessions/session-a'],
    ['GET', '/api/db/sessions/session-a/schema'],
    ['POST', '/api/db/sessions/session-a/query', { text: 'SELECT 1' }],
    ['GET', '/api/db/queries'],
    ['GET', '/api/db/queries/query-a'],
    ['POST', '/api/db/queries/query-a/cancel', {}],
    ['GET', '/api/db/audit'],
    ['POST', '/api/db/approvals/pid-a', { allow: true }],
  ];
  const actual = [];
  for (const [method, url, payload] of requests) {
    const response = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      ...(Buffer.isBuffer(payload)
        ? { headers: { 'content-type': 'application/octet-stream' } }
        : {}),
    });
    actual.push([method, url, response.statusCode, response.json().error]);
  }

  assert.deepEqual(
    actual,
    requests.map(([method, url]) => [method, url, 404, 'plugin_disabled']),
  );
});
