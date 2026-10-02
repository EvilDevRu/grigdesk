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
import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { ensureTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';
import { flattenNativeSettings } from '../../server/src/lib/executorSettings/validation.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

/**
 * Маршруты используют временный prefs и настоящий синхронный writer.
 * Только внешний CLI заменён синтетическим исполнителем.
 */
export async function nativeRouteFixture(t, provider = syntheticProvider(), {
  auth = false,
  config = {},
} = {}) {
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
    config: {
      rootDir: root,
      modelsPath: path.join(root, 'models.json'),
      ...config,
    },
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

test('настоящий candidate публикует embedded readiness и общую форму без ключа', async (t) => {
  const artifact = await ensureTestDeepSeekArtifact();
  const provider = {
    ...deepseek,
    auth: () => ({
      mode: 'api-key',
      label: 'Нет API key',
      available: false,
    }),
    catalog: async () => null,
    usage: undefined,
    latestVersion: () => {
      throw new Error('Embedded не проверяет npm latest');
    },
  };
  const { app, root, prefs } = await nativeRouteFixture(t, provider, {
    config: { deepseekArtifactDir: artifact },
  });
  const registry = (await app.inject('/api/providers')).json().providers;
  const card = registry.find((entry) => entry.id === 'deepseek');

  assert.equal(card.distribution.kind, 'embedded');
  assert.equal(card.distribution.ready, true);
  assert.equal(card.distribution.label, 'Входит в Cockpit');
  assert.equal(card.available, false);
  assert.equal(card.installed, true);
  assert.equal(card.install, null);
  assert.equal(card.setupCommand, null);
  assert.equal(card.canUpdate, false);
  assert.equal(card.latest, null);
  assert.match(card.distribution.authHint, /DEEPSEEK_API_KEY/);
  assert.equal((await app.inject('/api/providers/deepseek/mcp')).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/providers/check-updates' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/providers/deepseek/update' })).statusCode, 400);

  const first = decodeProviderSettingsCatalog(
    (await app.inject('/api/providers/deepseek/settings/catalog')).json(),
  );
  const fieldId = '["llm-deepseek","maxTokens"]';

  assert.equal(first.scope.id, 'cockpit-chats-and-pipelines');
  assert.equal(flattenNativeSettings(first.fields)
    .find((field) => field.id === fieldId).consumerSupport.pipeline.state, 'verified');

  const response = await app.inject({
    method: 'POST',
    url: '/api/providers/deepseek/settings/overrides',
    payload: {
      fieldId,
      operation: 'set',
      value: 64,
      schemaRevision: first.schemaRevision,
      revision: first.revision,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(prefs.readStored().providerSettings.deepseek.nativeSettings.overrides[fieldId].value, 64);

  const reloaded = (await app.inject('/api/providers/deepseek/settings/catalog?refresh=1')).json();
  const serialized = JSON.stringify(reloaded);

  assert.equal(flattenNativeSettings(reloaded.fields)
    .find((field) => field.id === '["llm-deepseek","apiKeyEnv"]').writable, false);
  assert.equal(serialized.includes(artifact), false);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes('normalizedFields'), false);
  assert.equal(serialized.includes('consumerFields'), false);
});

test('отсутствующая встроенная сборка объясняет причину и команду подготовки в карточке', async (t) => {
  const provider = {
    ...deepseek,
    auth: () => ({
      mode: 'api-key',
      label: 'Нет API key',
      available: false,
    }),
    catalog: async () => null,
  };
  const generationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-missing-generation-'));

  t.after(() => fs.rmSync(generationRoot, { recursive: true, force: true }));

  const { app, root } = await nativeRouteFixture(t, provider, {
    config: { deepseekRuntimeMode: 'embedded', deepseekGenerationRoot: generationRoot },
  });
  const card = (await app.inject('/api/providers')).json().providers.find((entry) => entry.id === 'deepseek');

  assert.equal(card.distribution.ready, false);
  assert.equal(card.distribution.error, 'deepseek_runtime_missing');
  assert.match(card.distribution.problem.message, /не подготовлена/u);
  assert.equal(card.distribution.problem.command, `${path.join(root, 'bin/cockpit')} deps`);
  assert.equal(card.install, null);
});

test('installed default не объявляет embedded delivery до cutover', async (t) => {
  const provider = {
    ...deepseek,
    probe: async () => ({ ok: false, version: null }),
    auth: () => ({
      mode: 'api-key',
      label: 'Нет API key',
      available: false,
    }),
    catalog: async () => null,
  };
  const { app } = await nativeRouteFixture(t, provider, {
    config: { deepseekRuntimeMode: 'installed', deepseekBin: '/missing-fixture/dsh' },
  });
  const card = (await app.inject('/api/providers')).json().providers.find((entry) => entry.id === 'deepseek');

  assert.equal(card.distribution, null);
  assert.match(card.install, /deepseekHarnessInstall/);
  assert.equal(card.available, false);
});

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
