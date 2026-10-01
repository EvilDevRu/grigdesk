import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeSettingsSnapshot } from '../../server/src/lib/executorSettings/claude.ts';
import { ProviderSettingsCatalogCache } from '../../server/src/lib/executorSettings/catalog.ts';
import { flattenNativeSettings } from '../../server/src/lib/executorSettings/validation.ts';
import { projectNativeSettingsCatalog } from '../../server/src/lib/executorSettings/projection.ts';
import claude from '../../server/src/lib/executors/claude.ts';

const context = {
  providerId: 'claude',
  binaryIdentity: 'fixture',
  profileFingerprint: 'fixture',
  transport: 'stream-json',
  mode: 'default',
  cwdRealpath: '/fixture',
};
const schema = {
  type: 'object',
  properties: {
    future: { type: 'boolean' },
    mismatch: { type: 'string' },
    hooks: { type: 'boolean' },
    env: { type: 'object' },
  },
};

test('Claude partial соединяет схему с effective и закрывает конфликтующие/управляемые ветки', async () => {
  const cache = new ProviderSettingsCatalogCache();
  const read = await cache.read(
    {
      discover: async () =>
        claudeSettingsSnapshot(
          {
            effective: {
              mismatch: false,
              unknown: 'untyped-sentinel',
              env: { TOKEN: 'secret-sentinel' },
            },
            sources: { userSettings: { env: { TOKEN: 'source-sentinel' } } },
            applied: { model: 'owned' },
          },
          schema,
          context,
        ),
    },
    context,
  );
  const fields = flattenNativeSettings(read.fields);

  assert.equal(read.state, 'partial');
  assert.equal(fields.find((field) => field.id === '["future"]')?.writable, true);
  assert.equal(fields.find((field) => field.id === '["unknown"]')?.kind, 'unknown');
  assert.equal(fields.find((field) => field.id === '["mismatch"]')?.writable, false);
  assert.equal(fields.find((field) => field.id === '["hooks"]')?.writable, false);
  assert.equal(
    JSON.stringify(
      projectNativeSettingsCatalog(read, {
        format: 1,
        revision: 0,
        overrides: {},
      }),
    ).includes('sentinel'),
    false,
  );
});

test('Claude CLI принимает JSON override и resume после reset сохраняет fastMode и hooks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-claude-launch-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const bin = path.join(root, 'claude');

  await fs.copyFile(new URL('../fixtures/claude-in-turn/fake-claude.mjs', import.meta.url), bin);
  await fs.chmod(bin, 0o755);

  const trace = path.join(root, 'trace.jsonl');
  const plan = {
    providerId: 'claude',
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
        channelId: 'settings-json-overlay',
      },
    ],
  };

  const options = {
    config: { claudeBin: bin },
    cwd: root,
    message: 'fixture',
    env: {
      ...process.env,
      COCKPIT_CLAUDE_FIXTURE_TRACE: trace,
      COCKPIT_CLAUDE_FIXTURE_SETTINGS: '1',
    },
    providerSettings: { fastMode: true },
    onInTurnReady(port) {
      void port.deliver({
        text: 'Уточнение',
        messageId: 'fixture-injected',
        sequence: 1,
      });
    },
  };
  const first = await claude.run({ ...options, nativeSettings: plan });

  await claude.run({ ...options, sessionId: first.sessionId });

  const received = (await fs.readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const processes = received.filter((entry) => entry.direction === 'process');
  const argv = processes[0].argv;
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
  const resumed = processes[1].argv;
  const inherited = JSON.parse(resumed[resumed.indexOf('--settings') + 1]);

  assert.equal(settings.future, false);
  assert.equal(settings.fastMode, true);
  assert.equal(Array.isArray(settings.hooks.PreToolUse), true);
  assert.equal(resumed[resumed.indexOf('--resume') + 1], first.sessionId);
  assert.equal(Object.hasOwn(inherited, 'future'), false);
  assert.equal(inherited.fastMode, true);
  assert.equal(Array.isArray(inherited.hooks.PreToolUse), true);
  assert.equal(claude.session.restartOn.includes('nativeSettingsFingerprint'), true);
});
