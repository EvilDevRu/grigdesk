import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attemptResultLabel,
  providerLabel,
  runnerChainLabel,
  runnerModelLabel,
  runnerNodeLabel,
  runnerReasonLabel,
} from '../../web/src/shared/runner-display.js';

test('runner labels remain readable for built-in and future providers', () => {
  assert.equal(providerLabel('claude'), 'Claude');
  assert.equal(providerLabel('codex'), 'Codex');
  assert.equal(providerLabel('new-ai'), 'New ai');
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
      claude: { family: 'opus', version: 'latest' },
      codex: { family: 'sol', version: 'latest' },
    },
  };
  assert.equal(runnerChainLabel(runner), 'Claude → Codex');
  assert.equal(runnerNodeLabel(runner), 'Codex · резерв');
  assert.equal(runnerModelLabel(runner), 'gpt-5.6-sol');
  assert.equal(runnerModelLabel(runner, 'claude'), 'opus');
  assert.equal(runnerReasonLabel(runner.reason), 'закончился лимит');
  assert.equal(attemptResultLabel('manual_switch'), 'переключён вручную');
});
