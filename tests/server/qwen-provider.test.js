import assert from 'node:assert/strict';
import { access, readFile, rm, stat, utimes } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

import { declaredCredentials } from '../../server/src/lib/executorCredentials.ts';
import { mergeCatalog } from '../../server/src/lib/modelsRegistry.ts';
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

test('qwen-card-npm-version', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter();
  const definition = adapter.externalCli(fixture.config, fixture.home);
  const { isChatExecutor } = await import('../../server/src/lib/executors/index.ts');

  assert.equal(adapter.name, 'Qwen Code');
  assert.equal(adapter.vendor, 'Alibaba Cloud');
  assert.equal(isChatExecutor(adapter), true, 'Карточка должна предоставлять универсальный чатовый runtime');
  assert.ok(adapter.color);
  assert.equal(typeof adapter.order, 'number');
  assert.deepEqual([definition.packageId, definition.binName, definition.configKey, definition.envKey],
    ['@qwen-code/qwen-code', 'qwen', 'qwenBin', 'GRIGDESK_QWEN_BIN']);
  assert.equal(adapter.bin(fixture.config), fixture.bin);

  const probe = await adapter.probe(fixture.config);

  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.match(probe.version, /0\.27\.2/);
  await fixture.fake({ version: '0.27.3' });

  const updated = await adapter.probe(fixture.config);
  const missing = await adapter.probe({ ...fixture.config, qwenBin: `${fixture.bin}.missing` });

  assert.equal(updated.ok, true);
  assert.match(updated.version, /0\.27\.3/);
  assert.equal(missing.ok, false);

  const installation = await adapter.installation(fixture.config, {
    npm: '/usr/bin/npm',
  });

  assert.ok(installation.install);
  assert.ok(installation.update);
  assert.match(JSON.stringify(installation.install), /@qwen-code\/qwen-code/);
  assert.ok(!installation.loginCommand, 'OAuth login не должен предлагаться');
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
  assert.match(card.version, /0\.27\.3/);
  assert.equal(policy.enforcement, 'command-hook');
  assert.ok(policy.note?.trim(), 'Адаптер должен объяснять границу запрета SSH');
  assert.deepEqual(card.directSshPolicy, policy, 'Публичная карточка сохраняет способ запрета и пояснение');
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
  const fixture = await qwenFixture(t);
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
  const fixture = await qwenFixture(t);
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
  const fixture = await qwenFixture(t);

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
  const fixture = await qwenFixture(t);
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
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter();
  const registry = { qwen: [], _meta: {} };

  await fixture.fake({ noAck: true, stderr: QWEN_KEY });
  await mergeCatalog(registry, 'qwen', adapter, fixture.config);

  const refused = adapter.auth(fixture.config);

  assert.equal(registry.qwen.length, 0);
  assert.equal(refused.available, false);
  assert.match(refused.label, /несовместим.*Обновите или переустановите/);
  assert.equal(refused.label.includes(QWEN_KEY), false);
  await fixture.fake();
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
