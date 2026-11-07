import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import schema from '../fixtures/executor-settings/synthetic-v1.json' with { type: 'json' };
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import { normalizeJsonSchema } from '../../server/src/lib/executorSettings/jsonSchema.ts';
import { updateNativeSettingsOverride } from '../../server/src/lib/executorSettings/overrides.ts';

test('адресная запись false сохраняет SSH и соседнего исполнителя', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-overrides-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const prefs = new PrefsStore({ prefsPath: path.join(root, 'prefs.json') });

  prefs.write({ providerSettings: { 'future-provider': { blockDirectSsh: true }, neighbor: { keep: 7 } } });

  const fields = normalizeJsonSchema(schema, {
    path: [],
    writeChannel: {
      id: 'overlay',
      scope: 'grigdesk-chats',
      state: 'verified',
    },
    ownership: [],
  });
  const result = updateNativeSettingsOverride(
    prefs,
    'future-provider',
    {
      fieldId: '["enabled"]',
      operation: 'set',
      value: false,
      schemaRevision: 'v1',
      revision: '0',
    },
    {
      fields,
      schemaRevision: 'v1',
      state: 'ready',
    },
  );

  assert.equal(result.changed, true);
  assert.deepEqual(prefs.read().providerSettings, {
    'future-provider': {
      blockDirectSsh: true,
      nativeSettings: {
        format: 1,
        revision: 1,
        overrides: { '["enabled"]': { path: ['enabled'], value: false } },
      },
    },
    neighbor: { keep: 7 },
  });
});

test('повреждённое хранилище не обнуляется и не перезаписывается при unset', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-corrupt-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const file = path.join(root, 'prefs.json');
  const prefs = new PrefsStore({ prefsPath: file });
  const invalid = [
    null,
    [],
    'broken',
    { 'future-provider': null },
    {
      'future-provider': {
        nativeSettings: {
          format: 2,
          revision: 0,
          overrides: {},
        },
      },
    },
    {
      'future-provider': {
        nativeSettings: {
          format: 1,
          revision: 0,
          overrides: {
            '["enabled"]': { path: ['enabled'], value: { constructor: 'sentinel' } },
          },
        },
      },
    },
  ];

  for (const providerSettings of invalid) {
    fs.writeFileSync(file, JSON.stringify({ providerSettings, keep: 'neighbor' }));

    const before = fs.readFileSync(file, 'utf8');

    assert.throws(() =>
      updateNativeSettingsOverride(
        prefs,
        'future-provider',
        {
          fieldId: '["enabled"]',
          operation: 'unset',
          revision: '0',
          schemaRevision: null,
        },
        {
          fields: [],
          schemaRevision: null,
          state: 'unavailable',
        },
      ),
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('CAS и no-op сохраняют ревизию, а reset последнего поля исключает запись старой вкладки', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cas-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const file = path.join(root, 'prefs.json');
  const prefs = new PrefsStore({ prefsPath: file });
  const fields = normalizeJsonSchema(schema, {
    path: [],
    ownership: [],
    writeChannel: {
      id: 'overlay',
      scope: 'grigdesk-chats',
      state: 'verified',
    },
  });
  const catalog = {
    fields,
    schemaRevision: 'v1',
    state: 'ready',
  };
  const request = {
    fieldId: '["enabled"]',
    operation: 'set',
    value: false,
    schemaRevision: 'v1',
    revision: '0',
  };
  const first = updateNativeSettingsOverride(prefs, 'future-provider', request, catalog);
  const before = fs.readFileSync(file, 'utf8');
  const unchanged = updateNativeSettingsOverride(
    prefs,
    'future-provider',
    { ...request, revision: '1' },
    catalog,
  );

  assert.equal(first.storage.revision, 1);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.storage.revision, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => updateNativeSettingsOverride(prefs, 'future-provider', request, catalog), {
    code: 'revision_conflict',
    statusCode: 409,
  });

  const unset = {
    fieldId: '["enabled"]',
    operation: 'unset',
    schemaRevision: null,
    revision: '1',
  };
  const reset = updateNativeSettingsOverride(prefs, 'future-provider', unset, {
    fields: [],
    schemaRevision: null,
    state: 'unavailable',
  });
  const repeated = updateNativeSettingsOverride(
    prefs,
    'future-provider',
    { ...unset, revision: '2' },
    catalog,
  );

  assert.equal(reset.storage.revision, 2);
  assert.deepEqual(reset.storage.overrides, {});
  assert.equal(repeated.changed, false);
  assert.equal(repeated.storage.revision, 2);
  assert.throws(() => updateNativeSettingsOverride(prefs, 'future-provider', request, catalog), {
    code: 'revision_conflict',
    statusCode: 409,
  });
});
