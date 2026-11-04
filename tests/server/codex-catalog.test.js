import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexModelFamily,
  parseCodexModelList,
} from '../../server/src/lib/executors/codex.ts';

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
  assert.equal(models[0].context, 0);
  assert.equal(models[0].contextUnverified, true);
  assert.equal(models[0].contextRuntimeOnly, true);
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

test('Codex keeps an explicit context window from an older app-server contract', () => {
  const [model] = parseCodexModelList({
    data: [{
      id: 'gpt-context',
      model: 'gpt-context',
      displayName: 'GPT Context',
      contextWindow: 256_000,
    }],
  });

  assert.equal(model.context, 256_000);
  assert.equal(model.contextUnverified, undefined);
  assert.equal(model.contextRuntimeOnly, undefined);
});


test('SPEED-CATALOG: скорости exact записи не берутся у rollout-алиаса', () => {
  const rows = parseCodexModelList({ data: [
    {
      id: 'gpt-test',
      model: 'gpt-test',
      displayName: 'Test',
      serviceTiers: [],
    },
    {
      id: 'codex-test',
      model: 'codex-test',
      displayName: 'Test',
      serviceTiers: [{
        id: 'fast',
        name: 'Fast',
        description: 'Быстрее',
      }],
    },
    {
      id: 'gpt-fast',
      model: 'gpt-fast',
      displayName: 'Fast',
      serviceTiers: [{
        id: 'fast',
        name: 'Fast',
        description: 'Быстрее',
      }],
    },
    {
      id: 'gpt-unknown',
      model: 'gpt-unknown',
      displayName: 'Unknown',
    },
  ] });

  assert.deepEqual(rows.map((row) => [row.id, row.chatSpeedModes]), [
    ['gpt-test', ['standard']],
    ['gpt-fast', ['standard', 'fast']],
    ['gpt-unknown', ['standard']],
  ]);
});


test('SPEED-ULTRA-CATALOG: каждый tier подтверждён exact metadata независимо', () => {
  const rows = parseCodexModelList({ data: [
    { id: 'ultra-only', serviceTiers: [{ id: 'ultrafast' }] },
    { id: 'both', serviceTiers: [{ id: 'fast' }, { id: 'ultrafast' }] },
    { id: 'unknown-tier', serviceTiers: [{ id: 'warp' }] },
    { id: 'empty', serviceTiers: [] },
    { id: 'missing' },
  ] });

  assert.deepEqual(rows.map((row) => row.chatSpeedModes), [
    ['standard', 'ultrafast'], ['standard', 'fast', 'ultrafast'],
    ['standard'], ['standard'], ['standard'],
  ]);
});
