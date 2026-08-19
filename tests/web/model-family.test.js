import assert from 'node:assert/strict';
import test from 'node:test';

import {
  familyModels,
  resolveModelFamily,
} from '../../web/src/shared/model-family.js';

const providers = [{
  id: 'codex',
  models: [
    { id: 'gpt-5.6-sol', family: 'sol', name: 'Sol 5.6', tier: 100, extra: false },
    { id: 'gpt-5.5-sol', family: 'sol', name: 'Sol 5.5', tier: 90, extra: true },
    {
      id: 'gpt-5.6-terra',
      family: 'terra',
      name: 'Terra 5.6',
      tier: 80,
      extra: false,
      aliases: ['codex-auto-review'],
      modelRefAliases: ['gpt-5.6-terra[retired]'],
    },
  ],
}];

test('agent picker keeps one current exact model per stable family', () => {
  assert.deepEqual(familyModels(providers[0].models).map((model) => model.id), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
  ]);
});

test('family and legacy exact values resolve without losing explicit pins', () => {
  const family = resolveModelFamily(providers, 'sol');
  assert.equal(family.family, 'sol');
  assert.equal(family.model.id, 'gpt-5.6-sol');
  assert.equal(family.matched.id, 'gpt-5.6-sol');

  const pinned = resolveModelFamily(providers, 'gpt-5.5-sol');
  assert.equal(pinned.family, 'sol');
  assert.equal(pinned.model.id, 'gpt-5.6-sol');
  assert.equal(pinned.matched.id, 'gpt-5.5-sol');

  const alias = resolveModelFamily(providers, 'codex-auto-review');
  assert.equal(alias.family, 'terra');
  assert.equal(alias.model.id, 'gpt-5.6-terra');

  const retiredExact = resolveModelFamily(providers, 'gpt-5.6-terra[retired]');
  assert.equal(retiredExact.family, 'terra');
  assert.equal(retiredExact.model.id, 'gpt-5.6-terra');
  assert.equal(retiredExact.matched.id, 'gpt-5.6-terra');
});
