// Проверяет нормализацию потребления потоков Codex и Claude в общие аналитические данные.
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProviderUsage } from '../../server/src/lib/analytics/normalizers.js';

const RUN = Object.freeze({
  taskId: 't42',
  attemptId: 'a_0123456789abcdef0123456789abcdef',
  nodeVisitId: 'nv_0123456789abcdef0123456789abcdef',
  nodeExecutionId: 'ne_0123456789abcdef0123456789abcdef',
  dispatchId: 'd_0123456789abcdef0123456789abcdef',
  runId: 'run-test-1',
  epoch: '1',
  startedAt: '2026-08-19T10:00:00.000Z',
  finishedAt: '2026-08-19T10:05:00.000Z',
  lifecycleEventHash: 'a'.repeat(64),
  processComplete: true,
  providerScopeUnique: true,
});

function lines(...values) {
  return `${values.join('\n')}\n`;
}

test('Codex cumulative snapshots дают terminal-minus-zero, а duplicate не удваивается', () => {
  const rawText = lines(
    '{"type":"thread.started","thread_id":"thread-1"}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":60,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":3}}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":60,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":3}}',
    '{"type":"turn.completed","usage":{"input_tokens":130,"cached_input_tokens":75,"cache_write_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":5}}',
  );
  const input = {
    provider: 'codex',
    dialect: 'codex-jsonl-v1',
    rawText,
    run: { ...RUN, providerSessionMode: 'fresh', resolvedModel: 'gpt-5.6-sol' },
  };

  const result = normalizeProviderUsage(input);
  assert.equal(result.completeness, 'complete');
  assert.deepEqual(result.tokenSummary, {
    uncachedInput: '55',
    output: '20',
    cacheRead: '75',
    cacheWrite5m: '0',
    cacheWrite1h: '0',
    cacheWriteUnknown: '0',
  });
  assert.equal(result.samples.length, 3);
  assert.equal(result.usageSegments.length, 3);
  assert.ok(result.usageSegments.some((segment) => segment.metric === 'input_tokens'));
  assert.ok(result.usageSegments.every((segment) => (
    segment.attributes.billingProduct === 'responses'
      && segment.resolvedModel === 'gpt-5.6-sol'
  )));
  assert.deepEqual(result.terminalCounterCheckpoint.vector, {
    inputTokens: '130', cachedInputTokens: '75', cacheWriteInputTokens: '0',
    outputTokens: '20', reasoningOutputTokens: '5',
  });
  assert.equal(result.terminalCounterCheckpoint.resumeEligible, true);
  assert.deepEqual(normalizeProviderUsage(input), result, 'повтор extraction byte-стабилен');
});

test('Codex historical snapshot без host fresh proof остаётся approximate и non-resumable', () => {
  const result = normalizeProviderUsage({
    provider: 'codex',
    dialect: 'codex-jsonl-v1',
    rawText: lines(
      '{"type":"thread.started","thread_id":"legacy-thread"}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"cache_write_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":0}}',
    ),
    run: { ...RUN, providerSessionMode: 'legacy-derived' },
  });

  assert.equal(result.completeness, 'partial');
  assert.equal(result.provenance, 'approximate');
  assert.equal(result.terminalCounterCheckpoint, null);
  assert.equal(result.lastObservedCounter.resumeEligible, false);
  assert.ok(result.diagnostics.includes('legacyFreshAssumption'));
});

test('Codex decrease без explicit reset становится conflict, а negative delta не публикуется', () => {
  const result = normalizeProviderUsage({
    provider: 'codex',
    dialect: 'codex-jsonl-v1',
    rawText: lines(
      '{"type":"thread.started","thread_id":"thread-1"}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"cache_write_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":0}}',
      '{"type":"turn.completed","usage":{"input_tokens":9,"cached_input_tokens":2,"cache_write_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":0}}',
    ),
    run: { ...RUN, providerSessionMode: 'fresh' },
  });

  assert.equal(result.completeness, 'conflict');
  assert.equal(result.terminalCounterCheckpoint, null);
  assert.ok(result.diagnostics.includes('cumulativeResetAmbiguous'));
});

test('Codex resume вычитает только exact scope-bound predecessor checkpoint', () => {
  const checkpoint = {
    counterScope: 'thread-resume', counterGeneration: '0',
    vector: {
      inputTokens: '100', cachedInputTokens: '60', cacheWriteInputTokens: '0',
      outputTokens: '10', reasoningOutputTokens: '3',
    },
    presenceMask: [
      'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
      'outputTokens', 'reasoningOutputTokens',
    ],
    dialect: 'codex-jsonl-v1', extractorVersion: 'usage-normalizer-1',
    lifecycleEventHash: 'b'.repeat(64), checkpointHash: 'c'.repeat(64),
    resumeEligible: true,
  };
  const baseRun = {
    ...RUN,
    providerSessionMode: 'resume',
    requestedProviderScope: 'thread-resume',
    lineageGeneration: 1,
    parentUsageRef: { resumeVerified: true, terminalCounterCheckpoint: checkpoint },
  };
  const rawText = lines(
    '{"type":"thread.started","thread_id":"thread-resume"}',
    '{"type":"turn.completed","usage":{"input_tokens":150,"cached_input_tokens":80,"cache_write_input_tokens":0,"output_tokens":16,"reasoning_output_tokens":4}}',
  );
  const result = normalizeProviderUsage({
    provider: 'codex', dialect: 'codex-jsonl-v1', rawText, run: baseRun,
  });
  assert.equal(result.completeness, 'complete');
  assert.deepEqual(result.tokenSummary, {
    uncachedInput: '30', output: '6', cacheRead: '20',
    cacheWrite5m: '0', cacheWrite1h: '0', cacheWriteUnknown: '0',
  });
  assert.equal(result.terminalCounterCheckpoint.counterScope, 'thread-resume');
  assert.equal(result.terminalCounterCheckpoint.counterGeneration, '1');

  for (const run of [
    { ...baseRun, requestedProviderScope: 'other-thread' },
    { ...baseRun, parentUsageRef: null },
    {
      ...baseRun,
      parentUsageRef: {
        resumeVerified: true,
        terminalCounterCheckpoint: { ...checkpoint, resumeEligible: false },
      },
    },
  ]) {
    const rejected = normalizeProviderUsage({
      provider: 'codex', dialect: 'codex-jsonl-v1', rawText, run,
    });
    assert.equal(rejected.completeness, 'conflict');
    assert.equal(rejected.usageSegments.length, 0);
    assert.ok(rejected.diagnostics.some((code) => (
      code === 'scopeConflict' || code === 'baselineMissing'
    )));
  }
});

test('Codex raw thread marker без trusted host fresh proof не доказывает zero baseline', () => {
  const result = normalizeProviderUsage({
    provider: 'codex', dialect: 'codex-jsonl-v1',
    rawText: lines(
      '{"type":"thread.started","thread_id":"forged-thread"}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"cache_write_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":1}}',
    ),
    run: { ...RUN, providerSessionMode: 'fresh', providerScopeUnique: false },
  });
  assert.equal(result.completeness, 'conflict');
  assert.ok(result.diagnostics.includes('baselineMissing'));
});

test('Codex игнорирует non-usage payload до exact parsing и сохраняет baseline corpus', () => {
  const result = normalizeProviderUsage({
    provider: 'codex', dialect: 'codex-jsonl-v1',
    rawText: lines(
      '{"type":"thread.started","thread_id":"thread-envelope"}',
      '{"type":"item.started","item":{"ignored":"\\ud800","number":1e1001}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"cache_write_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":1}}',
    ),
    run: { ...RUN, providerSessionMode: 'fresh' },
  });
  assert.equal(result.completeness, 'complete');
  assert.deepEqual(result.tokenSummary, {
    uncachedInput: '6', output: '3', cacheRead: '4',
    cacheWrite5m: '0', cacheWrite1h: '0', cacheWriteUnknown: '0',
  });
});

test('Codex explicit new fresh scope начинает новую generation без silent reset', () => {
  const result = normalizeProviderUsage({
    provider: 'codex', dialect: 'codex-jsonl-v1',
    rawText: lines(
      '{"type":"thread.started","thread_id":"thread-1"}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":60,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":3}}',
      '{"type":"thread.started","thread_id":"thread-2"}',
      '{"type":"turn.completed","usage":{"input_tokens":20,"cached_input_tokens":5,"cache_write_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":1}}',
    ),
    run: { ...RUN, providerSessionMode: 'fresh' },
  });
  assert.equal(result.completeness, 'complete');
  assert.deepEqual(result.tokenSummary, {
    uncachedInput: '55', output: '13', cacheRead: '65',
    cacheWrite5m: '0', cacheWrite1h: '0', cacheWriteUnknown: '0',
  });
  assert.deepEqual(
    [...new Set(result.samples.map((sample) => sample.counterGeneration))],
    ['0', '1'],
  );
  assert.equal(result.terminalCounterCheckpoint.counterScope, 'thread-2');
  assert.equal(result.terminalCounterCheckpoint.counterGeneration, '1');
  assert.ok(result.diagnostics.includes('cumulativeResetAccepted'));
});

test('Codex missing component не обнуляет независимую output metric', () => {
  const result = normalizeProviderUsage({
    provider: 'codex', dialect: 'codex-jsonl-v1',
    rawText: lines(
      '{"type":"thread.started","thread_id":"thread-components"}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"cache_write_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":1}}',
      '{"type":"turn.completed","usage":{"input_tokens":20,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":2}}',
    ),
    run: { ...RUN, providerSessionMode: 'fresh' },
  });
  assert.equal(result.completeness, 'partial');
  assert.equal(result.terminalCounterCheckpoint, null);
  assert.ok(result.diagnostics.includes('counterComponentMissing'));
  assert.equal(result.usageSegments.some((segment) => segment.metric === 'input_tokens'), false);
  const output = result.usageSegments.find((segment) => segment.metric === 'output_tokens');
  assert.equal(output.quantity, '5');
  assert.equal(output.completeness, 'complete');
  const cacheRead = result.usageSegments.find((segment) => segment.metric === 'cache_read_tokens');
  assert.equal(cacheRead.quantity, '2');
  assert.equal(cacheRead.completeness, 'partial');
});

test('Claude terminal modelUsage является whole-run authority и cost суммируется exact', () => {
  const rawText = lines(
    '{"type":"system","subtype":"init","session_id":"session-1","claude_code_version":"2.1.220"}',
    '{"type":"result","subtype":"success","session_id":"session-1","usage":{"input_tokens":999999},"total_cost_usd":99,"modelUsage":{"haiku":{"inputTokens":3571,"outputTokens":26,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.003701,"canonicalModel":"claude-haiku-4-5","provider":"firstParty"}}}',
    '{"type":"result","subtype":"success","session_id":"session-1","origin":{"kind":"task-notification"},"usage":{"input_tokens":888888},"total_cost_usd":88,"modelUsage":{"haiku":{"inputTokens":3571,"outputTokens":26,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.003701,"canonicalModel":"claude-haiku-4-5","provider":"firstParty"},"sonnet":{"inputTokens":160,"outputTokens":55516,"cacheReadInputTokens":4366909,"cacheCreationInputTokens":177306,"costUSD":2.9725482000000008,"canonicalModel":"claude-sonnet-5","provider":"firstParty"}}}',
  );
  const input = {
    provider: 'claude',
    dialect: 'claude-code-jsonl-2.1.220',
    rawText,
    run: { ...RUN, providerSessionMode: 'fresh' },
  };

  const result = normalizeProviderUsage(input);
  assert.equal(result.completeness, 'complete');
  assert.deepEqual(result.providerRootResult, {
    sourceOrdinal: '2', subtype: 'success', isError: null,
  });
  assert.deepEqual(result.providerReportedCost, {
    currency: 'USD',
    amount: '2.9762492000000008',
    semantics: 'run_total',
    breakdown: [
      { model: 'claude-haiku-4-5', rawModel: 'haiku', amount: '0.003701' },
      { model: 'claude-sonnet-5', rawModel: 'sonnet', amount: '2.9725482000000008' },
    ],
  });
  assert.deepEqual(result.tokenSummary, {
    uncachedInput: '3731',
    output: '55542',
    cacheRead: '4366909',
    cacheWrite5m: '0',
    cacheWrite1h: '0',
    cacheWriteUnknown: '177306',
  });
  assert.equal(result.usageSegments.length, 6);
  assert.ok(result.usageSegments.some((segment) => segment.metric === 'input_tokens'));
  assert.ok(result.usageSegments.every((segment) => (
    segment.attributes.billingProduct === 'messages'
  )));
  assert.deepEqual(normalizeProviderUsage(input), result);
});

test('Claude empty modelUsage с local zero означает missing, не measured zero', () => {
  const result = normalizeProviderUsage({
    provider: 'claude',
    dialect: 'claude-code-jsonl-2.1.220',
    rawText: lines(
      '{"type":"system","subtype":"init","session_id":"session-1","claude_code_version":"2.1.220"}',
      '{"type":"result","subtype":"error","is_error":true,"session_id":"session-1","total_cost_usd":0,"modelUsage":{}}',
    ),
    run: { ...RUN, providerSessionMode: 'fresh' },
  });

  assert.equal(result.completeness, 'missing');
  assert.equal(result.providerReportedCost, null);
  assert.equal(result.usageSegments.length, 0);
  assert.ok(result.diagnostics.includes('emptyModelUsage'));
});

test('Claude missing/invalid model cost не уничтожает exact usage и не создаёт run_total', () => {
  for (const [costFragment, diagnostic] of [
    ['', 'modelCostMissing'],
    [',"costUSD":-1', 'modelCostInvalid'],
  ]) {
    const result = normalizeProviderUsage({
      provider: 'claude',
      dialect: 'claude-code-jsonl-2.1.220',
      rawText: lines(
        '{"type":"system","subtype":"init","session_id":"session-1","claude_code_version":"2.1.220"}',
        `{"type":"result","subtype":"success","session_id":"session-1","modelUsage":{"sonnet":{"inputTokens":5,"outputTokens":2,"cacheReadInputTokens":1,"cacheCreationInputTokens":0${costFragment},"canonicalModel":"claude-sonnet-5","provider":"firstParty"}}}`,
      ),
      run: { ...RUN, providerSessionMode: 'fresh' },
    });
    assert.equal(result.completeness, 'complete');
    assert.equal(result.providerReportedCost, null);
    assert.deepEqual(result.tokenSummary, {
      uncachedInput: '5', output: '2', cacheRead: '1',
      cacheWrite5m: '0', cacheWrite1h: '0', cacheWriteUnknown: '0',
    });
    assert.ok(result.diagnostics.includes(diagnostic));
  }
});

test('Claude reported cost определяется terminal snapshot, а не дефектом раннего snapshot', () => {
  const result = normalizeProviderUsage({
    provider: 'claude', dialect: 'claude-code-jsonl-2.1.220',
    rawText: lines(
      '{"type":"system","subtype":"init","session_id":"session-1","claude_code_version":"2.1.220"}',
      '{"type":"result","subtype":"success","session_id":"session-1","modelUsage":{"sonnet":{"inputTokens":2,"outputTokens":1,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"canonicalModel":"claude-sonnet-5","provider":"firstParty"}}}',
      '{"type":"result","subtype":"success","session_id":"session-1","origin":{"kind":"task-notification"},"modelUsage":{"sonnet":{"inputTokens":5,"outputTokens":3,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.125,"canonicalModel":"claude-sonnet-5","provider":"firstParty"}}}',
    ),
    run: { ...RUN, providerSessionMode: 'fresh' },
  });
  assert.equal(result.completeness, 'complete');
  assert.equal(result.providerReportedCost.amount, '0.125');
  assert.ok(result.diagnostics.includes('modelCostMissing'));
});

test('Claude cumulative model map запрещает disappearance, decrease и alias collision', () => {
  const prefix = '{"type":"system","subtype":"init","session_id":"session-1","claude_code_version":"2.1.220"}';
  const entry = (models) => JSON.stringify({
    type: 'result', subtype: 'success', session_id: 'session-1', modelUsage: models,
  });
  const model = (overrides = {}) => ({
    inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 1,
    cacheCreationInputTokens: 0, costUSD: 0.1,
    canonicalModel: 'claude-sonnet-5', provider: 'firstParty', ...overrides,
  });
  const vectors = [
    [entry({ sonnet: model() }), entry({})],
    [entry({ sonnet: model() }), entry({ sonnet: model({ outputTokens: 1 }) })],
    [entry({ sonnet: model(), alias: model() })],
  ];
  for (const rows of vectors) {
    const result = normalizeProviderUsage({
      provider: 'claude', dialect: 'claude-code-jsonl-2.1.220',
      rawText: lines(prefix, ...rows),
      run: { ...RUN, providerSessionMode: 'fresh' },
    });
    assert.equal(result.completeness, 'conflict');
    assert.equal(result.providerReportedCost, null);
    assert.equal(result.usageSegments.length, 0);
    assert.ok(result.diagnostics.some((code) => (
      code === 'modelUsageConflict' || code === 'modelAliasCollision'
    )));
  }
});

test('Claude assistant requests дедуплицируются и дают exact 5m/1h decomposition', () => {
  const assistant = (requestId, messageId, input, output, read, creation, five, one) => JSON.stringify({
    type: 'assistant', session_id: 'session-1', request_id: requestId,
    message: {
      id: messageId, model: 'claude-sonnet-5',
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: creation,
        cache_creation: {
          ephemeral_5m_input_tokens: five,
          ephemeral_1h_input_tokens: one,
        },
        service_tier: 'standard', inference_geo: 'us',
      },
    },
    timestamp: '2026-08-19T10:01:00.000Z',
  });
  const rawText = lines(
    '{"type":"system","subtype":"init","session_id":"session-1","claude_code_version":"2.1.220"}',
    assistant('request-1', 'message-1', 2, 1, 3, 5, 2, 3),
    assistant('request-1', 'message-1', 2, 1, 3, 5, 2, 3),
    assistant('request-2', 'message-2', 3, 2, 4, 6, 1, 5),
    '{"type":"result","subtype":"success","session_id":"session-1","modelUsage":{"sonnet":{"inputTokens":5,"outputTokens":3,"cacheReadInputTokens":7,"cacheCreationInputTokens":11,"costUSD":0.1,"canonicalModel":"claude-sonnet-5","provider":"firstParty"}}}',
  );
  const result = normalizeProviderUsage({
    provider: 'claude', dialect: 'claude-code-jsonl-2.1.220', rawText,
    run: { ...RUN, providerSessionMode: 'fresh' },
  });

  assert.equal(result.completeness, 'complete');
  assert.deepEqual(result.tokenSummary, {
    uncachedInput: '5', output: '3', cacheRead: '7',
    cacheWrite5m: '3', cacheWrite1h: '8', cacheWriteUnknown: '0',
  });
  assert.equal(result.usageSegments.length, 10);
  assert.equal(
    result.usageSegments.filter((item) => item.attributes.cacheTtl === '5m').length,
    2,
  );
  assert.equal(
    result.usageSegments.filter((item) => item.attributes.cacheTtl === '1h').length,
    2,
  );
  assert.equal(result.diagnostics.includes('assistantReconciliationMismatch'), false);
});

test('Claude request identity: monotonic replacement, distinct equal rows и missing IDs', () => {
  const assistant = (requestId, messageId, input) => JSON.stringify({
    type: 'assistant', session_id: 'session-1', request_id: requestId,
    message: {
      id: messageId, model: 'claude-sonnet-5',
      usage: {
        input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0,
        },
      },
    },
  });
  const result = normalizeProviderUsage({
    provider: 'claude', dialect: 'claude-code-jsonl-2.1.220',
    rawText: lines(
      '{"type":"system","subtype":"init","session_id":"session-1","claude_code_version":"2.1.220"}',
      assistant('request-1', 'message-1', 1),
      assistant('request-1', 'message-1', 3),
      assistant('request-2', 'message-2', 3),
      '{"type":"assistant","session_id":"session-1","message":{"model":"claude-sonnet-5","usage":{"input_tokens":999,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}',
      '{"type":"result","subtype":"success","session_id":"session-1","modelUsage":{"sonnet":{"inputTokens":6,"outputTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.1,"canonicalModel":"claude-sonnet-5","provider":"firstParty"}}}',
    ),
    run: { ...RUN, providerSessionMode: 'fresh' },
  });
  assert.equal(result.completeness, 'complete');
  assert.equal(result.tokenSummary.uncachedInput, '6');
  assert.deepEqual(
    result.usageSegments.filter((segment) => segment.metric === 'input_tokens')
      .map((segment) => segment.quantity).sort(),
    ['3', '3'],
  );
  assert.ok(result.diagnostics.includes('assistantIdentityMissing'));
  assert.equal(JSON.stringify(result).includes('999'), false);
});

test('Claude fallback message identity не может стать вторым request и удвоить lower-bound', () => {
  const assistant = (requestId) => JSON.stringify({
    type: 'assistant', session_id: 'session-1',
    ...(requestId === null ? {} : { request_id: requestId }),
    message: {
      id: 'message-shared', model: 'claude-sonnet-5',
      usage: {
        input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0,
        },
      },
    },
  });
  const result = normalizeProviderUsage({
    provider: 'claude', dialect: 'claude-code-jsonl-2.1.220',
    rawText: lines(
      '{"type":"system","subtype":"init","session_id":"session-1","claude_code_version":"2.1.220"}',
      assistant(null),
      assistant('request-late'),
    ),
    run: { ...RUN, providerSessionMode: 'fresh' },
  });
  assert.equal(result.completeness, 'conflict');
  assert.equal(result.usageSegments.length, 0);
  assert.ok(result.diagnostics.includes('assistantRequestConflict'));
});

test('Claude поздняя chargeable/unsupported activity не повышает ранний modelUsage до final', () => {
  const prefix = [
    '{"type":"system","subtype":"init","session_id":"session-1","claude_code_version":"2.1.220"}',
    '{"type":"result","subtype":"success","session_id":"session-1","modelUsage":{"sonnet":{"inputTokens":5,"outputTokens":1,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.1,"canonicalModel":"claude-sonnet-5","provider":"firstParty"}}}',
  ];
  const lateRows = [
    '{"type":"assistant","session_id":"session-1","request_id":"late-request","message":{"id":"late-message","model":"claude-sonnet-5","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}',
    '{"type":"result","subtype":"success","session_id":"session-1","origin":{"kind":"future-charge"}}',
  ];
  for (const late of lateRows) {
    const result = normalizeProviderUsage({
      provider: 'claude', dialect: 'claude-code-jsonl-2.1.220',
      rawText: lines(...prefix, late),
      run: { ...RUN, providerSessionMode: 'fresh' },
    });
    assert.equal(result.completeness, 'partial');
    assert.equal(result.providerReportedCost, null);
    assert.ok(result.diagnostics.includes('terminalModelUsageUnproven'));
  }
});

test('Claude assistant mismatch портит только decomposition metric, не final total', () => {
  const result = normalizeProviderUsage({
    provider: 'claude', dialect: 'claude-code-jsonl-2.1.220',
    rawText: lines(
      '{"type":"system","subtype":"init","session_id":"session-1","claude_code_version":"2.1.220"}',
      '{"type":"assistant","session_id":"session-1","request_id":"r1","message":{"id":"m1","model":"claude-sonnet-5","usage":{"input_tokens":5,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}',
      '{"type":"result","subtype":"success","session_id":"session-1","modelUsage":{"sonnet":{"inputTokens":5,"outputTokens":3,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.1,"canonicalModel":"claude-sonnet-5","provider":"firstParty"}}}',
    ),
    run: { ...RUN, providerSessionMode: 'fresh' },
  });
  const outputs = result.usageSegments.filter((item) => item.metric === 'output_tokens');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].quantity, '3');
  assert.equal(outputs[0].completeness, 'partial');
  assert.equal(result.tokenSummary.output, '3');
  assert.ok(result.diagnostics.includes('assistantReconciliationMismatch'));
});

test('Claude без modelUsage сохраняет assistant lower-bound как partial без reported cost', () => {
  const result = normalizeProviderUsage({
    provider: 'claude', dialect: 'claude-code-jsonl-2.1.220',
    rawText: lines(
      '{"type":"system","subtype":"init","session_id":"session-1","claude_code_version":"2.1.220"}',
      '{"type":"assistant","session_id":"session-1","request_id":"r1","message":{"id":"m1","model":"claude-sonnet-5","usage":{"input_tokens":5,"output_tokens":2,"cache_read_input_tokens":1,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}',
      '{"type":"result","subtype":"success","session_id":"session-1","usage":{"input_tokens":999},"total_cost_usd":0}',
    ),
    run: { ...RUN, providerSessionMode: 'fresh' },
  });
  assert.equal(result.completeness, 'partial');
  assert.deepEqual(result.tokenSummary, {
    uncachedInput: '5', output: '2', cacheRead: '1',
    cacheWrite5m: '0', cacheWrite1h: '0', cacheWriteUnknown: '0',
  });
  assert.equal(result.providerReportedCost, null);
  assert.ok(result.diagnostics.includes('assistantLowerBoundOnly'));
});

test('unknown dialect не включает эвристический extractor', () => {
  const result = normalizeProviderUsage({
    provider: 'claude',
    dialect: 'claude-code-jsonl-future',
    rawText: lines('{"type":"result","modelUsage":{"x":{"inputTokens":1}}}'),
    run: { ...RUN, providerSessionMode: 'fresh' },
  });
  assert.equal(result.completeness, 'missing');
  assert.deepEqual(result.diagnostics, ['unsupportedDialect']);
});
