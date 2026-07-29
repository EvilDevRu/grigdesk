import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRemarkIdentity, createRemarkVersion } from '../../server/src/lib/reviews/identity.js';
import { ReviewStore } from '../../server/src/lib/reviews/store.js';
import {
  createTranslatorRequest,
  ReviewTranslatorQueue,
  TRANSLATION_RECOMMENDATIONS,
  TRANSLATION_SECTION_LABELS,
  validateTranslationResult,
} from '../../server/src/lib/reviews/translator.js';

function artifact() {
  return {
    analysisId: 'analysis:v1:fixture',
    schemaRevision: 1,
    promptRevision: 'review-analyze-v1',
    itemKey: 'remark:v1:fixture',
    versionId: 'remark-version:v1:fixture',
    headSha: 'a'.repeat(40),
    decisionId: 'PRODUCT_DECISION',
    confidenceId: 'MEDIUM',
    reviewerRequest: 'Выбрать совместимое поведение.',
    summary: 'Оба варианта технически допустимы.',
    expectedChange: 'Изменится обработка пустого значения.',
    verification: 'Проверить оба режима.',
    evidence: [{
      id: 'evidence:two-options',
      text: 'Контракт не определяет один вариант.',
      sourceRefs: ['src/value.js:12'],
    }],
    risks: [{
      id: 'risk:compatibility',
      text: 'Старые клиенты могут ожидать прежнее поведение.',
      severity: 'high',
    }],
    evidenceIds: ['evidence:two-options'],
    riskIds: ['risk:compatibility'],
    rawComment: 'SECRET RAW COMMENT',
    diff: 'SECRET DIFF',
    sourceSnapshot: { secret: 'SECRET CODE' },
    chainOfThought: 'SECRET THOUGHTS',
  };
}

function section(text, evidenceIds = [], riskIds = []) {
  return { text, evidenceIds, riskIds };
}

function translationResult(overrides = {}) {
  return {
    decisionId: 'PRODUCT_DECISION',
    confidenceId: 'MEDIUM',
    evidenceIds: ['evidence:two-options'],
    riskIds: ['risk:compatibility'],
    sections: {
      reviewerRequest: section('Ревьюер просит выбрать один из двух вариантов.', ['evidence:two-options']),
      recommendation: section('Сначала нужно твоё решение', ['evidence:two-options']),
      reason: section('Технически подходят оба варианта.', ['evidence:two-options']),
      expectedChange: section('После выбора изменится обработка пустого значения.', ['evidence:two-options']),
      risks: section('Можно нарушить совместимость со старыми клиентами.', [], ['risk:compatibility']),
      decisionNeeded: section('Выбери, сохранять ли старое поведение.', ['evidence:two-options'], ['risk:compatibility']),
    },
    ...overrides,
  };
}

function remark(commentNodeId = 'C_1', body = 'Как должно вести себя пустое значение?', {
  updatedAt = '2026-07-29T10:00:00.000Z',
} = {}) {
  const identity = createRemarkIdentity({
    repoNodeId: 'R_repo',
    prNodeId: 'PR_1',
    kind: 'issue_comment',
    commentNodeId,
  });
  const version = createRemarkVersion({
    ...identity,
    headSha: 'a'.repeat(40),
    state: 'open',
    updatedAt,
    body,
  });
  return { ...identity, ...version, body };
}

function snapshot(remarks = [remark()]) {
  return {
    repoNodeId: 'R_repo',
    nameWithOwner: 'example/repo',
    pullRequests: [{
      prNodeId: 'PR_1',
      number: 1,
      state: 'open',
      headSha: 'a'.repeat(40),
      updatedAt: '2026-07-29T10:00:00.000Z',
      remarks,
    }],
  };
}

function artifactFor(item, overrides = {}) {
  return {
    ...artifact(),
    itemKey: item.key,
    versionId: item.versionId,
    headSha: 'a'.repeat(40),
    ...overrides,
  };
}

test('TRANSLATE-01 RB-06: request содержит только allowlist технического артефакта', () => {
  const request = createTranslatorRequest(artifact());
  const serialized = JSON.stringify(request);

  assert.equal(serialized.includes('SECRET RAW COMMENT'), false);
  assert.equal(serialized.includes('SECRET DIFF'), false);
  assert.equal(serialized.includes('SECRET CODE'), false);
  assert.equal(serialized.includes('SECRET THOUGHTS'), false);
  assert.equal(request.analysis.decisionId, 'PRODUCT_DECISION');
  assert.deepEqual(Object.keys(request.analysis).sort(), [
    'confidenceId',
    'decisionId',
    'evidence',
    'evidenceIds',
    'expectedChange',
    'reviewerRequest',
    'riskIds',
    'risks',
    'summary',
    'verification',
  ]);
});

test('TRANSLATE-02: контракт содержит шесть полей человеческой карточки', () => {
  const valid = validateTranslationResult(translationResult(), artifact());
  assert.deepEqual(
    Object.keys(valid.sections),
    Object.keys(TRANSLATION_SECTION_LABELS),
  );
  assert.deepEqual(Object.values(TRANSLATION_SECTION_LABELS), [
    'Что просит ревьюер',
    'Стоит ли делать',
    'Почему',
    'Что изменится',
    'Какие есть риски',
    'Что нужно решить тебе',
  ]);
});

test('TRANSLATE-03 TRANSLATE-04: перевод не меняет решение, уверенность и набор ID', () => {
  assert.throws(
    () => validateTranslationResult(translationResult({ decisionId: 'FIX_RECOMMENDED' }), artifact()),
    /decisionId/,
  );
  assert.throws(
    () => validateTranslationResult(translationResult({ confidenceId: 'HIGH' }), artifact()),
    /confidenceId/,
  );
  assert.throws(
    () => validateTranslationResult(translationResult({ evidenceIds: [] }), artifact()),
    /evidenceIds/,
  );
  const unknown = translationResult();
  unknown.sections.reason.evidenceIds = ['evidence:invented'];
  assert.throws(() => validateTranslationResult(unknown, artifact()), /неизвестный ID/);
});

test('TRANSLATE-05: UI-рекомендация детерминированно следует decisionId', () => {
  for (const [decisionId, recommendation] of Object.entries(TRANSLATION_RECOMMENDATIONS)) {
    const technical = { ...artifact(), decisionId };
    const translated = translationResult({
      decisionId,
      sections: {
        ...translationResult().sections,
        recommendation: section(recommendation, ['evidence:two-options']),
      },
    });
    const valid = validateTranslationResult(translated, technical);
    assert.equal(valid.sections.recommendation.text, recommendation);
  }

  const technical = { ...artifact(), decisionId: 'FIX_RECOMMENDED' };
  const inverted = translationResult({
    decisionId: 'FIX_RECOMMENDED',
    sections: {
      ...translationResult().sections,
      recommendation: section('Не стоит исправлять', ['evidence:two-options']),
    },
  });
  assert.throws(
    () => validateTranslationResult(inverted, technical),
    /точно соответствовать decisionId/,
  );
});

test('TRANSLATE-05: factual sections обязаны ссылаться на переданные evidence/risk ID', () => {
  for (const key of ['reviewerRequest', 'reason', 'expectedChange', 'decisionNeeded']) {
    const withoutEvidence = translationResult();
    withoutEvidence.sections[key] = {
      ...withoutEvidence.sections[key],
      evidenceIds: [],
    };
    assert.throws(
      () => validateTranslationResult(withoutEvidence, artifact()),
      /обязан ссылаться на evidence ID/,
    );
  }
  const withoutRisk = translationResult();
  withoutRisk.sections.risks = {
    ...withoutRisk.sections.risks,
    riskIds: [],
  };
  assert.throws(
    () => validateTranslationResult(withoutRisk, artifact()),
    /обязан ссылаться на risk ID/,
  );
});

test('TRANSLATE-06 TRANSLATE-07: невалидный перевод не заменяет текущую карточку', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-translation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStore({ stateDir: root });
  const current = snapshot();
  await store.applyRepositorySnapshot(current);
  const item = current.pullRequests[0].remarks[0];
  const currentArtifact = {
    ...artifact(),
    itemKey: item.key,
    versionId: item.versionId,
    headSha: current.pullRequests[0].headSha,
  };
  await store.compareAndSetAnalysis({
    itemKey: item.key,
    versionId: item.versionId,
    headSha: current.pullRequests[0].headSha,
    artifact: currentArtifact,
  });
  const queue = new ReviewTranslatorQueue({
    store,
    model: {
      async generate({ stage, input }) {
        assert.equal(stage, 'TRANSLATOR');
        assert.equal(JSON.stringify(input).includes(item.body), false);
        return { ...translationResult(), confidenceId: 'HIGH' };
      },
    },
  });
  await queue.enqueue({ artifacts: [currentArtifact] });

  assert.equal((await queue.runNext()).status, 'failed');
  const state = await store.read();
  assert.equal(state.translations[item.key].current, null);
  assert.equal(state.analyses[item.key].current.analysisId, currentArtifact.analysisId);
});

test('TRANSLATE-07: успешный перевод меняет только представление', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-translation-ok-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStore({ stateDir: root });
  const current = snapshot();
  await store.applyRepositorySnapshot(current);
  const item = current.pullRequests[0].remarks[0];
  const currentArtifact = {
    ...artifact(),
    itemKey: item.key,
    versionId: item.versionId,
    headSha: current.pullRequests[0].headSha,
  };
  await store.compareAndSetAnalysis({
    itemKey: item.key,
    versionId: item.versionId,
    headSha: current.pullRequests[0].headSha,
    artifact: currentArtifact,
  });
  const before = JSON.stringify((await store.read()).analyses[item.key].current);
  const queue = new ReviewTranslatorQueue({
    store,
    model: { generate: async () => translationResult() },
  });
  await queue.enqueue({ artifacts: [currentArtifact] });

  assert.equal((await queue.runNext()).status, 'completed');
  const state = await store.read();
  assert.equal(JSON.stringify(state.analyses[item.key].current), before);
  assert.match(state.translations[item.key].current.translationId, /^translation:v1:/);
  assert.equal(await queue.runNext(), null, 'готовый exact перевод не ставится повторно');
  assert.equal(Object.keys((await store.read()).jobs).length, 1);
});

test('TRANSLATE-08: reconciler закрывает crash-gap после durable analysis CAS', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-translation-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStore({ stateDir: root });
  const current = snapshot();
  const item = current.pullRequests[0].remarks[0];
  const currentArtifact = artifactFor(item);
  await store.applyRepositorySnapshot(current);

  // Имитируем падение процесса ровно после analysis CAS: артефакт уже durable,
  // а translation job ещё не существует.
  await store.compareAndSetAnalysis({
    itemKey: item.key,
    versionId: item.versionId,
    headSha: current.pullRequests[0].headSha,
    artifact: currentArtifact,
  });
  assert.equal(Object.keys((await store.read()).jobs).length, 0);

  const queue = new ReviewTranslatorQueue({
    store,
    model: { generate: async () => translationResult() },
  });
  const outcome = await queue.runNext();
  const state = await store.read();

  assert.equal(outcome.status, 'completed');
  assert.equal(state.translations[item.key].current.analysisId, currentArtifact.analysisId);
  assert.deepEqual(state.jobs[outcome.jobId].payload.itemVersions, [{
    itemKey: item.key,
    versionId: item.versionId,
    analysisId: currentArtifact.analysisId,
  }]);
});

test('TRANSLATE-08: stale item отменённого batch не оставляет соседа без перевода', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-translation-batch-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStore({ stateDir: root });
  const first = remark('C_1', 'Первая версия');
  const second = remark('C_2', 'Неизменный сосед');
  const initial = snapshot([first, second]);
  const firstArtifact = artifactFor(first, { analysisId: 'analysis:v1:first' });
  const secondArtifact = artifactFor(second, { analysisId: 'analysis:v1:second' });
  await store.applyRepositorySnapshot(initial);
  await store.compareAndSetAnalysisBatch([
    {
      itemKey: first.key,
      versionId: first.versionId,
      headSha: initial.pullRequests[0].headSha,
      artifact: firstArtifact,
    },
    {
      itemKey: second.key,
      versionId: second.versionId,
      headSha: initial.pullRequests[0].headSha,
      artifact: secondArtifact,
    },
  ]);
  const queue = new ReviewTranslatorQueue({
    store,
    model: { generate: async () => translationResult() },
  });
  const batch = await queue.enqueue({ artifacts: [firstArtifact, secondArtifact] });

  const changedFirst = remark('C_1', 'Новая версия', {
    updatedAt: '2026-07-29T10:01:00.000Z',
  });
  await store.applyRepositorySnapshot(snapshot([changedFirst, second]));
  assert.equal((await store.read()).jobs[batch.job.id].status, 'cancelled');

  const outcome = await queue.runNext();
  const state = await store.read();

  assert.equal(outcome.status, 'completed');
  assert.equal(state.translations[first.key], undefined);
  assert.equal(state.translations[second.key].current.analysisId, secondArtifact.analysisId);
  assert.deepEqual(state.jobs[outcome.jobId].payload.itemVersions, [{
    itemKey: second.key,
    versionId: second.versionId,
    analysisId: secondArtifact.analysisId,
  }]);
});

test('TRANSLATE-08: terminal failed item/version не зацикливает auto-recovery', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-translation-terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStore({ stateDir: root });
  const current = snapshot();
  const item = current.pullRequests[0].remarks[0];
  const currentArtifact = artifactFor(item);
  await store.applyRepositorySnapshot(current);
  await store.compareAndSetAnalysis({
    itemKey: item.key,
    versionId: item.versionId,
    headSha: current.pullRequests[0].headSha,
    artifact: currentArtifact,
  });
  const queue = new ReviewTranslatorQueue({
    store,
    model: { generate: async () => {
      throw new Error('Модель не должна автоматически перезапускаться');
    } },
  });
  const enqueued = await queue.enqueue({ artifacts: [currentArtifact] });
  const claimed = await store.claimJob({
    queue: 'translation',
    workerId: 'terminal-fixture',
  });
  await store.failJob({
    jobId: claimed.id,
    workerId: 'terminal-fixture',
    fencingToken: claimed.fencingToken,
    error: { code: 'TRANSLATION_FAILED', message: 'terminal' },
    retryable: false,
  });

  assert.equal(await queue.runNext(), null);
  const state = await store.read();
  assert.equal(Object.keys(state.jobs).length, 1);
  assert.equal(state.jobs[enqueued.job.id].status, 'failed');
  assert.equal(state.translations[item.key], undefined);
});

test('TRANSLATE-08: terminal failure старого analysis не блокирует recovery ручного повтора', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-translation-retry-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStore({ stateDir: root });
  const current = snapshot();
  const item = current.pullRequests[0].remarks[0];
  const oldArtifact = artifactFor(item, { analysisId: 'analysis:v1:old' });
  const freshArtifact = artifactFor(item, { analysisId: 'analysis:v1:fresh' });
  await store.applyRepositorySnapshot(current);
  await store.compareAndSetAnalysis({
    itemKey: item.key,
    versionId: item.versionId,
    headSha: current.pullRequests[0].headSha,
    artifact: oldArtifact,
  });
  const queue = new ReviewTranslatorQueue({
    store,
    model: { generate: async () => translationResult() },
  });
  await queue.enqueue({ artifacts: [oldArtifact] });
  const claimed = await store.claimJob({
    queue: 'translation',
    workerId: 'terminal-old-analysis',
  });
  await store.failJob({
    jobId: claimed.id,
    workerId: 'terminal-old-analysis',
    fencingToken: claimed.fencingToken,
    error: { code: 'TRANSLATION_FAILED', message: 'terminal' },
    retryable: false,
  });
  await store.compareAndSetAnalysis({
    itemKey: item.key,
    versionId: item.versionId,
    headSha: current.pullRequests[0].headSha,
    artifact: freshArtifact,
  });

  const outcome = await queue.runNext();
  const state = await store.read();

  assert.equal(outcome.status, 'completed');
  assert.equal(state.translations[item.key].current.analysisId, freshArtifact.analysisId);
});
