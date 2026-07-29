import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexModelFamily,
  parseCodexModelList,
} from '../../server/src/lib/executors/codex.js';

test('Codex model/list becomes a current picker without duplicate aliases', () => {
  const models = parseCodexModelList({
    data: [
      {
        id: 'gpt-next-sol',
        model: 'gpt-next-sol',
        displayName: 'GPT Next Sol',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'high' },
          { reasoningEffort: 'ultra' },
        ],
        inputModalities: ['text', 'image'],
      },
      {
        id: 'codex-auto-review',
        model: 'codex-auto-review',
        displayName: 'GPT Next Terra',
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
      },
      {
        id: 'gpt-next-terra',
        model: 'gpt-next-terra',
        displayName: 'GPT Next Terra',
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
        ],
      },
      {
        id: 'gpt-old',
        model: 'gpt-old',
        displayName: 'GPT Old',
        hidden: false,
        upgrade: 'gpt-next-terra',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
      },
      {
        id: 'gpt-hidden',
        model: 'gpt-hidden',
        displayName: 'GPT Hidden',
        hidden: true,
        supportedReasoningEfforts: [],
      },
    ],
  });

  assert.deepEqual(models.map((m) => m.id), [
    'gpt-next-sol',
    'gpt-next-terra',
    'gpt-old',
    'gpt-hidden',
  ]);
  assert.deepEqual(models[0].efforts, ['low', 'high', 'ultra']);
  assert.equal(models[0].family, 'sol');
  assert.equal(models[0].defaultEffort, 'low');
  assert.equal(models[0].isDefault, true);
  assert.deepEqual(models[0].inputModalities, ['text', 'image']);
  assert.deepEqual(models[1].aliases, ['codex-auto-review']);
  assert.equal(models[1].family, 'terra');
  assert.equal(models[1].extra, false);
  assert.equal(models[2].extra, true, 'model with an official upgrade stays behind “show all”');
  assert.equal(models[3].extra, true, 'hidden app-server model stays behind “show all”');
});

test('Codex versioned slugs expose a stable family for model policy', () => {
  assert.equal(codexModelFamily('gpt-5.6-sol'), 'sol');
  assert.equal(codexModelFamily('gpt-next-terra'), 'terra');
  assert.equal(codexModelFamily('gpt-5.6'), '');
});

test('Codex model/list rejects an empty response so the previous catalog survives', () => {
  assert.equal(parseCodexModelList(null), null);
  assert.equal(parseCodexModelList({ data: [] }), null);
});
