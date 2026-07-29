import assert from 'node:assert/strict';
import test from 'node:test';

import { modelInfoFromRegistry } from '../../server/src/lib/models-registry.js';

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
});
