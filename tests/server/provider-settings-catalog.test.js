import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import schema from '../fixtures/executor-settings/synthetic-v1.json' with { type: 'json' };
import schemaV2 from '../fixtures/executor-settings/synthetic-v2.json' with { type: 'json' };
import schemaV3 from '../fixtures/executor-settings/synthetic-v3.json' with { type: 'json' };
import { ProviderSettingsCatalogCache } from '../../server/src/lib/executorSettings/catalog.ts';
import { projectNativeSettingsCatalog } from '../../server/src/lib/executorSettings/projection.ts';
import { syntheticProvider } from '../fixtures/executor-settings/syntheticProvider.js';
import { withSettingsStdioProbe } from '../../server/src/lib/executorSettings/probe.ts';

const context = {
  providerId: 'future-provider',
  binaryIdentity: 'synthetic-1',
  profileFingerprint: 'profile-1',
  transport: 'fake',
  mode: 'default',
  cwdRealpath: '/synthetic/workspace',
};

test('одновременные чтения boolean-каталога используют одно обнаружение', async () => {
  let calls = 0;
  const cache = new ProviderSettingsCatalogCache({ clock: () => 1000 });
  const capability = {
    async discover(input) {
      calls += 1;

      return {
        context: input,
        generation: 'v1',
        source: {
          kind: 'synthetic',
          version: '1',
          checkedAt: 1000,
          coverage: [{ path: [], coverage: 'complete' }],
        },
        areas: [
          {
            path: [],
            format: 'json-schema',
            dialect: '2020-12',
            schema,
            coverage: 'complete',
            writeChannel: {
              id: 'overlay',
              scope: 'cockpit-chats',
              state: 'verified',
            },
            base: { enabled: true },
          },
        ],
        ownership: [],
      };
    },
  };
  const [first, second] = await Promise.all([
    cache.read(capability, context),
    cache.read(capability, context),
  ]);

  assert.equal(first.state, 'ready');
  assert.equal(first.fields[0]?.kind, 'boolean');
  assert.equal(second.schemaRevision, first.schemaRevision);
  assert.equal(calls, 1);
});

test('v1 → v2 → сбой → v3 сохраняет выбор и объясняет подтверждённое удаление поля', async () => {
  let current = schema;
  const capability = syntheticProvider({
    readSchema: () => {
      if (current === null) {
        throw new Error('Приватная ошибка CLI');
      }

      return current;
    },
  }).nativeSettings;
  const cache = new ProviderSettingsCatalogCache();
  const storage = {
    format: 1,
    revision: 1,
    overrides: { '["enabled"]': { path: ['enabled'], value: false } },
  };
  const first = await cache.read(capability, context);

  current = schemaV2;

  const second = await cache.read(capability, context, { refresh: true });

  assert.equal(second.fields.length, 2);
  current = null;

  const stale = await cache.read(capability, context, { refresh: true });

  assert.equal(stale.state, 'stale');
  assert.equal(stale.schemaRevision, second.schemaRevision);
  assert.equal(projectNativeSettingsCatalog(stale, storage).inactiveOverrides.length, 0);
  current = schemaV3;

  const third = projectNativeSettingsCatalog(
    await cache.read(capability, context, { refresh: true }),
    storage,
  );

  assert.equal(first.fields.length, 1);
  assert.match(third.inactiveOverrides[0]?.reason ?? '', /удалено/);
  assert.equal(Object.hasOwn(third.inactiveOverrides[0], 'value'), false);
  assert.equal(storage.overrides['["enabled"]'].value, false);
});

test('вложенный выбор виден в группе, а новое secret-поле скрывает все slots', async () => {
  let secret = false;
  const capability = syntheticProvider({
    readSchema: () => ({
      type: 'object',
      properties: {
        group: {
          type: 'object',
          properties: {
            nested: {
              type: 'string',
              default: 'schema-sentinel',
              writeOnly: secret,
            },
          },
        },
      },
    }),
  }).nativeSettings;
  const cache = new ProviderSettingsCatalogCache();
  const storage = {
    format: 1,
    revision: 1,
    overrides: {
      '["group","nested"]': { path: ['group', 'nested'], value: 'saved-sentinel' },
    },
  };
  const first = projectNativeSettingsCatalog(await cache.read(capability, context), storage);

  assert.equal(first.fields[0]?.children?.[0]?.override.value, 'saved-sentinel');
  assert.equal(first.inactiveOverrides.length, 0);
  secret = true;

  const next = projectNativeSettingsCatalog(
    await cache.read(capability, context, { refresh: true }),
    storage,
  );

  assert.equal(next.inactiveOverrides.length, 1);
  assert.equal(JSON.stringify(next).includes('sentinel'), false);
});

test('секретная ветка скрывает enum и const вместе со значениями в публичном каталоге', async () => {
  const capability = syntheticProvider({
    readSchema: () => ({
      type: 'object',
      properties: {
        token: {
          type: 'string',
          enum: ['private-sentinel'],
          writeOnly: true,
        },
        neighbor: { type: 'boolean' },
      },
    }),
  }).nativeSettings;
  const cache = new ProviderSettingsCatalogCache();
  const storage = {
    format: 1,
    revision: 0,
    overrides: {},
  };
  const catalog = projectNativeSettingsCatalog(await cache.read(capability, context), storage);

  assert.equal(JSON.stringify(catalog).includes('private-sentinel'), false);
  assert.equal(catalog.fields[0].writable, false);
  assert.equal(catalog.fields[1].writable, true);
});

test('таймаут discovery даёт unavailable даже при reader, который не ответил на abort', async () => {
  const cache = new ProviderSettingsCatalogCache({ timeoutMs: 10, cleanupMs: 10 });
  const capability = { discover: () => new Promise(() => {}) };
  let guard;
  const deadline = new Promise((resolve) => {
    guard = setTimeout(() => resolve({ state: 'hung' }), 100);
  });

  try {
    const result = await Promise.race([cache.read(capability, context), deadline]);

    assert.equal(result.state, 'unavailable');
  } finally {
    clearTimeout(guard);
  }
});

test('schemaRevision учитывает обнаруженные ключи словаря и доступность native base', async () => {
  const provider = syntheticProvider({
    readSchema: () => ({
      type: 'object',
      properties: {
        group: {
          type: 'object',
          required: ['required'],
          properties: { enabled: { type: 'boolean' } },
        },
        dictionary: { type: 'object', additionalProperties: { type: 'boolean' } },
      },
    }),
  });
  const discover = provider.nativeSettings.discover;
  let base = { group: { required: true }, dictionary: { first: true } };

  provider.nativeSettings.discover = async (...args) => {
    const snapshot = await discover(...args);

    snapshot.areas[0].base = base;

    return snapshot;
  };

  const cache = new ProviderSettingsCatalogCache();
  const first = await cache.read(provider.nativeSettings, context);

  base = { dictionary: { first: true, second: false } };

  const second = await cache.read(provider.nativeSettings, context, { refresh: true });

  assert.equal(first.fields[0].children[0].writable, true);
  assert.equal(second.fields[0].children[0].writable, false);
  assert.equal(second.fields[1].children.length, 2);
  assert.notEqual(first.schemaRevision, second.schemaRevision);
});

test('таймаут каталога дожидается завершения своего CLI, который игнорирует SIGTERM', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-probe-stop-'));
  const file = path.join(root, 'cli.mjs');
  const pidFile = path.join(root, 'pid');

  fs.writeFileSync(
    file,
    `
    import fs from 'node:fs';
    fs.writeFileSync(process.argv[2], String(process.pid));
    process.on('SIGTERM', () => {});
    process.stdin.resume();
    setInterval(() => {}, 100);
  `,
  );
  t.after(() => {
    if (fs.existsSync(pidFile)) {
      try {
        process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        // Успешный cleanup уже завершил наш процесс.
      }
    }

    fs.rmSync(root, { recursive: true, force: true });
  });

  const cache = new ProviderSettingsCatalogCache({ timeoutMs: 200 });
  const read = await cache.read(
    {
      discover: (_context, { signal }) =>
        withSettingsStdioProbe(
          {
            bin: process.execPath,
            args: [file, pidFile],
            cwd: root,
            signal,
          },
          async (probe) => {
            await probe.request({ method: 'initialize' }, () => false);

            throw new Error('Fixture не должна завершать initialize');
          },
        ),
    },
    context,
  );
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = false;

  assert.equal(pid > 0, true);

  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    // Проверяется факт завершения нашего CLI, а не только отклонение Promise.
  }

  assert.equal(read.state, 'unavailable');
  assert.equal(alive, false);
});
