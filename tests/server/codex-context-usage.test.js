import assert from 'node:assert/strict';
import test from 'node:test';

import { codexContextEstimateTokens } from '../../server/src/lib/executors/codex.js';

test('Codex context estimate does not count cached input twice', () => {
  assert.equal(codexContextEstimateTokens({
    input_tokens: 120_000,
    cached_input_tokens: 110_000,
  }), 120_000);
  assert.equal(codexContextEstimateTokens({ input_tokens: 0, cached_input_tokens: 10_000 }), 0);
  assert.equal(codexContextEstimateTokens(null), 0);
});
