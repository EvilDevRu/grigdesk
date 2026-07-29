import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ANALYSIS_SCHEMA_REVISION,
  createAnalysisRequest,
  ReviewAnalysisQueue,
  validateAnalysisResult,
} from '../../server/src/lib/reviews/analyzer.js';
import { createRemarkIdentity, createRemarkVersion } from '../../server/src/lib/reviews/identity.js';
import { ReviewStore } from '../../server/src/lib/reviews/store.js';

function analysisResult(overrides = {}) {
  return {
    decisionId: 'FIX_RECOMMENDED',
    confidenceId: 'HIGH',
    reviewerRequest: 'Обработать пустое значение.',
    summary: 'Проверка отсутствует в текущем diff.',
    expectedChange: 'Пустое значение будет отклонено.',
    verification: 'Добавить unit-тест.',
    evidence: [{
      id: 'evidence:missing-check',
      text: 'В изменённой функции нет проверки.',
      sourceRefs: ['src/value.js:12'],
    }],
    risks: [{
      id: 'risk:compatibility',
      text: 'Может измениться старое поведение.',
      severity: 'medium',
    }],
    evidenceIds: ['evidence:missing-check'],
    riskIds: ['risk:compatibility'],
    ...overrides,
  };
}

function snapshot(body = 'Добавьте проверку пустого значения') {
  const identity = createRemarkIdentity({
    repoNodeId: 'R_repo',
    prNodeId: 'PR_1',
    kind: 'thread_comment',
    threadNodeId: 'T_1',
    commentNodeId: 'C_1',
  });
  const version = createRemarkVersion({
    ...identity,
    headSha: 'a'.repeat(40),
    state: 'open',
    updatedAt: '2026-07-29T10:00:00.000Z',
    body,
  });
  return {
    repoNodeId: 'R_repo',
    nameWithOwner: 'example/repo',
    pullRequests: [{
      prNodeId: 'PR_1',
      number: 1,
      state: 'open',
      headSha: 'a'.repeat(40),
      updatedAt: '2026-07-29T10:00:00.000Z',
      remarks: [{ ...identity, ...version, body }],
    }],
  };
}

async function queueFixture(t, model) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-analysis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStore({ stateDir: root });
  const current = snapshot();
  await store.applyRepositorySnapshot(current);
  const translated = [];
  const queue = new ReviewAnalysisQueue({
    store,
    model,
    translatorQueue: { enqueue: async (value) => translated.push(value) },
    clock: () => Date.parse('2026-07-29T10:01:00.000Z'),
  });
  return { store, current, queue, translated };
}

test('ANALYZE-03 ANALYZE-04: строгая схема принимает enum и ссылки на стабильные ID', () => {
  const valid = validateAnalysisResult(analysisResult());
  assert.equal(valid.decisionId, 'FIX_RECOMMENDED');
  assert.equal(valid.confidenceId, 'HIGH');
  assert.deepEqual(valid.evidenceIds, ['evidence:missing-check']);
});

test('ANALYZE-05: неизвестные enum/ID, дубли и лишние поля отклоняются', () => {
  assert.throws(
    () => validateAnalysisResult(analysisResult({ decisionId: 'DO_WHATEVER' })),
    /decisionId/,
  );
  assert.throws(
    () => validateAnalysisResult(analysisResult({ evidenceIds: ['evidence:unknown'] })),
    /evidenceIds/,
  );
  assert.throws(
    () => validateAnalysisResult(analysisResult({
      evidence: [
        analysisResult().evidence[0],
        analysisResult().evidence[0],
      ],
    })),
    /дублируется/,
  );
  assert.throws(
    () => validateAnalysisResult({ ...analysisResult(), executableAction: 'git push' }),
    /лишнее поле/,
  );
});

test('ANALYZE-06: без доказательств разрешён только честный ответ UNCERTAIN', () => {
  assert.throws(() => validateAnalysisResult(analysisResult({
    evidence: [],
    evidenceIds: [],
  })), /UNCERTAIN/);
  assert.doesNotThrow(() => validateAnalysisResult(analysisResult({
    decisionId: 'UNCERTAIN',
    confidenceId: 'LOW',
    evidence: [],
    evidenceIds: [],
  })));
  assert.throws(() => validateAnalysisResult(analysisResult(), {
    requiresProductDecision: true,
  }), /PRODUCT_DECISION/);
});

test('ANALYZE-01 ANALYZE-02: request содержит полный untrusted input и точные ID/SHA', () => {
  const current = snapshot();
  const pullRequest = current.pullRequests[0];
  const item = pullRequest.remarks[0];
  const request = createAnalysisRequest({
    repoNodeId: current.repoNodeId,
    prNodeId: pullRequest.prNodeId,
    headSha: pullRequest.headSha,
    items: [item],
    diff: 'diff --git a/src/value.js b/src/value.js\n+return value',
    sourceSnapshot: {
      headSha: pullRequest.headSha,
      files: [{ path: 'src/value.js', content: 'export const value = input;' }],
      readOnly: true,
    },
  });

  assert.equal(request.schemaRevision, ANALYSIS_SCHEMA_REVISION);
  assert.equal(request.identity.headSha, 'a'.repeat(40));
  assert.equal(request.untrustedInput.items[0].body, item.body);
  assert.match(request.untrustedInput.diff, /diff --git/);
  assert.equal(request.untrustedInput.sourceSnapshot.readOnly, true);
});

test('ANALYZE-05: batch обязан вернуть каждый ожидаемый item ровно один раз', async (t) => {
  const { current, queue, store } = await queueFixture(t, {
    async generate({ input }) {
      return { items: [{
        itemKey: `${input.identity.itemVersions[0].itemKey}:other`,
        versionId: input.identity.itemVersions[0].versionId,
        result: analysisResult(),
      }] };
    },
  });
  const pullRequest = current.pullRequests[0];
  await queue.enqueue({
    repoNodeId: current.repoNodeId,
    prNodeId: pullRequest.prNodeId,
    headSha: pullRequest.headSha,
    items: pullRequest.remarks,
    diff: 'fixture diff',
    sourceSnapshot: { files: [], readOnly: true, headSha: pullRequest.headSha },
  });

  const outcome = await queue.runNext();
  assert.equal(outcome.status, 'failed');
  const record = (await store.read()).analyses[pullRequest.remarks[0].key];
  assert.equal(record.current, null);
  assert.equal(record.error.code, 'ANALYSIS_CONTRACT_INVALID');
});

test('ANALYZE-07: late model result проходит schema, но отклоняется CAS', async (t) => {
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const { current, queue, store, translated } = await queueFixture(t, {
    async generate() {
      return response;
    },
  });
  const pullRequest = current.pullRequests[0];
  await queue.enqueue({
    repoNodeId: current.repoNodeId,
    prNodeId: pullRequest.prNodeId,
    headSha: pullRequest.headSha,
    items: pullRequest.remarks,
    diff: 'fixture',
    sourceSnapshot: { files: [], readOnly: true, headSha: pullRequest.headSha },
  });
  const running = queue.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  await store.applyRepositorySnapshot(snapshot('Текст изменили во время анализа'));
  release({ items: [{
    itemKey: pullRequest.remarks[0].key,
    versionId: pullRequest.remarks[0].versionId,
    result: analysisResult(),
  }] });
  const outcome = await running;

  assert.equal(outcome.status, 'stale');
  assert.equal(translated.length, 0);
  assert.equal((await store.read()).analyses[pullRequest.remarks[0].key], undefined);
});

test('ANALYZE-08: успешный артефакт сохраняется и только затем ставится перевод', async (t) => {
  const { current, queue, store, translated } = await queueFixture(t, {
    async generate({ stage, input }) {
      assert.equal(stage, 'REVIEW_ANALYZE');
      return { items: [{
        itemKey: input.identity.itemVersions[0].itemKey,
        versionId: input.identity.itemVersions[0].versionId,
        result: analysisResult(),
      }] };
    },
  });
  const pullRequest = current.pullRequests[0];
  await queue.enqueue({
    repoNodeId: current.repoNodeId,
    prNodeId: pullRequest.prNodeId,
    headSha: pullRequest.headSha,
    items: pullRequest.remarks,
    diff: 'fixture',
    sourceSnapshot: { files: [], readOnly: true, headSha: pullRequest.headSha },
  });
  assert.equal((await queue.runNext()).status, 'completed');

  const artifact = (await store.read()).analyses[pullRequest.remarks[0].key].current;
  assert.match(artifact.analysisId, /^analysis:v1:/);
  assert.equal(artifact.versionId, pullRequest.remarks[0].versionId);
  assert.equal(translated.length, 1);
  assert.equal(translated[0].artifacts[0].analysisId, artifact.analysisId);
});

test('ANALYZE-08: сбой enqueue перевода после CAS не перезапускает готовый анализ', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-analysis-outbox-gap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStore({ stateDir: root });
  const current = snapshot();
  const pullRequest = current.pullRequests[0];
  const item = pullRequest.remarks[0];
  await store.applyRepositorySnapshot(current);
  const queue = new ReviewAnalysisQueue({
    store,
    model: {
      async generate() {
        return {
          items: [{
            itemKey: item.key,
            versionId: item.versionId,
            result: analysisResult(),
          }],
        };
      },
    },
    translatorQueue: {
      maxRetries: 3,
      async enqueue() {
        throw Object.assign(new Error('simulated crash gap'), {
          code: 'TRANSLATION_ENQUEUE_GAP',
        });
      },
    },
  });
  const enqueued = await queue.enqueue({
    repoNodeId: current.repoNodeId,
    prNodeId: pullRequest.prNodeId,
    headSha: pullRequest.headSha,
    items: [item],
    diff: 'fixture',
    sourceSnapshot: { files: [], readOnly: true, headSha: pullRequest.headSha },
  });

  const outcome = await queue.runNext();
  const state = await store.read();

  assert.equal(outcome.status, 'completed');
  assert.equal(state.jobs[enqueued.job.id].status, 'completed');
  assert.equal(state.jobs[enqueued.job.id].result.translationQueued, false);
  assert.match(state.analyses[item.key].current.analysisId, /^analysis:v1:/);
  assert.equal(state.analyses[item.key].error, null);
  assert.equal(
    Object.values(state.jobs).some((job) => job.queue === 'translation'),
    false,
  );
});

test('SEC-08: source snapshot отклоняет secret/traversal и лишние credential fields', () => {
  const current = snapshot();
  const pullRequest = current.pullRequests[0];
  const common = {
    repoNodeId: current.repoNodeId,
    prNodeId: pullRequest.prNodeId,
    headSha: pullRequest.headSha,
    items: pullRequest.remarks,
    diff: 'fixture',
  };
  assert.throws(() => createAnalysisRequest({
    ...common,
    sourceSnapshot: {
      readOnly: true,
      headSha: pullRequest.headSha,
      files: [{ path: '.env', content: 'TOKEN=secret' }],
    },
  }), /запрещённый path/);
  assert.throws(() => createAnalysisRequest({
    ...common,
    sourceSnapshot: {
      readOnly: true,
      headSha: pullRequest.headSha,
      files: [],
      credentials: 'secret',
    },
  }), /лишнее поле/);
});
