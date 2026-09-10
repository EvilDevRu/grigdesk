import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeCatalogModel,
  modelInfoFromRegistry,
  resolveModelEfforts,
} from '../../server/src/lib/modelsRegistry.ts';

const registry = {
  codex: [
    { id: 'gpt-5.6-sol', family: 'sol', tier: 100, extra: false },
    { id: 'gpt-5.5-sol', family: 'sol', tier: 90, extra: true },
    {
      id: 'gpt-5.6-terra',
      family: 'terra',
      tier: 80,
      extra: false,
      aliases: ['codex-auto-review'],
      modelRefAliases: ['gpt-5.6-terra-retired'],
    },
  ],
};

test('model registry resolves family policy to its current catalog model', () => {
  const info = modelInfoFromRegistry('sol', registry);
  assert.equal(info.provider, 'codex');
  assert.equal(info.model.id, 'gpt-5.6-sol');
});

test('exact model pins and aliases keep precedence over family resolution', () => {
  assert.equal(modelInfoFromRegistry('gpt-5.5-sol', registry).model.id, 'gpt-5.5-sol');
  assert.equal(modelInfoFromRegistry('codex-auto-review', registry).model.id, 'gpt-5.6-terra');
  assert.equal(modelInfoFromRegistry('gpt-5.6-terra-retired', registry).model.id, 'gpt-5.6-terra');
});

test('live catalog effort updates replace an ordinary cached copy', () => {
  const cached = { id: 'gpt-next-sol', efforts: ['low', 'high'] };
  const live = { id: 'gpt-next-sol', efforts: ['low', 'high', 'ultra'] };
  assert.deepEqual(mergeCatalogModel(live, cached).efforts, ['low', 'high', 'ultra']);
});

test('only explicit custom models may override live catalog efforts', () => {
  const cached = { id: 'custom', efforts: ['local'], custom: true };
  const live = { id: 'custom', efforts: ['remote'] };
  assert.deepEqual(mergeCatalogModel(live, cached).efforts, ['local']);
});

test('runtime-only context replaces a stale catalog fallback instead of preserving it', () => {
  const cached = { id: 'gpt-next-sol', context: 400_000 };
  const live = {
    id: 'gpt-next-sol',
    context: 0,
    contextUnverified: true,
    contextRuntimeOnly: true,
  };
  const merged = mergeCatalogModel(live, cached);

  assert.equal(merged.context, 0);
  assert.equal(merged.contextRuntimeOnly, true);
});

test('missing effort discovery stays empty instead of inventing levels', () => {
  assert.deepEqual(resolveModelEfforts(null, null), []);
  assert.deepEqual(resolveModelEfforts(null, ['low', 'future']), ['low', 'future']);
});

test('live CLI discovery replaces stale stored efforts unless the model is custom', () => {
  assert.deepEqual(
    resolveModelEfforts(['low', 'high'], ['low', 'high', 'future']),
    ['low', 'high', 'future'],
  );
  assert.deepEqual(
    resolveModelEfforts(['local'], ['remote'], true),
    ['local'],
  );
});
