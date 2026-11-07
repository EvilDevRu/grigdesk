import assert from 'node:assert/strict';
import test from 'node:test';

import { readSettingsCliVersion } from '../../server/src/lib/executorSettings/probe.ts';
import { readPublishedSettingsSchema } from '../../server/src/lib/executorSettings/publishedSchema.ts';

test('версия CLI извлекается из ограниченного stdout без публикации произвольного текста', async () => {
  const version = await readSettingsCliVersion(process.execPath, AbortSignal.timeout(2000));

  assert.equal(version, process.versions.node);
});

test('принудительный refresh внешней схемы обходит TTL и обнаруживает новое поле', async (t) => {
  const original = globalThis.fetch;
  let current = { type: 'object', properties: { first: { type: 'boolean' } } };
  let reads = 0;

  globalThis.fetch = async () => {
    reads += 1;

    return Response.json(current);
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const url = 'https://json.schemastore.org/claude-code-settings.json';
  const signal = AbortSignal.timeout(2000);
  const first = await readPublishedSettingsSchema(url, signal);

  current = { type: 'object', properties: { first: { type: 'boolean' }, future: { type: 'string' } } };

  const cached = await readPublishedSettingsSchema(url, signal);
  const refreshed = await readPublishedSettingsSchema(url, signal, { refresh: true });

  assert.equal(Object.hasOwn(first.properties, 'future'), false);
  assert.equal(Object.hasOwn(cached.properties, 'future'), false);
  assert.equal(Object.hasOwn(refreshed.properties, 'future'), true);
  assert.equal(reads, 2);
});
