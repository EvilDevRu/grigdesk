import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attemptResultLabel,
  PROVIDER_LABELS,
  providerLabel,
  runnerAttemptModelLabel,
  runnerChainLabel,
  runnerEffortLabel,
  runnerModelEffortLabel,
  runnerModelLabel,
  runnerNodeLabel,
  runnerReasonLabel,
} from '../../web/src/shared/runner-display.js';

test('runner labels remain readable for built-in and future providers', () => {
  assert.equal(providerLabel('claude'), 'Claude');
  assert.equal(providerLabel('codex'), 'Codex');
  assert.equal(providerLabel('new-ai'), 'New ai');
});

test('kimi label comes from PROVIDER_LABELS, not from the id fallback', () => {
  // providerLabel('kimi') через fallback тоже дал бы 'Kimi', поэтому проверяем
  // саму каноническую запись в PROVIDER_LABELS, а не только результат функции.
  assert.ok(
    Object.hasOwn(PROVIDER_LABELS, 'kimi'),
    'kimi has a canonical entry in PROVIDER_LABELS',
  );
  assert.equal(PROVIDER_LABELS.kimi, 'Kimi');
  assert.equal(providerLabel('kimi'), 'Kimi');
});

test('provider_unavailable attempt result has a human-readable label', () => {
  const label = attemptResultLabel('provider_unavailable');
  assert.equal(label, 'провайдер недоступен');
  assert.notEqual(label, 'provider_unavailable');
});

test('chain and emergency switch are visible without model-version hardcoding', () => {
  const runner = {
    primary: 'claude',
    failover: ['codex'],
    chain: ['claude', 'codex'],
    actual: 'codex',
    reason: 'fallback_limit',
    switched: true,
    model: 'gpt-5.6-sol',
    models: {
      claude: { family: 'opus', version: 'latest', effort: 'max' },
      codex: { family: 'sol', version: 'latest', effort: 'max' },
    },
    attempts: [
      { runner: 'claude', model: 'opus', effort: 'high' },
      { runner: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' },
    ],
  };
  assert.equal(runnerChainLabel(runner), 'Claude → Codex');
  assert.equal(runnerNodeLabel(runner), 'Codex · резерв');
  assert.equal(runnerModelLabel(runner), 'gpt-5.6-sol');
  assert.equal(runnerModelLabel(runner, 'claude'), 'opus');
  assert.equal(runnerEffortLabel(runner), 'ultra');
  assert.equal(runnerModelEffortLabel(runner), 'gpt-5.6-sol · effort ultra');
  assert.equal(runnerModelEffortLabel(runner, 'claude'), 'opus · effort high');
  assert.equal(runnerAttemptModelLabel(runner.attempts[0]), 'opus · effort high');
  assert.equal(runnerReasonLabel(runner.reason), 'закончился лимит');
  assert.equal(attemptResultLabel('manual_switch'), 'переключён вручную');
});

test('missing attempt telemetry falls back to runner policy', () => {
  const runner = {
    primary: 'codex', actual: 'codex', model: 'gpt-5.6-sol',
    attempts: [{ runner: 'codex', model: 'gpt-5.6-sol' }],
    models: { codex: { family: 'sol', version: 'latest', effort: 'max' } },
  };
  assert.equal(runnerModelEffortLabel(runner), 'gpt-5.6-sol · effort max');
});
