// Проверяет сборку, схему и атомарную публикацию документов потребления раннеров.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeProviderUsage } from '../../server/src/lib/analytics/normalizers.js';
import {
  AnalyticsUsageDocumentError,
  buildUsageDocument,
  encodeUsageDocument,
  publishUsageDocument,
} from '../../server/src/lib/analytics/usage-document.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Ajv2020 = requireFromServer('ajv/dist/2020').default;

const identity = Object.freeze({
  taskId: 't42',
  attemptId: 'a_0123456789abcdef0123456789abcdef',
  nodeVisitId: 'nv_0123456789abcdef0123456789abcdef',
  nodeExecutionId: 'ne_0123456789abcdef0123456789abcdef',
  dispatchId: 'd_0123456789abcdef0123456789abcdef',
  runId: 'run-test-1',
  epoch: 1,
});

const run = Object.freeze({
  ...identity,
  providerSessionMode: 'fresh',
  providerScopeUnique: true,
  processComplete: true,
  startedAt: '2026-08-19T10:00:00.000Z',
  finishedAt: '2026-08-19T10:05:00.000Z',
  lifecycleEventHash: 'a'.repeat(64),
});

const normalization = normalizeProviderUsage({
  provider: 'codex',
  dialect: 'codex-jsonl-v1',
  rawText: [
    '{"type":"thread.started","thread_id":"thread-1"}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"cache_write_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":1}}',
    '',
  ].join('\n'),
  run,
});

const sourceFingerprint = Object.freeze({
  dev: '2049',
  ino: '123456',
  size: '321',
  mtimeNs: '1787123456789000000',
  sha256: 'b'.repeat(64),
  finalFstatHash: 'c'.repeat(64),
  rawFsyncCompleted: true,
});

function document(overrides = {}) {
  return buildUsageDocument({
    identity,
    provider: 'codex',
    requestedModel: 'gpt-5.6-codex',
    resolvedModel: 'gpt-5.6-codex',
    observedAt: '2026-08-19T10:05:00.000Z',
    sourceFingerprint,
    providerSessionMode: 'fresh',
    requestedProviderScope: null,
    observedProviderScope: null,
    parentUsageRef: null,
    normalization,
    ...overrides,
  });
}

test('usage document фиксирует identity/source/normalizer и кодируется byte-stable', () => {
  const first = document();
  const second = document();

  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.source, 'provider_final');
  assert.equal(first.completeness, 'complete');
  assert.equal(first.resumeEligible, true);
  assert.equal(first.usageSegments.length, 3);
  assert.equal(first.sourceFingerprint.rawFsyncCompleted, true);
  assert.deepEqual(encodeUsageDocument(first), encodeUsageDocument(second));
  assert.equal(encodeUsageDocument(first).at(-1), 0x0a);
});

test('usage document проходит общую strict JSON Schema 2020-12', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../../schemas/analytics/usage-document.schema.json', import.meta.url),
    'utf8',
  ));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  assert.equal(validate(document()), true, JSON.stringify(validate.errors));
});

test('usage document fail-closed проверяет fingerprint, quantities и segment cap', () => {
  assert.throws(
    () => document({ sourceFingerprint: { ...sourceFingerprint, dev: '01' } }),
    AnalyticsUsageDocumentError,
  );
  const invalidQuantity = structuredClone(normalization);
  invalidQuantity.usageSegments[0].quantity = '1.0';
  assert.throws(
    () => document({ normalization: invalidQuantity }),
    /quantity/i,
  );
  const tooMany = structuredClone(normalization);
  tooMany.usageSegments = Array.from({ length: 10_001 }, () => normalization.usageSegments[0]);
  assert.throws(
    () => document({ normalization: tooMany }),
    /10 000/i,
  );
});

test('publish usage document настоящий no-replace: published/idempotent/conflict', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-usage-doc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'lifecycle', 'usage');
  const first = document();

  const published = await publishUsageDocument({ directory, document: first });
  assert.equal(published.outcome, 'published');
  assert.equal(published.documentHash, published.sha256);
  assert.deepEqual(
    await readFile(path.join(directory, `${identity.runId}.json`)),
    encodeUsageDocument(first),
  );

  const repeated = await publishUsageDocument({ directory, document: document() });
  assert.equal(repeated.outcome, 'idempotent');

  await assert.rejects(
    publishUsageDocument({
      directory,
      document: document({ resolvedModel: 'different-model' }),
    }),
    (error) => error.code === 'immutableConflict',
  );
});
