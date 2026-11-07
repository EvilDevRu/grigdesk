import assert from 'node:assert/strict';
import test from 'node:test';

import {
  familyModels,
  markSupersededModels,
  resolveModelFamily,
} from '../../shared/chat/modelFamily.ts';

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

// Запись каталога: extra передаётся, только когда его объявил сам исполнитель.
function catalogModel(id, family, tier, extra) {
  return {
    id,
    ...(family && { family }),
    tier,
    ...(extra !== undefined && { extra }),
  };
}

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

test('краткий список: в семействе актуальна одна модель, прежние версии уходят в extra', () => {
  const models = [
    catalogModel('gpt-6.1-sol', 'sol', 100, false),
    catalogModel('gpt-6-sol', 'sol', 90, false),
    catalogModel('gpt-6-luna', 'luna', 80, false),
    catalogModel('gpt-5.6-luna', 'luna', 70),
    catalogModel('gpt-5.6-terra', 'terra', 60, false),
    catalogModel('gpt-reserve', '', 50, false),
  ];
  const snapshot = structuredClone(models);
  const marked = markSupersededModels(models);

  assert.deepEqual(marked.map((model) => [model.id, !!model.extra]), [
    ['gpt-6.1-sol', false],
    ['gpt-6-sol', true],
    ['gpt-6-luna', false],
    ['gpt-5.6-luna', true],
    ['gpt-5.6-terra', false],
    ['gpt-reserve', false],
  ]);
  assert.deepEqual(models, snapshot);
});

test('краткий список не снимает extra исполнителя и не прячет замену скрытой модели', () => {
  const marked = markSupersededModels([
    catalogModel('gpt-7-sol', 'sol', 100, true),
    catalogModel('gpt-6.1-sol', 'sol', 90, false),
    catalogModel('gpt-6-sol', 'sol', 80, false),
  ]);

  assert.deepEqual(marked.map((model) => [model.id, !!model.extra]), [
    ['gpt-7-sol', true],
    ['gpt-6.1-sol', false],
    ['gpt-6-sol', true],
  ]);
});

test('форма актуальной модели остаётся с ней, форма прежней версии уходит в extra', () => {
  const marked = markSupersededModels([
    catalogModel('opus-4-6', 'opus', 9046),
    { ...catalogModel('opus-4-6[1m]', 'opus', 9045), variantOf: 'opus-4-6' },
    catalogModel('opus-4-5', 'opus', 9045),
    { ...catalogModel('opus-4-5[1m]', 'opus', 9044), variantOf: 'opus-4-5' },
  ]);

  assert.deepEqual(marked.map((model) => [model.id, !!model.extra]), [
    ['opus-4-6', false],
    ['opus-4-6[1m]', false],
    ['opus-4-5', true],
    ['opus-4-5[1m]', true],
  ]);
});
