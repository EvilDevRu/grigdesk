import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderSettingsCatalogCache } from '../../server/src/lib/executorSettings/catalog.ts';
import { projectNativeSettingsCatalog } from '../../server/src/lib/executorSettings/projection.ts';
import { decodeProviderSettingsCatalog } from '../../shared/chat/providerSettingsContracts.ts';
import { prepareChatNativeSettings } from '../../server/src/lib/executorSettings/launch.ts';
import { ensureTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';
import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { flattenNativeSettings } from '../../server/src/lib/executorSettings/validation.ts';

const consumers = await import('../../server/src/lib/executorSettings/consumers.ts').catch(() => null);
const launch = await import('../../server/src/lib/executorSettings/launch.ts');
const context = {
  providerId: 'future-provider',
  binaryIdentity: 'build-A',
  runtimeIdentity: 'build-A',
  profileFingerprint: 'fixture',
  transport: 'fixture',
  mode: 'default',
  cwdRealpath: '/',
};

function snapshot(properties, ownership = []) {
  return {
    context,
    generation: 'fixture',
    source: {
      kind: 'fixture',
      version: '1',
      checkedAt: 1,
      coverage: [{ path: [], coverage: 'complete' }],
    },
    areas: [{
      path: [],
      format: 'json-schema',
      dialect: '2020-12',
      coverage: 'complete',
      schema: { type: 'object', properties },
      writeChannel: {
        id: 'fixture',
        scope: 'grigdesk-chats',
        state: 'verified',
      },
    }],
    ownership,
  };
}

function saved(value = false, field = 'enabled') {
  return {
    'future-provider': {
      nativeSettings: {
        format: 1,
        revision: 1,
        overrides: { [JSON.stringify([field])]: { path: [field], value } },
      },
    },
  };
}

/**
 * Fixture возвращает один и тот же semantic snapshot без чтения prefs или CLI.
 * Разные consumers проходят общий prepare, сохраняя формат прежнего контейнера.
 */
function adapter(merged, supported = ['chat', 'pipeline']) {
  return {
    id: 'future-provider',
    nativeSettings: {
      consumers: supported,
      context: async (_config, cwd, consumer) => ({
        ...context,
        cwdRealpath: cwd,
        consumer,
      }),
      discover: async () => merged,
      prepare: async (context, _snapshot, accepted) => ({
        accepted,
        payload: accepted.map(({ value }) => value),
        runtimeIdentity: context.runtimeIdentity,
      }),
    },
  };
}

test('common и web-only поля объединяются без нового storage и декодируются protocol 1', async () => {
  assert.ok(consumers, 'Объединение consumers пока отсутствует');

  const merged = consumers.mergeNativeSettingsConsumers(
    snapshot({ enabled: { type: 'boolean', default: true }, webOnly: { type: 'string' } }),
    snapshot({ enabled: { type: 'boolean', default: true } }),
  );
  const read = await new ProviderSettingsCatalogCache().read(adapter(merged).nativeSettings, context);
  const catalog = decodeProviderSettingsCatalog(projectNativeSettingsCatalog(read, {
    format: 1,
    revision: 1,
    overrides: saved()['future-provider'].nativeSettings.overrides,
  }));

  assert.equal(catalog.scope.id, 'grigdesk-chats-and-pipelines');
  assert.deepEqual(catalog.fields.find((field) => field.id === '["enabled"]').appliesTo,
    ['chat', 'pipeline']);
  assert.deepEqual(catalog.fields.find((field) => field.id === '["webOnly"]').appliesTo, ['chat']);
  assert.equal(catalog.fields.find((field) => field.id === '["enabled"]').override.value, false);
});

test('pipeline сохраняет false и identity; совместимый chat wrapper пропускает web-only', async () => {
  assert.ok(consumers && launch.prepareNativeSettings, 'Общий prepare пока отсутствует');

  const merged = consumers.mergeNativeSettingsConsumers(
    snapshot({ enabled: { type: 'boolean' }, webOnly: { type: 'string' } }),
    snapshot({ enabled: { type: 'boolean' } }),
  );
  const provider = adapter(merged);
  const prepared = await launch.prepareNativeSettings(provider, {}, '/', saved(), { consumer: 'pipeline' });
  const chat = await prepareChatNativeSettings(provider, {}, '/', saved(),
    new ProviderSettingsCatalogCache());

  assert.equal(prepared.accepted[0].value, false);
  assert.equal(prepared.runtimeIdentity, 'build-A');
  assert.notEqual(prepared.fingerprint, chat.fingerprint);
  assert.ok(Object.isFrozen(prepared));
  assert.equal(await launch.prepareNativeSettings(provider, {}, '/', saved('value', 'webOnly'), {
    consumer: 'pipeline',
  }), undefined);
  assert.equal(await launch.prepareNativeSettings(adapter(merged, ['chat']), {}, '/', saved(), {
    consumer: 'pipeline',
  }), undefined);
});

test('отсутствующий ACP источник остаётся unverified, чат доступен, pipeline блокируется', async () => {
  assert.ok(consumers && launch.prepareNativeSettings, 'Общий prepare пока отсутствует');

  const merged = consumers.mergeNativeSettingsConsumers(snapshot({ enabled: { type: 'boolean' } }), null);
  const provider = adapter(merged);
  const read = await new ProviderSettingsCatalogCache().read(provider.nativeSettings, context);
  const field = read.fields.find((field) => field.id === '["enabled"]');

  assert.equal(field.writable, true);
  assert.equal(field.consumerSupport.pipeline.state, 'unverified');
  assert.ok(await prepareChatNativeSettings(provider, {}, '/', saved(), new ProviderSettingsCatalogCache()));
  await assert.rejects(launch.prepareNativeSettings(provider, {}, '/', saved(), { consumer: 'pipeline' }));
});

test('несовместимые schemas не становятся writable, secret из одного профиля закрывает оба', async () => {
  assert.ok(consumers, 'Объединение consumers пока отсутствует');

  const merged = consumers.mergeNativeSettingsConsumers(
    snapshot({
      enabled: { type: 'boolean', default: true },
      token: { type: 'string', default: 'private-sentinel' },
    }),
    snapshot({ enabled: { type: 'string' }, token: { type: 'string' } }, [{
      path: ['token'],
      secret: true,
      owner: 'Credential',
      reason: 'Секрет источника',
    }]),
  );
  const read = await new ProviderSettingsCatalogCache().read(adapter(merged).nativeSettings, context);
  const projected = projectNativeSettingsCatalog(read, {
    format: 1,
    revision: 0,
    overrides: {},
  });

  assert.equal(read.fields.find((field) => field.id === '["enabled"]').writable, false);
  assert.equal(JSON.stringify(projected).includes('private-sentinel'), false);
  assert.equal(projected.fields.find((field) => field.id === '["token"]').writable, false);
});

test('настоящий candidate объединяет web/ACP схемы без ключа и сохраняет opaque field IDs', async () => {
  const artifact = await ensureTestDeepSeekArtifact();
  const config = { deepseekBin: process.execPath, deepseekArtifactDir: artifact };
  const context = await deepseek.nativeSettings.context(config, process.cwd(), 'pipeline');
  const read = await new ProviderSettingsCatalogCache().read(deepseek.nativeSettings, context);
  const fields = flattenNativeSettings(read.fields);
  const common = fields.find((field) => field.id === '["llm-deepseek","maxTokens"]');
  const webOnly = fields.find((field) => field.id === '["subagent-model-selection","enabled"]');

  assert.equal(read.state, 'ready');
  assert.equal(context.transport, 'acp');
  assert.equal(context.consumer, 'pipeline');
  assert.deepEqual(common.appliesTo, ['chat', 'pipeline']);
  assert.deepEqual(webOnly.appliesTo, ['chat']);
  assert.equal(common.consumerSupport.pipeline.state, 'verified');
  assert.equal(webOnly.consumerSupport.pipeline.state, 'unsupported');
  assert.equal(fields.find((field) => field.id === '["llm-deepseek","apiKeyEnv"]').writable, false);
});

test('partial ACP и исчезнувший common override блокируют pipeline до prompt', async () => {
  const pipeline = snapshot({});

  pipeline.source.coverage[0].coverage = 'partial';

  const merged = consumers.mergeNativeSettingsConsumers(snapshot({ enabled: { type: 'boolean' } }), pipeline);

  await assert.rejects(launch.prepareNativeSettings(adapter(merged), {}, '/', saved(), {
    consumer: 'pipeline',
  }));

  const absent = consumers.mergeNativeSettingsConsumers(snapshot({}), snapshot({}));

  await assert.rejects(launch.prepareNativeSettings(adapter(absent), {}, '/', saved(), {
    consumer: 'pipeline',
  }));
});

test('secret родителя из ACP скрывает default/base всего поддерева web', async () => {
  const web = snapshot({ container: {
    type: 'object',
    default: { token: 'private-default-sentinel' },
    properties: { token: { type: 'string', enum: ['private-enum-sentinel'] } },
  } });

  web.areas[0].base = { container: { token: 'private-base-sentinel' } };

  const pipeline = snapshot({ container: { type: 'object', properties: {} } }, [{
    path: ['container'],
    secret: true,
    owner: 'Secret',
    reason: 'Закрыто источником ACP',
  }]);
  const merged = consumers.mergeNativeSettingsConsumers(web, pipeline);
  const read = await new ProviderSettingsCatalogCache().read(adapter(merged).nativeSettings, context);
  const projected = projectNativeSettingsCatalog(read, {
    format: 1,
    revision: 0,
    overrides: {},
  });

  assert.equal(JSON.stringify(projected).includes('sentinel'), false);
});

test('managed предок не перекрывает secret leaf, объявленный другим consumer', async () => {
  const web = snapshot({ container: { type: 'object', properties: {
    token: { type: 'string', default: 'private-leaf-sentinel' },
  } } }, [{
    path: ['container'],
    owner: 'Другой редактор',
    reason: 'Управляется host',
  }]);
  const pipeline = snapshot({}, [{
    path: ['container', 'token'],
    secret: true,
    owner: 'Secret',
    reason: 'Скрыто источником ACP',
  }]);
  const merged = consumers.mergeNativeSettingsConsumers(web, pipeline);
  const read = await new ProviderSettingsCatalogCache().read(adapter(merged).nativeSettings, context);
  const projected = projectNativeSettingsCatalog(read, {
    format: 1,
    revision: 0,
    overrides: {},
  });

  assert.equal(JSON.stringify(projected).includes('private-leaf-sentinel'), false);
});

test('порядок properties не меняет fingerprint, busy snapshot остаётся immutable', async () => {
  const web = snapshot({ enabled: { type: 'boolean' }, other: { type: 'string' } });
  const pipeline = snapshot({ other: { type: 'string' }, enabled: { type: 'boolean' } });
  const provider = adapter(consumers.mergeNativeSettingsConsumers(web, pipeline));
  const first = await launch.prepareNativeSettings(provider, {}, '/', saved(), { consumer: 'pipeline' });
  const same = await launch.prepareNativeSettings(provider, {}, '/', saved(), { consumer: 'pipeline' });
  const changed = await launch.prepareNativeSettings(provider, {}, '/', saved(true), {
    consumer: 'pipeline',
  });
  const mode = await launch.prepareNativeSettings(provider, {}, '/', saved(), {
    consumer: 'pipeline', mode: 'read-only',
  });

  assert.equal(first.fingerprint, same.fingerprint);
  assert.notEqual(first.fingerprint, changed.fingerprint);
  assert.notEqual(first.fingerprint, mode.fingerprint);
  assert.equal(first.accepted[0].value, false);
  assert.equal(changed.accepted[0].value, true);
});
