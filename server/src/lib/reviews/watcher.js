// Автоматический watcher GitHub review inbox.
//
// Timer и ручная кнопка сходятся в один trigger. Локальный Map схлопывает
// повторные вызовы процесса, durable sync lease защищает от второго процесса,
// а общий cooldown хранится по безопасному fingerprint credentials.
import { randomUUID } from 'node:crypto';

export const TRUSTED_AUTO_ANALYSIS_ASSOCIATIONS = Object.freeze(new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]));

const DEFAULT_AUTO_LIMITS = Object.freeze({
  maxItemsPerPull: 20,
  maxRemarkBytes: 512 * 1024,
  maxDiffBytes: 2 * 1024 * 1024,
  maxSourceBytes: 2 * 1024 * 1024,
  maxInputBytes: 6 * 1024 * 1024,
  maxQueueDepth: 20,
  maxCallsPerDay: 180,
  maxBytesPerDay: 128 * 1024 * 1024,
});

function bytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

export function canAutoAnalyzeRemark(remark) {
  return TRUSTED_AUTO_ANALYSIS_ASSOCIATIONS.has(
    String(remark?.authorAssociation || '').toUpperCase(),
  );
}

export class ReviewWatcher {
  constructor({
    store,
    github,
    repositories,
    analysisQueue,
    sourceSnapshot = null,
    clock = Date.now,
    timers = globalThis,
    onChange = null,
    intervalMs = 5 * 60_000,
    coalesceMs = 45_000,
    maxAutoRetries = 3,
    retryBaseMs = 5_000,
    jitter = (delay) => Math.floor(Math.random() * Math.max(1, delay / 4)),
    workerId = `review-watcher:${process.pid}:${randomUUID()}`,
    syncLeaseMs = 10 * 60_000,
    autoLimits = {},
    log = null,
  } = {}) {
    if (!store || !github?.syncRepository || !analysisQueue?.enqueue) {
      throw new TypeError('ReviewWatcher требует store, github и analysisQueue');
    }
    if (!repositories) throw new TypeError('ReviewWatcher требует repository provider');
    if (typeof sourceSnapshot !== 'function') {
      throw new TypeError('ReviewWatcher требует exact read-only sourceSnapshot provider');
    }
    this.store = store;
    this.github = github;
    this.repositories = repositories;
    this.analysisQueue = analysisQueue;
    this.sourceSnapshot = sourceSnapshot;
    this.clock = typeof clock === 'function' ? clock : () => clock.now();
    this.timers = timers;
    this.onChange = onChange;
    this.intervalMs = Math.max(1000, Number(intervalMs) || 5 * 60_000);
    this.coalesceMs = Math.max(0, Number(coalesceMs) || 0);
    this.maxAutoRetries = Math.max(1, Number(maxAutoRetries) || 3);
    this.retryBaseMs = Math.max(1, Number(retryBaseMs) || 5000);
    this.jitter = jitter;
    this.workerId = workerId;
    this.syncLeaseMs = Math.max(1000, Number(syncLeaseMs) || 10 * 60_000);
    this.autoLimits = Object.freeze(Object.fromEntries(
      Object.entries(DEFAULT_AUTO_LIMITS).map(([key, fallback]) => [
        key,
        Math.max(1, Number(autoLimits[key]) || fallback),
      ]),
    ));
    this.log = log;
    this.timer = null;
    this.inflight = new Map();
  }

  async start() {
    if (this.timer) return [];
    this.timer = this.timers.setInterval(() => {
      this.tick().catch((error) => {
        this.log?.warn?.({ code: error.code || 'WATCH_TICK_FAILED' }, 'Не выполнен review tick');
      });
    }, this.intervalMs);
    this.timer?.unref?.();
    return this.tick();
  }

  stop() {
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const repositories = await this.#repositories();
    const results = [];
    for (const repository of repositories) {
      if (!repository.confirmed || !repository.enabled) continue;
      results.push(await this.trigger(repository, { manual: false }));
    }
    return results;
  }

  async trigger(repositoryOrId, { manual = false } = {}) {
    const repository = typeof repositoryOrId === 'string'
      ? (await this.#repositories()).find((item) => item.id === repositoryOrId)
      : repositoryOrId;
    if (!repository?.id) return { status: 'not_found' };
    if (!repository.confirmed) return { status: 'unconfirmed' };
    if (!manual && !repository.enabled) return { status: 'disabled' };
    const running = this.inflight.get(repository.id);
    if (running) return running;
    const operation = this.#sync(repository, { manual }).finally(() => {
      if (this.inflight.get(repository.id) === operation) this.inflight.delete(repository.id);
    });
    this.inflight.set(repository.id, operation);
    return operation;
  }

  async flush() {
    const sync = await this.tick();
    const analysis = this.analysisQueue.drain
      ? await this.analysisQueue.drain()
      : [];
    return { sync, analysis };
  }

  async #sync(repository, { manual }) {
    const now = this.clock();
    const fingerprint = repository.credentialFingerprint || `repository:${repository.id}`;
    const rateLimit = await this.store.getRateLimit(fingerprint);
    if (rateLimit?.until > now) {
      return {
        status: 'cooldown',
        reason: rateLimit.reason,
        retryAt: rateLimit.until,
      };
    }
    const previous = await this.store.getWatcherState(repository.id);
    if (!manual && previous?.terminal) {
      return { status: 'retry_exhausted', attempts: previous.attempts };
    }
    if (!manual && previous?.nextAttemptAt > now) {
      return {
        status: 'backoff',
        reason: previous.lastError?.code || 'retry_backoff',
        retryAt: previous.nextAttemptAt,
      };
    }
    const lease = await this.store.claimRepositorySync({
      repositoryId: repository.id,
      workerId: this.workerId,
      leaseMs: this.syncLeaseMs,
    });
    if (!lease) return { status: 'busy' };
    const syncLease = {
      repositoryId: repository.id,
      workerId: this.workerId,
      fencingToken: lease.fencingToken,
    };
    const heartbeat = this.#heartbeat(repository.id, lease);
    try {
      if (manual) {
        await this.store.setWatcherState(repository.id, {
          attempts: 0,
          terminal: false,
          nextAttemptAt: 0,
          lastManualAt: new Date(now).toISOString(),
          lastError: null,
        }, { syncLease });
      }
      const snapshot = await this.github.syncRepository({
        owner: repository.owner,
        name: repository.name,
        repoNodeId: repository.repoNodeId || null,
      });
      if (heartbeat.error) throw heartbeat.error;
      const applied = await this.store.applyRepositorySnapshot(snapshot, { syncLease });
      const scheduled = await this.#scheduleMissing(repository, applied.snapshot, syncLease);
      if (heartbeat.error) throw heartbeat.error;
      await this.store.setWatcherState(repository.id, {
        attempts: 0,
        terminal: false,
        nextAttemptAt: 0,
        lastSuccessAt: new Date(this.clock()).toISOString(),
        lastError: null,
      }, { syncLease });
      // SSE — только после всех связанных durable-записей. Иначе клиент мог
      // перечитать GitHub-снимок до появления queued/manual_required и больше
      // не получить сигнала об уже сохранённом состоянии анализа.
      if (applied.changed || scheduled.changed) {
        await this.#notify({
          type: 'reviews-change',
          repositoryId: repository.id,
          repoNodeId: snapshot.repoNodeId,
          revision: (await this.store.read()).revision,
          reason: applied.changed ? 'github_snapshot' : 'analysis_state',
        });
      }
      return {
        status: applied.changed ? 'changed' : 'unchanged',
        revision: applied.revision,
        changedRemarks: applied.changedRemarks.length,
        cancelledRemarks: applied.cancelledRemarks.length,
        analysisEnqueued: scheduled.enqueued,
      };
    } catch (error) {
      if (error?.code === 'STALE_FENCE') {
        return { status: 'stale_owner', error };
      }
      return this.#recordFailure(repository, error, {
        manual,
        previous: manual ? null : previous,
        fingerprint,
        syncLease,
      });
    } finally {
      heartbeat.stop();
      try {
        await this.store.releaseRepositorySync(syncLease);
      } catch (error) {
        if (error?.code !== 'STALE_FENCE') throw error;
      }
    }
  }

  async #scheduleMissing(repository, snapshot, syncLease) {
    if (repository.autoAnalyze === false) {
      return { enqueued: 0, changed: false };
    }
    const state = await this.store.read();
    const initialRevision = state.revision;
    let enqueued = 0;
    for (const pullRequest of snapshot.pullRequests || []) {
      if (pullRequest.state !== 'open') continue;
      const missing = (pullRequest.remarks || []).filter((remark) => {
        if (remark.state !== 'open') return false;
        const current = state.analyses[remark.key]?.current;
        if (current?.versionId === remark.versionId && !current.stale) return false;
        // Pending/running/failed exact job означает, что эта версия уже учтена.
        // Failed не перезапускается каждым poll: только явный retry сбросит бюджет.
        return !Object.values(state.jobs).some((job) => (
          job.queue === 'analysis'
          && ['pending', 'running', 'failed'].includes(job.status)
          && (
            job.payload?.request?.identity?.itemVersions
            || job.payload?.itemVersions
            || []
          ).some((reference) => (
            reference.itemKey === remark.key && reference.versionId === remark.versionId
          ))
        ));
      });
      const untrusted = missing.filter((remark) => !canAutoAnalyzeRemark(remark));
      if (untrusted.length) {
        await this.store.recordAutoAnalysisDeferral({
          items: untrusted,
          reason: 'untrusted_author',
          message: 'Автор не относится к OWNER/MEMBER/COLLABORATOR; комментарий виден, но анализ запускается вручную',
        }, { syncLease });
      }
      const items = missing.filter(canAutoAnalyzeRemark);
      if (!items.length) continue;
      if (items.length > this.autoLimits.maxItemsPerPull) {
        await this.store.recordAutoAnalysisDeferral({
          items,
          reason: 'item_limit',
          message: 'Слишком много замечаний для одного автоматического запуска; нужен ручной анализ',
        }, { syncLease });
        continue;
      }
      const remarkBytes = items.reduce((total, item) => total + bytes(item.body || ''), 0);
      const diffBytes = bytes(pullRequest.diff || '');
      if (
        remarkBytes > this.autoLimits.maxRemarkBytes
        || diffBytes > this.autoLimits.maxDiffBytes
      ) {
        await this.store.recordAutoAnalysisDeferral({
          items,
          reason: 'input_limit',
          message: 'Комментарий или diff превышает безопасный лимит автоанализа; доступен ручной запуск',
        }, { syncLease });
        continue;
      }
      const sourceSnapshot = await this.sourceSnapshot({
        repository,
        pullRequest: structuredClone(pullRequest),
        items: structuredClone(items),
      });
      if (
        !sourceSnapshot
        || sourceSnapshot.readOnly !== true
        || (sourceSnapshot.headSha && sourceSnapshot.headSha !== pullRequest.headSha)
      ) {
        const error = new Error('sourceSnapshot не является read-only снимком точного head SHA');
        error.code = 'SOURCE_SNAPSHOT_INVALID';
        error.retryable = false;
        throw error;
      }
      const sourceBytes = bytes(sourceSnapshot);
      const inputBytes = remarkBytes + diffBytes + sourceBytes;
      if (
        sourceBytes > this.autoLimits.maxSourceBytes
        || inputBytes > this.autoLimits.maxInputBytes
      ) {
        await this.store.recordAutoAnalysisDeferral({
          items,
          reason: 'input_limit',
          message: 'Контекст исходников превышает безопасный лимит автоанализа; доступен ручной запуск',
        }, { syncLease });
        continue;
      }
      const result = await this.analysisQueue.enqueue({
        repoNodeId: snapshot.repoNodeId,
        prNodeId: pullRequest.prNodeId,
        headSha: pullRequest.headSha,
        items,
        diff: pullRequest.diff || '',
        sourceSnapshot,
      }, {
        availableAt: this.clock() + this.coalesceMs,
        autoBudget: {
          repositoryId: repository.id,
          bytes: inputBytes,
          maxCalls: this.autoLimits.maxCallsPerDay,
          maxBytes: this.autoLimits.maxBytesPerDay,
        },
        capacity: {
          repoNodeId: snapshot.repoNodeId,
          maxDepth: this.autoLimits.maxQueueDepth,
        },
        inputLimits: {
          maxItems: this.autoLimits.maxItemsPerPull,
          maxRemarkBytes: this.autoLimits.maxRemarkBytes,
          maxDiffBytes: this.autoLimits.maxDiffBytes,
          maxSourceBytes: this.autoLimits.maxSourceBytes,
          maxTotalBytes: this.autoLimits.maxInputBytes,
        },
      });
      if (result?.rejected) {
        const messages = {
          daily_budget: 'Исчерпан дневной бюджет автоанализа; доступен ручной запуск',
          input_limit: 'Объединённый пакет превышает безопасный лимит автоанализа; доступен ручной запуск',
          queue_depth: 'Очередь автоанализа заполнена; доступен ручной запуск',
        };
        await this.store.recordAutoAnalysisDeferral({
          items,
          reason: result.rejected,
          message: messages[result.rejected] || 'Автоанализ отложен; доступен ручной запуск',
        }, { syncLease });
        continue;
      }
      await this.store.clearAutoAnalysisDeferrals(
        items.map((item) => item.key),
        { syncLease },
      );
      if (!result.deduplicated) enqueued += 1;
    }
    return {
      enqueued,
      changed: (await this.store.read()).revision !== initialRevision,
    };
  }

  async #recordFailure(repository, error, {
    manual,
    previous,
    fingerprint,
    syncLease,
  }) {
    const attempts = Number(previous?.attempts || 0) + 1;
    const now = this.clock();
    const resetValue = typeof error?.rateLimitResetAt === 'string'
      ? Date.parse(error.rateLimitResetAt)
      : Number(error?.rateLimitResetAt || 0);
    const retryAfter = Number(error?.retryAfterMs || 0);
    const rateUntil = Math.max(
      retryAfter > 0 ? now + retryAfter : 0,
      Number.isFinite(resetValue) ? resetValue : 0,
    );
    const rateLimited = rateUntil > now
      || error?.rateLimited
      || /RATE_LIMIT/i.test(String(error?.code || ''));
    let nextAttemptAt = 0;
    if (rateLimited) {
      nextAttemptAt = rateUntil > now ? rateUntil : now + 60_000;
      await this.store.setRateLimit(fingerprint, {
        until: nextAttemptAt,
        reason: error?.code || 'rate_limit',
        attempts,
      }, { syncLease });
    } else {
      const base = Math.min(15 * 60_000, this.retryBaseMs * (2 ** Math.max(0, attempts - 1)));
      nextAttemptAt = now + base + Math.max(0, Number(this.jitter(base)) || 0);
    }
    const terminal = attempts >= this.maxAutoRetries;
    await this.store.setWatcherState(repository.id, {
      attempts,
      terminal,
      nextAttemptAt: terminal ? 0 : nextAttemptAt,
      lastError: {
        code: String(error?.code || 'GITHUB_SYNC_FAILED'),
        message: 'Не удалось обновить замечания GitHub',
        retryable: error?.retryable !== false,
      },
      lastFailureAt: new Date(now).toISOString(),
      lastTrigger: manual ? 'manual' : 'automatic',
    }, { syncLease });
    return {
      status: 'error',
      code: String(error?.code || 'GITHUB_SYNC_FAILED'),
      attempts,
      terminal,
      retryAt: terminal ? null : nextAttemptAt,
    };
  }

  async #repositories() {
    const value = typeof this.repositories === 'function'
      ? await this.repositories()
      : this.repositories;
    return Array.isArray(value) ? value : [];
  }

  async #notify(event) {
    if (!this.onChange) return;
    try {
      await this.onChange(event);
    } catch (error) {
      this.log?.warn?.({
        code: error?.code || 'REVIEWS_CHANGE_CALLBACK_FAILED',
        repositoryId: event.repositoryId,
      }, 'Не отправлен reviews-change');
    }
  }

  #heartbeat(repositoryId, lease) {
    const state = { error: null };
    const intervalMs = Math.max(1000, Math.min(60_000, Math.floor(this.syncLeaseMs / 3)));
    const timer = this.timers.setInterval(() => {
      this.store.renewRepositorySync({
        repositoryId,
        workerId: this.workerId,
        fencingToken: lease.fencingToken,
        leaseMs: this.syncLeaseMs,
      }).catch((error) => { state.error = error; });
    }, intervalMs);
    timer?.unref?.();
    return {
      get error() { return state.error; },
      stop: () => this.timers.clearInterval(timer),
    };
  }
}
