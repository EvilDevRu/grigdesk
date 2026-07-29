// Контракт «Переводчика». В запрос намеренно не попадают raw comment, diff,
// исходники, секреты или внутренняя история модели — только allowlist уже
// проверенного технического артефакта.
import { randomUUID } from 'node:crypto';

import { CONFIDENCE_LEVELS, DECISIONS } from './analyzer.js';
import { sha256 } from './identity.js';

export const TRANSLATION_SCHEMA_REVISION = 1;
export const TRANSLATION_PROMPT_REVISION = 'review-translator-v1';

export const TRANSLATION_SECTION_LABELS = Object.freeze({
  reviewerRequest: 'Что просит ревьюер',
  recommendation: 'Стоит ли делать',
  reason: 'Почему',
  expectedChange: 'Что изменится',
  risks: 'Какие есть риски',
  decisionNeeded: 'Что нужно решить тебе',
});

export const TRANSLATION_RECOMMENDATIONS = Object.freeze({
  FIX_RECOMMENDED: 'Стоит исправить',
  DO_NOT_FIX: 'Не стоит исправлять',
  ALREADY_FIXED: 'Уже исправлено',
  REPLY_ONLY: 'Достаточно ответить',
  PRODUCT_DECISION: 'Сначала нужно твоё решение',
  UNCERTAIN: 'Пока нельзя уверенно решить',
});

const RESULT_FIELDS = new Set([
  'decisionId',
  'confidenceId',
  'evidenceIds',
  'riskIds',
  'sections',
]);
const SECTION_FIELDS = new Set(['text', 'evidenceIds', 'riskIds']);
const STABLE_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

function strictFields(value, fields, subject) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${subject} должен быть объектом`);
  }
  const extra = Object.keys(value).find((key) => !fields.has(key));
  if (extra) throw new TypeError(`${subject}: лишнее поле ${extra}`);
}

function ids(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} должен быть массивом`);
  const output = value.map((id) => {
    if (typeof id !== 'string' || !STABLE_ID.test(id)) {
      throw new TypeError(`${field} содержит некорректный ID`);
    }
    return id;
  });
  if (new Set(output).size !== output.length) throw new TypeError(`${field} содержит дубли`);
  return output;
}

function sameSet(actual, expected, field) {
  if (actual.length !== expected.length || actual.some((id) => !expected.includes(id))) {
    throw new TypeError(`${field} изменён переводчиком`);
  }
}

function allowlistedAnalysis(artifact) {
  return {
    decisionId: artifact.decisionId,
    confidenceId: artifact.confidenceId,
    reviewerRequest: artifact.reviewerRequest,
    summary: artifact.summary,
    expectedChange: artifact.expectedChange,
    verification: artifact.verification,
    evidence: structuredClone(artifact.evidence || []),
    risks: structuredClone(artifact.risks || []),
    evidenceIds: [...(artifact.evidenceIds || [])],
    riskIds: [...(artifact.riskIds || [])],
  };
}

export function createTranslatorRequest(artifact) {
  if (!artifact?.analysisId) throw new TypeError('Нет analysisId');
  return {
    schemaRevision: TRANSLATION_SCHEMA_REVISION,
    analysis: allowlistedAnalysis(artifact),
    policy: {
      tools: 'none',
      inputTrust: 'validated-structure',
      preserveDecision: true,
      preserveConfidence: true,
      recommendationText: TRANSLATION_RECOMMENDATIONS[artifact.decisionId],
      instruction: [
        'Объясни обычным русским языком, не добавляя новых фактов.',
        'sections.recommendation.text скопируй из policy.recommendationText без изменений.',
      ].join(' '),
    },
  };
}

export function validateTranslationResult(result, artifact) {
  strictFields(result, RESULT_FIELDS, 'translation result');
  if (!DECISIONS.includes(result.decisionId)) throw new TypeError('Некорректный decisionId');
  if (!CONFIDENCE_LEVELS.includes(result.confidenceId)) {
    throw new TypeError('Некорректный confidenceId');
  }
  if (result.decisionId !== artifact.decisionId) throw new TypeError('decisionId изменён');
  if (result.confidenceId !== artifact.confidenceId) throw new TypeError('confidenceId изменён');
  const evidenceIds = ids(result.evidenceIds, 'evidenceIds');
  const riskIds = ids(result.riskIds, 'riskIds');
  sameSet(evidenceIds, artifact.evidenceIds || [], 'evidenceIds');
  sameSet(riskIds, artifact.riskIds || [], 'riskIds');
  strictFields(result.sections, new Set(Object.keys(TRANSLATION_SECTION_LABELS)), 'sections');
  const sections = {};
  for (const key of Object.keys(TRANSLATION_SECTION_LABELS)) {
    const section = result.sections[key];
    strictFields(section, SECTION_FIELDS, `sections.${key}`);
    if (typeof section.text !== 'string' || !section.text.trim() || section.text.length > 20_000) {
      throw new TypeError(`sections.${key}.text должен быть непустым`);
    }
    const sectionEvidence = ids(section.evidenceIds, `sections.${key}.evidenceIds`);
    const sectionRisks = ids(section.riskIds, `sections.${key}.riskIds`);
    for (const id of sectionEvidence) {
      if (!evidenceIds.includes(id)) throw new TypeError(`sections.${key}: неизвестный ID ${id}`);
    }
    for (const id of sectionRisks) {
      if (!riskIds.includes(id)) throw new TypeError(`sections.${key}: неизвестный ID ${id}`);
    }
    sections[key] = {
      text: section.text,
      evidenceIds: sectionEvidence,
      riskIds: sectionRisks,
    };
  }
  const expectedRecommendation = TRANSLATION_RECOMMENDATIONS[result.decisionId];
  if (sections.recommendation.text !== expectedRecommendation) {
    throw new TypeError(
      `sections.recommendation.text обязан точно соответствовать decisionId: ${expectedRecommendation}`,
    );
  }
  if (evidenceIds.length) {
    for (const key of ['reviewerRequest', 'reason', 'expectedChange']) {
      if (!sections[key].evidenceIds.length) {
        throw new TypeError(`sections.${key} обязан ссылаться на evidence ID`);
      }
    }
    if (
      result.decisionId === 'PRODUCT_DECISION'
      && !sections.decisionNeeded.evidenceIds.length
    ) {
      throw new TypeError('sections.decisionNeeded обязан ссылаться на evidence ID');
    }
  }
  if (riskIds.length && !sections.risks.riskIds.length) {
    throw new TypeError('sections.risks обязан ссылаться на risk ID');
  }
  return {
    decisionId: result.decisionId,
    confidenceId: result.confidenceId,
    evidenceIds,
    riskIds,
    sections,
  };
}

function queuedArtifact(artifact) {
  const request = createTranslatorRequest(artifact);
  return {
    itemKey: artifact.itemKey,
    versionId: artifact.versionId,
    headSha: artifact.headSha,
    analysisId: artifact.analysisId,
    request,
  };
}

function translationJobReferences(job, artifact) {
  if (
    job?.queue !== 'translation'
    || !['pending', 'running', 'failed'].includes(job.status)
  ) {
    return false;
  }
  const references = job.payload?.entries || job.payload?.itemVersions || [];
  return references.some((reference) => (
    reference.itemKey === artifact.itemKey
    && reference.versionId === artifact.versionId
    // Новые compacted jobs сохраняют analysisId: terminal failure старого
    // анализа не должен блокировать durable recovery явно запущенного свежего.
    // Отсутствие analysisId у legacy-state трактуем консервативно как совпадение.
    && (!reference.analysisId || reference.analysisId === artifact.analysisId)
  ));
}

function missingTranslationArtifacts(state) {
  const artifacts = [];
  for (const repository of Object.values(state.repositories || {})) {
    for (const pullRequest of repository.pullRequests || []) {
      if (String(pullRequest.state || '').toLowerCase() !== 'open') continue;
      for (const remark of pullRequest.remarks || []) {
        if (String(remark.state || '').toLowerCase() !== 'open') continue;
        const artifact = state.analyses?.[remark.key]?.current;
        if (
          !artifact
          || artifact.stale
          || artifact.itemKey !== remark.key
          || artifact.versionId !== remark.versionId
          || artifact.headSha !== pullRequest.headSha
        ) {
          continue;
        }
        const translation = state.translations?.[remark.key]?.current;
        if (
          translation?.versionId === remark.versionId
          && translation.analysisId === artifact.analysisId
        ) {
          continue;
        }
        if (Object.values(state.jobs || {}).some((job) => (
          translationJobReferences(job, artifact)
        ))) {
          continue;
        }
        artifacts.push(artifact);
      }
    }
  }
  return artifacts.sort((left, right) => left.itemKey.localeCompare(right.itemKey));
}

export class ReviewTranslatorQueue {
  constructor({
    store,
    model,
    clock = Date.now,
    promptRevision = TRANSLATION_PROMPT_REVISION,
    maxRetries = 3,
    leaseMs = 35 * 60_000,
    workerId = `review-translation:${process.pid}:${randomUUID()}`,
    timers = globalThis,
    onChange = null,
    log = null,
  } = {}) {
    if (!store || !model?.generate) throw new TypeError('Нужны store и model.generate');
    this.store = store;
    this.model = model;
    this.clock = typeof clock === 'function' ? clock : () => clock.now();
    this.promptRevision = promptRevision;
    this.maxRetries = maxRetries;
    this.leaseMs = leaseMs;
    this.workerId = workerId;
    this.timers = timers;
    this.onChange = onChange;
    this.log = log;
  }

  async enqueue({ artifacts }, { availableAt = this.clock() } = {}) {
    if (!Array.isArray(artifacts) || !artifacts.length) throw new TypeError('Нет artifacts');
    const entries = artifacts.map(queuedArtifact);
    const digest = sha256(JSON.stringify([
      entries.map((item) => [item.itemKey, item.versionId, item.analysisId]),
      this.promptRevision,
    ]));
    return this.store.enqueueJob({
      queue: 'translation',
      dedupKey: `translation:v1:${digest}`,
      payload: { entries },
      availableAt,
      maxAttempts: this.maxRetries,
    });
  }

  /**
   * Восстанавливает durable outbox после разрыва между analysis CAS и enqueue
   * перевода. Каждый артефакт получает отдельную job: если один комментарий
   * станет stale, отмена его batch больше не потеряет неизменных соседей.
   */
  async reconcileMissing({ limit = 100, availableAt = this.clock() } = {}) {
    const state = await this.store.read();
    const artifacts = missingTranslationArtifacts(state)
      .slice(0, Math.max(1, Number(limit) || 100));
    let enqueued = 0;
    let deduplicated = 0;
    for (const artifact of artifacts) {
      const result = await this.enqueue({ artifacts: [artifact] }, { availableAt });
      if (result?.deduplicated) deduplicated += 1;
      else if (result?.job) enqueued += 1;
    }
    return {
      missing: artifacts.length,
      enqueued,
      deduplicated,
    };
  }

  async runNext({ signal } = {}) {
    await this.reconcileMissing();
    const job = await this.store.claimJob({
      queue: 'translation',
      workerId: this.workerId,
      leaseMs: this.leaseMs,
    });
    if (!job) return null;
    if (job.maintenance) {
      const recoveredFailures = Array.isArray(job.recoveredFailures)
        ? job.recoveredFailures
        : [];
      await this.#notify({
        type: 'reviews-change',
        reason: 'translation_recovered_failure',
        itemKeys: [...new Set(recoveredFailures.map((item) => item.itemKey).filter(Boolean))],
      });
      return {
        status: 'recovered_failed',
        recoveredFailures,
      };
    }
    const entries = job.payload.entries;
    const leaseGate = {
      jobId: job.id,
      workerId: this.workerId,
      fencingToken: job.fencingToken,
    };
    const heartbeat = this.#heartbeat(job);
    try {
      const results = [];
      for (const entry of entries) {
        const raw = await this.model.generate({
          stage: 'TRANSLATOR',
          schemaRevision: TRANSLATION_SCHEMA_REVISION,
          promptRevision: this.promptRevision,
          input: entry.request,
          signal,
        });
        const validated = validateTranslationResult(raw, entry.request.analysis);
        const translationId = `translation:v1:${sha256(JSON.stringify([
          entry.analysisId,
          validated,
          TRANSLATION_SCHEMA_REVISION,
          this.promptRevision,
        ]))}`;
        results.push({
          itemKey: entry.itemKey,
          versionId: entry.versionId,
          headSha: entry.headSha,
          analysisId: entry.analysisId,
          artifact: {
            translationId,
            analysisId: entry.analysisId,
            itemKey: entry.itemKey,
            versionId: entry.versionId,
            schemaRevision: TRANSLATION_SCHEMA_REVISION,
            promptRevision: this.promptRevision,
            createdAt: new Date(this.clock()).toISOString(),
            ...validated,
          },
        });
      }
      if (heartbeat.error) throw heartbeat.error;
      const cas = await this.store.compareAndSetTranslationBatch(results, {
        jobLease: leaseGate,
      });
      if (!cas.applied) {
        await this.store.completeJob({
          jobId: job.id,
          workerId: this.workerId,
          fencingToken: job.fencingToken,
          result: { applied: false, reason: cas.reason },
        });
        return { status: 'stale', reason: cas.reason, jobId: job.id };
      }
      await this.store.completeJob({
        jobId: job.id,
        workerId: this.workerId,
        fencingToken: job.fencingToken,
        result: {
          applied: true,
          translationIds: results.map((item) => item.artifact.translationId),
        },
      });
      await this.#notify({
        type: 'reviews-change',
        reason: 'translation_completed',
        itemKeys: results.map((item) => item.itemKey),
      });
      return {
        status: 'completed',
        jobId: job.id,
        artifacts: results.map((item) => item.artifact),
      };
    } catch (error) {
      if (error?.code === 'STALE_FENCE') {
        return { status: 'stale_owner', jobId: job.id, error };
      }
      const contractError = error instanceof TypeError;
      const publicError = {
        code: contractError ? 'TRANSLATION_CONTRACT_INVALID' : (error.code || 'TRANSLATION_FAILED'),
        message: contractError
          ? 'Переводчик вернул ответ вне контракта'
          : 'Не удалось подготовить понятное объяснение',
      };
      for (const entry of entries) {
        try {
          await this.store.recordArtifactError({
            stage: 'translation',
            itemKey: entry.itemKey,
            versionId: entry.versionId,
            error: publicError,
            jobLease: leaseGate,
          });
        } catch (recordError) {
          if (recordError?.code === 'STALE_FENCE') {
            return { status: 'stale_owner', jobId: job.id, error: recordError };
          }
          throw recordError;
        }
      }
      await this.store.failJob({
        jobId: job.id,
        workerId: this.workerId,
        fencingToken: job.fencingToken,
        error: publicError,
        retryable: !contractError,
        retryAt: this.clock() + Math.min(60_000, 1000 * (2 ** job.attempts)),
      });
      await this.#notify({
        type: 'reviews-change',
        reason: 'translation_failed',
        itemKeys: entries.map((item) => item.itemKey),
      });
      return { status: 'failed', jobId: job.id, code: publicError.code };
    } finally {
      heartbeat.stop();
    }
  }

  async drain({ signal, limit = 100 } = {}) {
    const outcomes = [];
    while (outcomes.length < limit && !signal?.aborted) {
      const outcome = await this.runNext({ signal });
      if (!outcome) break;
      outcomes.push(outcome);
    }
    return outcomes;
  }

  #heartbeat(job) {
    const state = { error: null };
    const intervalMs = Math.max(1000, Math.min(60_000, Math.floor(this.leaseMs / 3)));
    const timer = this.timers.setInterval(() => {
      this.store.renewJobLease({
        jobId: job.id,
        workerId: this.workerId,
        fencingToken: job.fencingToken,
        leaseMs: this.leaseMs,
      }).catch((error) => { state.error = error; });
    }, intervalMs);
    timer?.unref?.();
    return {
      get error() { return state.error; },
      stop: () => this.timers.clearInterval(timer),
    };
  }

  async #notify(event) {
    if (!this.onChange) return;
    try {
      await this.onChange(event);
    } catch (error) {
      this.log?.warn?.({ code: error?.code || 'TRANSLATION_CHANGE_CALLBACK_FAILED' },
        'Не отправлен reviews-change после перевода');
    }
  }
}
