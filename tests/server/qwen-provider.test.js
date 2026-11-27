import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { access, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { declaredCredentials } from '../../server/src/lib/executorCredentials.ts';
import { mergeCatalog } from '../../server/src/lib/modelsRegistry.ts';
import { qwenPreviewBinary } from '../../server/src/lib/qwen/previewRelease.ts';
import { applyProviderSetting, resolveProviderSettings } from '../../server/src/lib/providerSettings.ts';
import { markSupersededModels } from '../../shared/chat/modelFamily.ts';
import providersModule from '../../server/src/modules/providers/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import { QWEN_KEY, qwenAdapter, qwenFixture } from '../helpers/qwenFixture.mjs';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');

/**
 * Настоящий модуль providers работает с временным .env и синтетическим окружением.
 * Сеть и другие исполнители исключены, writer и публичная проекция остаются настоящими.
 */
async function providerApi(t, fixture, adapter, { auth = false } = {}) {
  const app = Fastify({ logger: false });
  const broadcasts = [];
  const env = {};

  app.decorate('sse', { broadcast: (name, payload) => broadcasts.push({ name, payload }) });

  if (auth) {
    await app.register(authPlugin, {
      authStore: { isConfigured: () => true, isValidSession: () => false },
    });
  }

  await app.register(providersModule, {
    config: fixture.config,
    env,
    getProviderAdapters: async () => new Map([['qwen', adapter]]),
    getModelsRegistry: async () => ({}),
  });
  t.after(() => app.close());

  return {
    app,
    env,
    broadcasts,
  };
}

test('qwen-clean-access-form-saves-service-and-key-without-manual-config', async (t) => {
  const fixture = await qwenFixture(t, { settings: {} });

  await rm(fixture.file);

  const adapter = await qwenAdapter();
  const { app, env } = await providerApi(t, fixture, adapter);
  const response = await app.inject({
    method: 'POST',
    url: '/api/providers/qwen/credentials',
    payload: { values: {
      GRIGDESK_QWEN_SERVICE: 'qwencloud-intl',
      DASHSCOPE_API_KEY: QWEN_KEY,
    } },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(env.GRIGDESK_QWEN_SERVICE, 'qwencloud-intl');
  assert.equal(env.DASHSCOPE_API_KEY, QWEN_KEY);
  assert.match(await readFile(fixture.config.envPath, 'utf8'), /GRIGDESK_QWEN_SERVICE=qwencloud-intl/);
  assert.equal((await stat(fixture.config.envPath)).mode & 0o777, 0o600);
  await assert.rejects(access(fixture.file), { code: 'ENOENT' });
  assert.equal(response.body.includes(QWEN_KEY.slice(0, -4)), false);

  const previous = await readFile(fixture.config.envPath, 'utf8');
  const refused = await app.inject({
    method: 'POST',
    url: '/api/providers/qwen/credentials',
    payload: { values: { GRIGDESK_QWEN_SERVICE: 'unknown-endpoint' } },
  });

  assert.equal(refused.statusCode, 400);
  assert.equal(await readFile(fixture.config.envPath, 'utf8'), previous);
});

test('qwen-card-pinned-preview-binary', async (t) => {
  const fixture = await qwenFixture(t, { native: true });
  const adapter = await qwenAdapter();
  const { isChatExecutor } = await import('../../server/src/lib/executors/index.ts');

  assert.equal(adapter.name, 'Qwen Code');
  assert.equal(adapter.vendor, 'Alibaba Cloud');
  assert.equal(isChatExecutor(adapter), true, 'Карточка должна предоставлять универсальный чатовый runtime');
  assert.ok(adapter.color);
  assert.equal(typeof adapter.order, 'number');
  assert.equal(adapter.externalCli, undefined);
  assert.equal(adapter.bin(fixture.config), fixture.bin);

  const probe = await adapter.probe(fixture.config);

  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.equal(probe.version, '1.0.0-preview.2');

  const imposter = path.join(fixture.root, 'unverified-qwen');

  await writeFile(imposter, '#!/bin/sh\nprintf "1.0.0-preview.2\\n"\n', { mode: 0o555 });

  const unverified = await adapter.probe({ ...fixture.config, qwenBin: imposter });
  const missing = await adapter.probe({ ...fixture.config, qwenBin: `${fixture.bin}.missing` });

  assert.equal(unverified.ok, false);
  assert.equal(missing.ok, false);
  assert.equal(adapter.distribution(fixture.config, probe).managed, true);
  assert.equal(adapter.distribution(fixture.config, probe).kind, 'binary');
  assert.ok(!adapter.login);

  const usage = await adapter.usage(fixture.config);

  assert.equal(usage.state, 'unsupported', 'Неизвестные квоты нельзя выдавать за нулевые');
  assert.match(usage.message, /в GrigDesk/);

  const policy = await adapter.directSshPolicy(fixture.config);
  const { app } = await providerApi(t, fixture, adapter);
  const response = await app.inject({ method: 'GET', url: '/api/providers' });

  assert.equal(response.statusCode, 200, response.body);

  const card = response.json().providers.find((entry) => entry.id === 'qwen');

  assert.equal(card.installed, true);
  assert.equal(card.capabilities.legacyTextStepDeltas, true);
  assert.deepEqual(card.inTurn, {
    protocol: 1,
    text: true,
    confirmation: 'forwarded',
    images: true,
  });
  assert.equal(card.version, '1.0.0-preview.2');
  assert.equal(card.installation, undefined);
  assert.equal(policy.enforcement, 'command-hook');
  assert.ok(policy.note?.trim(), 'Адаптер должен объяснять границу запрета SSH');
  assert.deepEqual(card.directSshPolicy, policy, 'Публичная карточка сохраняет способ запрета и пояснение');
});

test('Qwen: штатная установка защищена и отклоняет повреждённый архив', async (t) => {
  const fixture = await qwenFixture(t, { prepareFake: false });
  const adapter = await qwenAdapter();

  fixture.config.qwenBin = qwenPreviewBinary(fixture.dataHome);

  const denied = await providerApi(t, fixture, adapter, { auth: true });
  const request = {
    method: 'POST',
    url: '/api/providers/qwen/install-distribution',
    payload: { executable: fixture.bin },
  };
  const fetchArchive = t.mock.method(globalThis, 'fetch', async () => new Response('damaged archive'));

  assert.equal((await denied.app.inject(request)).statusCode, 401);
  assert.equal(fetchArchive.mock.callCount(), 0);

  const { app } = await providerApi(t, fixture, adapter);
  const response = await app.inject(request);

  assert.equal(response.statusCode, 502, response.body);
  assert.equal(fetchArchive.mock.callCount(), 1);
  await assert.rejects(access(fixture.config.qwenBin), { code: 'ENOENT' });
  await assert.rejects(access(fixture.bin), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.dirname(fixture.config.qwenBin)), []);
});

test('Qwen: карточка устанавливает закреплённый архив и сразу видит Preview.2', {
  skip: !process.env.GRIGDESK_QWEN_TEST_ARCHIVE && 'Требуется оригинальный архив Preview.2',
}, async (t) => {
  const fixture = await qwenFixture(t, { prepareFake: false });
  const adapter = await qwenAdapter();

  fixture.config.qwenBin = qwenPreviewBinary(fixture.dataHome);

  const { app, broadcasts } = await providerApi(t, fixture, adapter);
  const request = { method: 'POST', url: '/api/providers/qwen/install-distribution' };
  const listing = { method: 'GET', url: '/api/providers' };
  const savedEnv = await readFile(fixture.config.envPath, 'utf8');
  const fetchArchive = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(String(url), /releases\/download\/v1\.0\.0-preview\.2\/qwen-linux-x64\.tar\.gz$/u);

    return new Response(Readable.toWeb(createReadStream(process.env.GRIGDESK_QWEN_TEST_ARCHIVE)));
  });
  const before = (await app.inject(listing)).json().providers[0];

  assert.equal(before.distribution.canInstall, true);
  assert.equal(before.distribution.ready, false);

  const results = await Promise.all([app.inject(request), app.inject(request)]);

  assert.deepEqual(results.map(({ statusCode }) => statusCode), [200, 200]);
  assert.equal(fetchArchive.mock.callCount(), 1);

  const installed = (await app.inject(listing)).json().providers[0];

  assert.equal(installed.distribution.ready, true);
  assert.equal(installed.version, '1.0.0-preview.2');
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal(fetchArchive.mock.callCount(), 1);
  assert.ok(broadcasts.some(({ name, payload }) =>
    name === 'providers-update' && payload.installation === 'qwen'));
  assert.equal(await readFile(fixture.config.envPath, 'utf8'), savedEnv);
});

test('Qwen: измеренный расход приходит в SSE и HTTP при выключенном опросе квот', async (t) => {
  const fixture = await qwenFixture(t, { prepareFake: false });
  const { app, broadcasts } = await providerApi(t, fixture, await qwenAdapter());
  const tokens = { inputTokens: 6200, outputTokens: 180 };

  app.recordProviderTurnTokens('qwen', tokens);
  app.recordProviderTurnTokens('qwen', { inputTokens: 0, outputTokens: 0 });

  const response = await app.inject('/api/providers/usage?cached=1');
  const snapshot = response.json();

  assert.equal(snapshot.autoRefresh, false);
  assert.equal(snapshot.usage.qwen.state, 'unsupported');
  assert.deepEqual(snapshot.usage.qwen.bars, []);
  assert.deepEqual(snapshot.usage.qwen.lastTurnTokens, tokens);
  assert.deepEqual(broadcasts, [{ name: 'providers-usage', payload: snapshot }]);
});

test('qwen-credentials-env-only', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter();
  const declarations = await declaredCredentials(adapter, fixture.config);

  assert.equal(adapter.accessProfiles, undefined, 'Штатное окно ключей должно оставаться доступным');
  assert.ok(declarations.some((field) => field.env === 'DASHSCOPE_API_KEY' && field.kind === 'secret'));
  assert.ok(declarations.some((field) => field.env === 'QWEN_TEST_KEY'));

  const { app, env } = await providerApi(t, fixture, adapter);
  const initial = await readFile(fixture.config.envPath, 'utf8');

  await app.inject({ method: 'GET', url: '/api/providers' });
  assert.equal(await readFile(fixture.config.envPath, 'utf8'), initial, 'Просмотр/отмена не пишет ключ');

  const applied = await app.inject({
    method: 'POST',
    url: '/api/providers/qwen/credentials',
    payload: { values: { DASHSCOPE_API_KEY: QWEN_KEY, QWEN_TEST_KEY: QWEN_KEY } },
  });

  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(env.QWEN_TEST_KEY, QWEN_KEY);
  assert.match(await readFile(fixture.config.envPath, 'utf8'), /QWEN_TEST_KEY=/);
  assert.equal((await stat(fixture.config.envPath)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(fixture.config).includes(QWEN_KEY), false);

  const removed = await app.inject({
    method: 'POST',
    url: '/api/providers/qwen/credentials',
    payload: { values: { QWEN_TEST_KEY: null } },
  });

  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(env.QWEN_TEST_KEY, undefined);
  assert.equal((await readFile(fixture.config.envPath, 'utf8')).includes('QWEN_TEST_KEY='), false);
});

test('qwen-credentials-no-public-secret', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter();
  const { app, broadcasts } = await providerApi(t, fixture, adapter);
  const response = await app.inject({
    method: 'POST',
    url: '/api/providers/qwen/credentials',
    payload: { values: { QWEN_TEST_KEY: QWEN_KEY } },
  });

  assert.equal(response.statusCode, 200, response.body);

  const providers = await app.inject({ method: 'GET', url: '/api/providers' });
  const publicText = JSON.stringify([response.json(), providers.json(), broadcasts]);

  assert.equal(publicText.includes(QWEN_KEY.slice(0, -4)), false);

  const before = await readFile(fixture.config.envPath, 'utf8');
  const unknown = await app.inject({
    method: 'POST',
    url: '/api/providers/qwen/credentials',
    payload: { values: { NODE_OPTIONS: QWEN_KEY } },
  });

  assert.equal(unknown.statusCode, 400);
  assert.equal(await readFile(fixture.config.envPath, 'utf8'), before);

  const protectedApi = await providerApi(t, fixture, adapter, { auth: true });
  const denied = await protectedApi.app.inject({
    method: 'POST',
    url: '/api/providers/qwen/credentials',
    payload: { values: { QWEN_TEST_KEY: 'changed' } },
  });

  assert.equal(denied.statusCode, 401);
  assert.equal(await readFile(fixture.config.envPath, 'utf8'), before);

  const conflicting = await providerApi(t, fixture, { ...adapter, accessProfiles: {} });
  const conflict = await conflicting.app.inject({
    method: 'POST',
    url: '/api/providers/qwen/credentials',
    payload: { values: { QWEN_TEST_KEY: 'changed' } },
  });

  assert.equal(conflict.statusCode, 409);
  assert.equal(await readFile(fixture.config.envPath, 'utf8'), before);
});

test('qwen-catalog-source-refresh', async (t) => {
  const fixture = await qwenFixture(t, { native: true });
  const adapter = await qwenAdapter();

  assert.equal(typeof adapter.catalogCacheKey, 'function', 'Нужен fingerprint источника моделей');

  const registry = { qwen: [], _meta: {} };
  const firstKey = await adapter.catalogCacheKey(fixture.config);

  await mergeCatalog(registry, 'qwen', adapter, fixture.config);
  assert.equal(registry.qwen.length, 2);

  const originalStat = await stat(fixture.file);

  fixture.settings.modelProviders.openai.push({
    id: 'new-model',
    name: 'Новая модель',
    envKey: 'QWEN_TEST_KEY',
    baseUrl: 'http://127.0.0.1:9/v1',
  });
  await fixture.writeSettings(fixture.settings);
  await utimes(fixture.file, originalStat.atime, originalStat.mtime);

  const nextKey = await adapter.catalogCacheKey(fixture.config);

  assert.notEqual(nextKey, firstKey, 'Одинаковая версия/mtime не должны скрывать новую модель');
  await mergeCatalog(registry, 'qwen', adapter, fixture.config);
  assert.equal(registry.qwen.length, 3);
  assert.ok(registry.qwen.some((model) => model.name === 'Новая модель'));

  process.env.QWEN_TEST_KEY = 'synthetic-rotated-key';
  assert.notEqual(await adapter.catalogCacheKey(fixture.config), nextKey);

  const rotatedKey = String(await adapter.catalogCacheKey(fixture.config));

  assert.equal(rotatedKey.includes('synthetic-rotated-key'), false);
  assert.equal(await readFile(fixture.config.modelsPath, 'utf8'), 'sentinel-owner-registry');
});

/**
 * Каталог QwenCloud содержит разные модели, а не версии одного семейства default.
 * Даже новая модель остаётся видимой в кратком списке без настройки «Показывать все».
 */
test('qwen-catalog-does-not-hide-unrelated-models-as-superseded', async (t) => {
  const fixture = await qwenFixture(t, { native: true });
  const adapter = await qwenAdapter();
  const ids = ['qwen4-max-preview', 'qwen3.8-max', 'qwen3.8-flash', 'glm-5.3', 'auto'];

  await fixture.writeSettings({
    modelProviders: { openai: ids.map((id) => ({
      id,
      envKey: 'QWEN_TEST_KEY',
      baseUrl: 'http://127.0.0.1:9/v1',
    })) },
  });

  const catalog = await adapter.catalog(fixture.config);
  const visible = markSupersededModels(catalog).filter((model) => !model.extra);

  assert.deepEqual(visible.map((model) => model.id), ids.map((id) => `${id}(openai)`));
  assert.ok(catalog.every((model) => !model.family), 'CLI не объявлял линию замены моделей');
});

test('qwen-catalog-opaque-routes', async (t) => {
  const fixture = await qwenFixture(t, { native: true });

  fixture.settings.modelProviders.openai[0].apiKey = 'inline-forbidden-secret';
  fixture.settings.modelProviders.openai.push({ id: 'hostile', envKey: 'NODE_OPTIONS' });
  await fixture.writeSettings(fixture.settings);

  const adapter = await qwenAdapter();
  const models = await adapter.catalog(fixture.config);

  assert.ok(models.some((model) => model.id === 'shared-model(openai)'));
  assert.ok(models.some((model) => model.id === 'shared-model(anthropic)'));
  assert.equal(new Set(models.map((model) => model.id)).size, models.length);
  assert.equal(models.find((model) => model.id === 'shared-model(openai)').context, 32768);

  const unknown = models.find((model) => model.id === 'shared-model(anthropic)');

  assert.ok(!unknown.context || unknown.contextUnverified, 'Неизвестный контекст не подменяется числом');
  assert.ok(!unknown.efforts?.length, 'Нельзя придумывать уровни рассуждения');

  const metadata = JSON.stringify(models);

  assert.equal(metadata.includes('inline-forbidden-secret'), false);
  assert.equal(metadata.includes(QWEN_KEY), false);
  assert.equal(metadata.includes('http://127.0.0.1'), false, 'Endpoint не является публичной metadata');

  const declarations = await declaredCredentials(adapter, fixture.config);

  assert.ok(declarations.some((field) => field.env === 'SECOND_QWEN_KEY'));
  assert.equal(declarations.some((field) => ['NODE_OPTIONS', 'HOME', 'PATH'].includes(field.env)), false);
});

test('qwen-catalog-invalid-and-empty', async (t) => {
  const fixture = await qwenFixture(t, { native: true });
  const adapter = await qwenAdapter();
  const registry = { qwen: [], _meta: {} };

  await mergeCatalog(registry, 'qwen', adapter, fixture.config);

  const saved = structuredClone(registry.qwen);

  assert.equal(saved.length, 2);

  for (const content of ['{"modelProviders": { broken', '{"modelProviders":{}}']) {
    await fixture.writeSettings(content);
    await mergeCatalog(registry, 'qwen', adapter, fixture.config);

    assert.deepEqual(registry.qwen, saved, 'Пустой или повреждённый источник сохраняет прежний каталог');
    assert.equal(await readFile(fixture.file, 'utf8'), content,
      'Нельзя чинить конфиг владельца автоматически');
    assert.deepEqual(adapter.seedModels(), [], 'Из пустого источника нельзя придумывать seed');
  }
});

/**
 * Общий реестр может удержать прежние модели, но отказ CLI не должен терять причину.
 * Исправленный CLI возвращает готовность того же доступа без смены ключа.
 */
test('qwen-catalog-cli-failure-is-visible-safe-and-recovers', async (t) => {
  const fixture = await qwenFixture(t, { native: true });
  const adapter = await qwenAdapter();
  const registry = { qwen: [], _meta: {} };
  const incompatible = path.join(fixture.root, 'incompatible-qwen');

  await writeFile(incompatible, `#!/bin/sh\nprintf '%s' '${QWEN_KEY}' >&2\n`, { mode: 0o555 });

  const incompatibleConfig = { ...fixture.config, qwenBin: incompatible };

  await mergeCatalog(registry, 'qwen', adapter, incompatibleConfig);

  const refused = adapter.auth(incompatibleConfig);

  assert.equal(registry.qwen.length, 0);
  assert.equal(refused.available, false);
  assert.match(refused.label, /несовместим.*Preview\.2/);
  assert.equal(refused.label.includes(QWEN_KEY), false);
  await mergeCatalog(registry, 'qwen', adapter, fixture.config);
  assert.equal(registry.qwen.length, 2);
  assert.equal(adapter.auth(fixture.config).available, true);
  await fixture.writeSettings({ modelProviders: {} });
  await mergeCatalog(registry, 'qwen', adapter, fixture.config);
  assert.equal(adapter.auth(fixture.config).available, false);
  assert.match(adapter.auth(fixture.config).label, /не вернул модели.*Доступ/);
});

test('Qwen: Host требует явного согласия и отдельной identity', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter();
  const list = await resolveProviderSettings(adapter, {}, fixture.config);
  const host = list.find((entry) => entry.id === 'allowHostAccess');

  assert.equal(host?.value, false);

  const denied = await applyProviderSetting(adapter, {}, {
    settingId: 'allowHostAccess', value: true,
  }, fixture.config);

  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'confirmation_required');

  const accepted = await applyProviderSetting(adapter, {}, {
    settingId: 'allowHostAccess',
    value: true,
    confirmed: true,
  }, fixture.config);

  assert.equal(accepted.ok, true);
  assert.equal(accepted.providerSettings.qwen.allowHostAccess, true);
  assert.notEqual(
    await adapter.sessionBinding.securityProfile(fixture.config, {}),
    await adapter.sessionBinding.securityProfile(fixture.config, { allowHostAccess: true }),
  );
  assert.equal(
    await adapter.sessionBinding.securityProfile(fixture.config, { allowHostAccess: 'true' }),
    await adapter.sessionBinding.securityProfile(fixture.config, {}),
  );
});
