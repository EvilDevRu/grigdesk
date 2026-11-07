import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYTICS_NORMALIZER_DIALECTS,
  normalizeProviderUsage,
  normalizeProviderUsageRows,
} from '../../server/src/lib/analytics/normalizers.ts';

const run = Object.freeze({
  taskId: 't42', runId: 'run-deepseek', epoch: '1', processComplete: true,
});

test('DeepSeek Factory usage остаётся unavailable, а не выдуманным нулём', () => {
  assert.equal(Object.hasOwn(ANALYTICS_NORMALIZER_DIALECTS, 'deepseek'), false);
  const result = normalizeProviderUsage({
    provider: 'deepseek',
    dialect: 'deepseek-jsonl-unknown',
    rawText: '{"event":"usage_update","used":123,"size":1000}\n',
    run,
  });
  assert.equal(result.completeness, 'missing');
  assert.equal(result.source, 'unavailable');
  assert.deepEqual(result.samples, []);
  assert.deepEqual(result.usageSegments, []);
  assert.deepEqual(result.diagnostics, ['unsupportedProvider']);
});

test('оборванный DeepSeek JSONL не превращается в нулевой расход', () => {
  const result = normalizeProviderUsageRows({
    provider: 'deepseek',
    dialect: 'deepseek-jsonl-unknown',
    rows: [],
    hasTornTail: true,
    run: { ...run, processComplete: false },
  });
  assert.equal(result.completeness, 'missing');
  assert.equal(result.source, 'unavailable');
  assert.deepEqual(result.samples, []);
  assert.deepEqual(result.usageSegments, []);
  assert.deepEqual(result.diagnostics, ['unsupportedProvider']);
});
