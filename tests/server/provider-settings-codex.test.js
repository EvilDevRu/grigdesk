import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexSettingsSnapshot } from '../../server/src/lib/executorSettings/codex.ts';
import { ProviderSettingsCatalogCache } from '../../server/src/lib/executorSettings/catalog.ts';
import { flattenNativeSettings } from '../../server/src/lib/executorSettings/validation.ts';
import { nativeSettingsTomlArgs } from '../../server/src/lib/executorSettings/toml.ts';
import codex from '../../server/src/lib/executors/codex.ts';

const context = {
  providerId: 'codex',
  binaryIdentity: 'fixture',
  profileFingerprint: 'fixture',
  transport: 'app-server',
  mode: 'default',
  cwdRealpath: '/fixture',
};
const schema = {
  definitions: {
    Config: {
      type: 'object',
      additionalProperties: true,
      properties: { future: { type: 'string' } },
    },
  },
};

test('Codex читает все страницы flags и сохраняет managed/removed/unknown stage как read-only', async () => {
  const cursors = [];
  /**
   * Fixture воспроизводит две страницы и независимые требования CLI.
   * Наблюдаемая очередь cursors показывает настоящий обход пагинации.
   */
  const rpc = async (method, params) => {
    if (method === 'config/read') {
      return { config: { future: '', unexplained: 7 } };
    }

    if (method === 'configRequirements/read') {
      return { requirements: { features: { managed: true } } };
    }

    cursors.push(params.cursor ?? null);

    const flags = params.cursor
      ? [
          { name: 'managed', stage: 'stable' },
          { name: 'retired', stage: 'removed' },
          { name: 'future-stage', stage: 'something-new' },
        ]
      : [{ name: 'new-flag', stage: 'beta' }];

    return {
      data: flags.map((flag) => ({
        ...flag,
        description: null,
        displayName: null,
        enabled: false,
        defaultEnabled: true,
      })),
      nextCursor: params.cursor ? null : 'next',
    };
  };
  const cache = new ProviderSettingsCatalogCache();
  const read = await cache.read({ discover: () => codexSettingsSnapshot(rpc, schema, context) }, context);
  const fields = flattenNativeSettings(read.fields);

  assert.deepEqual(cursors, [null, 'next']);
  assert.equal(read.state, 'partial');
  assert.equal(fields.find((field) => field.id === '["features","new-flag"]')?.writable, true);
  assert.equal(fields.find((field) => field.path.at(-1) === 'managed')?.writable, false);
  assert.equal(fields.find((field) => field.path.at(-1) === 'retired')?.writable, false);
  assert.equal(fields.find((field) => field.path.at(-1) === 'future-stage')?.writable, false);
  assert.equal(fields.find((field) => field.path.at(-1) === 'unexplained')?.kind, 'unknown');
});

test('Codex передаёт native план в argv и thread; resume после reset снимает слой', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-codex-launch-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const bin = path.join(root, 'codex');

  await fs.copyFile(new URL('../fixtures/codex-app-server/rich-turn-0.149.0.mjs', import.meta.url), bin);
  await fs.chmod(bin, 0o755);

  const trace = path.join(root, 'trace.jsonl');
  const plan = {
    providerId: 'codex',
    contextFingerprint: 'fixture',
    schemaRevision: 'fixture',
    storageRevision: '1',
    fingerprint: 'false',
    accepted: [
      {
        fieldId: '["features","future_flag"]',
        path: ['features', 'future_flag'],
        value: false,
        channelId: 'app-server-config',
      },
    ],
    payload: { features: { future_flag: false } },
  };
  const options = {
    config: { codexBin: bin },
    cwd: root,
    message: 'fixture',
    providerSettings: { blockDirectSsh: false },
    tokenInfoReader: async () => null,
    env: {
      ...process.env,
      COCKPIT_CODEX_FIXTURE_TRACE: trace,
      COCKPIT_CODEX_FIXTURE_SCENARIO: 'native-settings',
      COCKPIT_CODEX_FIXTURE_EXPECT_HOOK: '0',
    },
  };
  const first = await codex.run({ ...options, nativeSettings: plan });

  await codex.run({ ...options, sessionId: first.sessionId });

  const received = (await fs.readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const processes = received.filter((entry) => entry.direction === 'process');

  assert.equal(processes[0].argv.includes('features={ "future_flag" = false }'), true);
  assert.equal(processes[1].argv.includes('features={ "future_flag" = false }'), false);

  const thread = received.find((entry) => entry.message?.method === 'thread/start');

  assert.deepEqual(thread.message.params.config.features, { future_flag: false });
  assert.equal(thread.message.params.config.model_reasoning_summary, 'detailed');
  assert.equal(codex.session.restartOn.includes('nativeSettingsFingerprint'), true);
});

test('Codex argv сериализует typed значения, Unicode, кавычки и буквальную точку в TOML', () => {
  const payload = { future: { 'a.b': 'строка "quote" \\ путь\n', list: [false, 0, ''] } };

  assert.deepEqual(nativeSettingsTomlArgs({ payload, accepted: [{ path: ['future', 'a.b'] }] }), [
    '-c',
    'future={ "a.b" = "строка \\"quote\\" \\\\ путь\\n", "list" = [false, 0, ""] }',
  ]);
  assert.deepEqual(nativeSettingsTomlArgs(), []);
});
