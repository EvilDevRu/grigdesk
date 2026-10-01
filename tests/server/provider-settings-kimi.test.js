import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { kimiSettingsSnapshot } from '../../server/src/lib/executorSettings/kimi.ts';
import { ProviderSettingsCatalogCache } from '../../server/src/lib/executorSettings/catalog.ts';
import { flattenNativeSettings } from '../../server/src/lib/executorSettings/validation.ts';
import { projectNativeSettingsCatalog } from '../../server/src/lib/executorSettings/projection.ts';
import { buildKimiHostWebHome } from '../../server/src/lib/kimi/hostWebHome.ts';
import { runKimiServerTurn } from '../../server/src/lib/kimi/serverTurn.ts';

const context = {
  providerId: 'kimi',
  binaryIdentity: 'fixture',
  profileFingerprint: 'host-fixture',
  transport: 'web',
  mode: 'host',
  cwdRealpath: '/fixture',
};
const content = (schema) => ({ content: { 'application/json': { schema } } });
const openapi = {
  paths: {
    '/api/v1/config': {
      post: {
        requestBody: content({
          type: 'object',
          properties: {
            telemetry: { type: 'boolean' },
            future: { type: 'string' },
            unresolved: {},
            group: { type: 'object', properties: { unresolved: {}, enabled: { type: 'boolean' } } },
          },
        }),
      },
      get: {
        responses: {
          200: content({
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  getOnly: { type: 'boolean' },
                  providers: { type: 'object', additionalProperties: {} },
                  raw: {},
                },
              },
            },
          }),
        },
      },
    },
  },
};

test('Kimi использует POST schema и скрывает raw и providers; GET-only остаётся read-only', async () => {
  const cache = new ProviderSettingsCatalogCache();
  const read = await cache.read(
    {
      discover: async () =>
        kimiSettingsSnapshot(
          openapi,
          {
            code: 0,
            data: {
              getOnly: true,
              telemetry: false,
              providers: { proof: { api_key: 'private-sentinel' } },
              raw: { secret: 'raw-sentinel' },
            },
          },
          context,
        ),
    },
    context,
  );
  const fields = flattenNativeSettings(read.fields);

  assert.equal(fields.find((field) => field.id === '["future"]')?.writable, true);
  assert.equal(fields.find((field) => field.id === '["unresolved"]')?.kind, 'unknown');
  assert.equal(fields.find((field) => field.id === '["getOnly"]')?.writable, false);
  assert.equal(fields.find((field) => field.id === '["group","enabled"]')?.writable, true);

  const catalog = projectNativeSettingsCatalog(read, {
    format: 1,
    revision: 0,
    overrides: {},
  });

  assert.equal(JSON.stringify(catalog).includes('sentinel'), false);
});

test('Kimi объявляет диалект установленной OpenAPI вместо переноса правил 3.0 в 3.1', () => {
  const schema = { ...openapi, openapi: '3.1.0' };
  const snapshot = kimiSettingsSnapshot(schema, { code: 0, data: {} }, context);

  assert.equal(snapshot.areas[0].dialect, 'openapi-3.1');
});

test('Kimi фактический web CLI получает POST overrides перед prompt', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-kimi-launch-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const bin = path.join(root, 'kimi');
  const fixture = new URL('../fixtures/kimi-server/fake-kimi-turn.mjs', import.meta.url).pathname;

  await fs.writeFile(bin, `#!/bin/sh\nexec ${process.execPath} ${fixture} "$@"\n`);
  await fs.chmod(bin, 0o755);

  const plan = {
    providerId: 'kimi',
    contextFingerprint: 'fixture',
    schemaRevision: 'fixture',
    storageRevision: '1',
    fingerprint: 'false',
    payload: { future: false },
    accepted: [
      {
        fieldId: '["future"]',
        path: ['future'],
        value: false,
        channelId: 'isolated-config-post',
      },
    ],
  };
  const home = path.join(root, 'home');

  const options = {
    bin,
    home,
    cwd: root,
    message: 'fixture',
  };
  const first = await runKimiServerTurn({ ...options, nativeSettings: plan });

  await runKimiServerTurn({ ...options, sessionId: first.sessionId });

  const received = (await fs.readFile(path.join(home, 'fixture-trace.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.deepEqual(received.find((entry) => entry.kind === 'config')?.body, { future: false });
  assert.equal(
    received.findIndex((entry) => entry.kind === 'config') <
      received.findIndex((entry) => entry.kind === 'prompt'),
    true,
  );
  assert.equal(received.filter((entry) => entry.kind === 'config').length, 1);
  assert.equal(received.filter((entry) => entry.kind === 'prompt').length, 2);
});

test('Kimi setter получает собственный config.toml и следующий запуск наследует исходный файл', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-kimi-layer-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const kimiHome = path.join(root, 'user');

  await fs.mkdir(kimiHome);
  await fs.writeFile(path.join(kimiHome, 'config.toml'), 'telemetry = true\nsecret = "sentinel"\n');

  const input = {
    kimiHome,
    runtimeHome: path.join(root, 'runtime'),
    mcpServers: [],
  };
  const selected = await buildKimiHostWebHome({ ...input, isolateConfig: true });
  const isolated = path.join(selected.home, 'config.toml');

  assert.equal((await fs.lstat(isolated)).isSymbolicLink(), false);
  await fs.writeFile(isolated, 'telemetry = false\n');
  await selected.cleanup();

  const reset = await buildKimiHostWebHome(input);

  assert.equal(
    (await fs.readFile(path.join(reset.home, 'config.toml'), 'utf8')).includes('telemetry = true'),
    true,
  );
  assert.equal((await fs.readFile(path.join(kimiHome, 'config.toml'), 'utf8')).includes('sentinel'), true);
  await reset.cleanup();
});
