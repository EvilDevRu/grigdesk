import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import providersModule from '../../server/src/modules/providers/index.ts';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import { syntheticProvider } from '../fixtures/executor-settings/syntheticProvider.js';
import { decodeProviderSettingsCatalog } from '../../shared/providerSettingsContracts.ts';
import authPlugin, { SESSION_COOKIE } from '../../server/src/plugins/auth.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

/**
 * Маршруты используют временный prefs и настоящий синхронный writer.
 * Только внешний CLI заменён синтетическим исполнителем.
 */
export async function nativeRouteFixture(t, provider = syntheticProvider(), { auth = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-routes-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const prefs = new PrefsStore({ prefsPath: path.join(root, 'prefs.json') });
  const app = Fastify({ logger: false });

  if (auth) {
    await app.register(authPlugin, {
      authStore: {
        isConfigured: () => true,
        isValidSession: (id) => id === 'native-settings-session',
      },
    });
  }

  await app.register(providersModule, {
    config: { rootDir: root, modelsPath: path.join(root, 'models.json') },
    prefs,
    getProviderAdapters: async () => new Map([[provider.id, provider]]),
  });
  t.after(() => app.close());

  return {
    app,
    prefs,
    provider,
    root,
  };
}

test('публичный каталог и POST сохраняют boolean для будущего запуска', async (t) => {
  const { app, prefs, provider } = await nativeRouteFixture(t);
  const read = await app.inject('/api/providers/future-provider/settings/catalog');

  assert.equal(read.statusCode, 200);
  assert.equal(read.json().protocolVersion, 1);

  const catalog = decodeProviderSettingsCatalog(read.json());

  assert.equal(catalog.fields[0]?.kind, 'boolean');

  const saved = await app.inject({
    method: 'POST',
    url: '/api/providers/future-provider/settings/overrides',
    payload: {
      fieldId: catalog.fields[0].id,
      operation: 'set',
      value: false,
      schemaRevision: catalog.schemaRevision,
      revision: catalog.revision,
    },
  });

  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().changed, true);
  assert.deepEqual(saved.json().catalog.fields[0].override, { state: 'known', value: false });
  assert.equal(prefs.read().providerSettings['future-provider'].nativeSettings.revision, 1);
  assert.equal(provider.discoveries(), 2, 'set перепроверяет источник внутри TTL');
});

test('исчезнувшая capability запрещает set по прежнему каталогу', async (t) => {
  const { app, prefs, provider } = await nativeRouteFixture(t);
  const before = prefs.read();
  const catalog = (await app.inject('/api/providers/future-provider/settings/catalog')).json();

  delete provider.nativeSettings;

  const saved = await app.inject({
    method: 'POST',
    url: '/api/providers/future-provider/settings/overrides',
    payload: {
      fieldId: catalog.fields[0].id,
      operation: 'set',
      value: false,
      schemaRevision: catalog.schemaRevision,
      revision: catalog.revision,
    },
  });

  assert.equal(saved.statusCode, 503);
  assert.equal(saved.json().error, 'settings_unavailable');
  assert.deepEqual(prefs.read(), before);
});

test('старый writer после async-проверки сохраняет новый native override', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const provider = syntheticProvider();
  const settings = provider.settings;

  provider.settings = async () => {
    entered.resolve();
    await release.promise;

    return settings;
  };

  const { app, prefs } = await nativeRouteFixture(t, provider);

  t.after(() => release.resolve());

  const read = await app.inject('/api/providers/future-provider/settings/catalog');
  const catalog = read.json();
  const old = app
    .inject({
      method: 'POST',
      url: '/api/providers/future-provider/settings',
      payload: { settingId: 'blockDirectSsh', value: false },
    })
    .then((response) => response);

  await entered.promise;

  const saved = await app.inject({
    method: 'POST',
    url: '/api/providers/future-provider/settings/overrides',
    payload: {
      fieldId: catalog.fields[0].id,
      operation: 'set',
      value: false,
      schemaRevision: catalog.schemaRevision,
      revision: '0',
    },
  });

  release.resolve();

  const local = await old;

  assert.equal(saved.statusCode, 200);
  assert.equal(local.statusCode, 200);
  assert.equal(prefs.read().providerSettings['future-provider'].blockDirectSsh, false);
  assert.equal(prefs.read().providerSettings['future-provider'].nativeSettings?.revision, 1);
});

test('реестр объявляет capability без вызова медленного discovery', async (t) => {
  const { app, provider } = await nativeRouteFixture(t);
  const read = await app.inject('/api/providers');

  assert.equal(read.statusCode, 200);
  assert.equal(read.json().providers[0]?.settingsCatalog, true);
  assert.equal(provider.discoveries(), 0);
});

test('unset работает с актуальной ревизией даже при недоступном контексте CLI', async (t) => {
  const { app, provider } = await nativeRouteFixture(t);
  const catalog = (await app.inject('/api/providers/future-provider/settings/catalog')).json();
  const saved = await app.inject({
    method: 'POST',
    url: '/api/providers/future-provider/settings/overrides',
    payload: {
      fieldId: '["enabled"]',
      operation: 'set',
      value: false,
      schemaRevision: catalog.schemaRevision,
      revision: catalog.revision,
    },
  });

  assert.equal(saved.statusCode, 200);

  provider.nativeSettings.context = () => {
    throw new Error('CLI удалён вместе с прежним профилем');
  };

  const reset = await app.inject({
    method: 'POST',
    url: '/api/providers/future-provider/settings/overrides',
    payload: {
      fieldId: '["enabled"]',
      operation: 'unset',
      schemaRevision: null,
      revision: saved.json().catalog.revision,
    },
  });

  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().catalog.revision, '2');
  assert.equal(provider.discoveries(), 2);
});

test('общий auth guard закрывает новые маршруты до discovery и допускает сессионную cookie', async (t) => {
  const { app, provider } = await nativeRouteFixture(t, syntheticProvider(), { auth: true });
  const url = '/api/providers/future-provider/settings';
  const anonymous = await app.inject(`${url}/catalog`);
  const denied = await app.inject({
    method: 'POST',
    url: `${url}/overrides`,
    payload: {},
  });
  const encoded = await app.inject('/%61pi/providers/future-provider/settings/catalog');

  assert.equal(anonymous.statusCode, 401);
  assert.equal(denied.statusCode, 401);
  assert.equal(encoded.statusCode, 401);
  assert.equal(provider.discoveries(), 0);

  const allowed = await app.inject({
    url: `${url}/catalog`,
    headers: { cookie: `${SESSION_COOKIE}=native-settings-session` },
  });

  assert.equal(allowed.statusCode, 200);
  assert.equal(provider.discoveries(), 1);
});
