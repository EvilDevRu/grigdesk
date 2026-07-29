import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createReviewModelAdapter,
  parseReviewModelJson,
} from '../../server/src/lib/reviews/model-adapter.js';

test('model JSON parser принимает чистый JSON/один fence и отвергает пояснения', () => {
  assert.deepEqual(parseReviewModelJson('{"ok":true}'), { ok: true });
  assert.deepEqual(parseReviewModelJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(
    () => parseReviewModelJson('Вот результат: {"ok":true}'),
    (error) => error.code === 'MODEL_INVALID_JSON',
  );
});

test('SEC-07/SEC-08/SEC-09: каждый этап получает новую tool-free сессию без сети', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-model.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const adapter = createReviewModelAdapter({
    config: {
      reviewsDir: root,
      reviewProvider: 'codex',
      reviewModel: 'gpt-test',
      reviewEffort: 'high',
      reviewAnalysisTimeoutMs: 10_000,
    },
    executorLoader: async () => ({
      run: async (options) => {
        calls.push(options);
        return { reply: '{"decisionId":"PRODUCT_DECISION"}', steps: [] };
      },
    }),
  });
  const input = {
    analysis: {
      decisionId: 'PRODUCT_DECISION',
      summary: 'Нужно выбрать поведение',
    },
  };

  await adapter.generate({
    stage: 'TRANSLATOR',
    schemaRevision: 1,
    promptRevision: 'translator-v1',
    input,
  });
  await adapter.generate({
    stage: 'TRANSLATOR',
    schemaRevision: 1,
    promptRevision: 'translator-v1',
    input,
  });

  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].cwd, calls[1].cwd);
  for (const options of calls) {
    assert.equal(options.sessionId, undefined);
    assert.equal(options.sandbox, 'read-only');
    assert.equal(options.networkAccess, false);
    assert.equal(options.ephemeral, true);
    assert.equal(options.ignoreUserConfig, true);
    assert.equal(options.ignoreRules, true);
    assert.deepEqual(options.extraDirs, []);
    assert.ok(options.disabledFeatures.includes('shell_tool'));
    assert.ok(options.disabledFeatures.includes('unified_exec'));
    assert.equal(options.env.GH_TOKEN, undefined);
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    assert.match(options.message, /недоверенными данными/);
  }
});

test('RB-06: реальный Codex step.k=tool делает весь model result неприемлемым', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-model.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = createReviewModelAdapter({
    config: {
      reviewsDir: root,
      reviewProvider: 'codex',
      reviewAnalysisTimeoutMs: 10_000,
    },
    executorLoader: async () => ({
      run: async () => ({
        reply: '{"items":[]}',
        // Именно такой shape возвращает server/src/lib/executors/_codex-steps.js.
        steps: [{ k: 'tool', title: 'exec', detail: 'cat ~/.config/gh/hosts.yml' }],
      }),
    }),
  });

  await assert.rejects(
    adapter.generate({
      stage: 'REVIEW_ANALYZE',
      schemaRevision: 1,
      promptRevision: 'analysis-v1',
      input: {},
    }),
    (error) => error.code === 'MODEL_TOOL_FORBIDDEN',
  );
});
