// Durable inbox-состояние ревью: снимки GitHub, очереди анализа, readVersion
// и общие cooldown. Один JSON упрощает атомарный CAS между связанными сущностями.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createRemarkVersion, snapshotDigest, snapshotKey } from './identity.js';
import { acquireKernelFileLock } from './kernel-lock.js';

export const REVIEW_STORE_SCHEMA_VERSION = 1;
const MAX_ARTIFACT_HISTORY = 20;
const MAX_CLOSED_PULL_REQUESTS = 200;
const CLOSED_PULL_REQUEST_RETENTION_MS = 90 * 24 * 60 * 60_000;
const MAX_TERMINAL_JOBS = 1_000;
const MAX_REVIEW_STATE_BYTES = 128 * 1024 * 1024;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function emptyState(clock) {
  const timestamp = nowIso(clock);
  return {
    schemaVersion: REVIEW_STORE_SCHEMA_VERSION,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    repositories: {},
    jobs: {},
    jobOrder: [],
    analyses: {},
    translations: {},
    readVersions: {},
    rateLimits: {},
    watcher: {},
    syncLeases: {},
    nextFence: 0,
  };
}

function activeRemark(remark) {
  return remark && remark.state === 'open';
}

function remarksOf(snapshot) {
  const map = new Map();
  for (const pullRequest of snapshot?.pullRequests || []) {
    for (const remark of pullRequest.remarks || []) {
      map.set(remark.key, { pullRequest, remark });
    }
  }
  return map;
}

function pullRequestDigest(pullRequest) {
  const value = clone(pullRequest);
  delete value.attentionVersion;
  delete value.readVersion;
  delete value.closedDetectedAt;
  return snapshotDigest({ pullRequests: [value] });
}

function requestItems(payload) {
  return payload?.request?.identity?.itemVersions
    || payload?.itemVersions
    || payload?.entries
    || payload?.items
    || null;
}

function compactTerminalJob(job) {
  if (!job || ['pending', 'running'].includes(job.status)) return;
  const itemVersions = requestItems(job.payload);
  job.payload = {
    archived: true,
    ...(Array.isArray(itemVersions)
      ? { itemVersions: itemVersions.map((item) => ({
        itemKey: item.itemKey || item.key,
        versionId: item.versionId,
        ...(item.analysisId ? { analysisId: item.analysisId } : {}),
      })) }
      : {}),
  };
}

function sameItemVersions(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  const wanted = new Set(left.map((item) => `${item.itemKey || item.key}\u0000${item.versionId}`));
  return right.every((item) => wanted.has(`${item.itemKey || item.key}\u0000${item.versionId}`));
}

function mergePendingPayload(current, incoming) {
  if (current?.request && incoming?.request) {
    const previousItems = current.request.identity.itemVersions || [];
    const nextItems = incoming.request.identity.itemVersions || [];
    const versions = new Map(previousItems.map((item) => [item.itemKey, clone(item)]));
    for (const item of nextItems) versions.set(item.itemKey, clone(item));
    const untrusted = new Map(
      (current.request.untrustedInput?.items || []).map((item) => [item.itemKey, clone(item)]),
    );
    for (const item of incoming.request.untrustedInput?.items || []) {
      untrusted.set(item.itemKey, clone(item));
    }
    return {
      ...clone(current),
      ...clone(incoming),
      request: {
        ...clone(current.request),
        ...clone(incoming.request),
        identity: {
          ...clone(incoming.request.identity),
          itemVersions: [...versions.values()],
        },
        untrustedInput: {
          ...clone(current.request.untrustedInput),
          ...clone(incoming.request.untrustedInput),
          items: [...untrusted.values()],
        },
      },
    };
  }
  if (Array.isArray(incoming?.items)) {
    const latest = new Map((current?.items || []).map((item) => [item.key, clone(item)]));
    for (const item of incoming.items) latest.set(item.key, clone(item));
    return { ...clone(current), ...clone(incoming), items: [...latest.values()] };
  }
  return clone(current);
}

function analysisInputStats(payload) {
  const request = payload?.request;
  if (!request) return null;
  const items = request.untrustedInput?.items || [];
  const remarkBytes = items.reduce(
    (total, item) => total + Buffer.byteLength(String(item?.body || ''), 'utf8'),
    0,
  );
  const diffBytes = Buffer.byteLength(String(request.untrustedInput?.diff || ''), 'utf8');
  const sourceBytes = Buffer.byteLength(
    JSON.stringify(request.untrustedInput?.sourceSnapshot || null),
    'utf8',
  );
  return {
    items: items.length,
    remarkBytes,
    diffBytes,
    sourceBytes,
    totalBytes: remarkBytes + diffBytes + sourceBytes,
  };
}

function analysisInputLimitReason(payload) {
  const stats = analysisInputStats(payload);
  const limits = payload?.inputLimits;
  if (!stats || !limits) return null;
  if (stats.items > Number(limits.maxItems)) return 'item_limit';
  if (stats.remarkBytes > Number(limits.maxRemarkBytes)) return 'remark_bytes';
  if (stats.diffBytes > Number(limits.maxDiffBytes)) return 'diff_bytes';
  if (stats.sourceBytes > Number(limits.maxSourceBytes)) return 'source_bytes';
  if (stats.totalBytes > Number(limits.maxTotalBytes)) return 'total_bytes';
  return null;
}

function validateState(state) {
  if (!state || state.schemaVersion !== REVIEW_STORE_SCHEMA_VERSION) {
    const error = new Error(`Неподдерживаемая schema review store: ${state?.schemaVersion ?? 'нет'}`);
    error.code = 'REVIEW_STORE_SCHEMA';
    throw error;
  }
  for (const field of [
    'repositories', 'jobs', 'analyses', 'translations', 'readVersions',
    'rateLimits', 'watcher', 'syncLeases',
  ]) {
    if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) {
      throw new Error(`Повреждён review store: ${field}`);
    }
  }
  if (!Array.isArray(state.jobOrder)) throw new Error('Повреждён review store: jobOrder');
  return state;
}

function staleFence(message = 'Lease уже принадлежит другому владельцу') {
  const error = new Error(message);
  error.code = 'STALE_FENCE';
  return error;
}

export class ReviewStore {
  constructor({
    stateDir = '',
    filePath = '',
    clock = Date.now,
    lockTimeoutMs = 30_000,
  } = {}) {
    if (!filePath && !stateDir) throw new TypeError('ReviewStore требует stateDir или filePath');
    this.filePath = filePath || path.join(stateDir, 'reviews', 'state.json');
    this.lockPath = `${this.filePath}.lock`;
    this.clock = typeof clock === 'function' ? clock : () => clock.now();
    this.lockTimeoutMs = lockTimeoutMs;
    this.localTail = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      validateState(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const lock = await this.#lock();
      try {
        try {
          validateState(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
        } catch (insideError) {
          if (insideError.code !== 'ENOENT') throw insideError;
          await this.#writeAtomic(emptyState(this.clock), {
            assertHeld: lock.assertHeld,
            expectedAbsent: true,
          });
        }
      } finally {
        await lock.release();
      }
    }
    return this;
  }

  async read() {
    await this.init();
    return clone(validateState(JSON.parse(await fs.readFile(this.filePath, 'utf8'))));
  }

  /**
   * Сериализует операции внутри процесса, а kernel flock защищает общий файл от
   * второго процесса. Долгую внешнюю работу под lock не держим.
   */
  async mutate(mutator, { commitGuard = null } = {}) {
    const operation = this.localTail.then(async () => {
      await this.init();
      const lock = await this.#lock();
      try {
        const current = validateState(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
        const next = clone(current);
        const result = await mutator(next, clone(current));
        if (commitGuard) commitGuard(next, current);
        const before = JSON.stringify(current);
        const afterMutation = JSON.stringify(next);
        if (before === afterMutation) return { changed: false, result, state: clone(current) };
        next.revision = current.revision + 1;
        next.updatedAt = nowIso(this.clock);
        await this.#writeAtomic(next, {
          assertHeld: lock.assertHeld,
          assertCanCommit: commitGuard
            ? () => commitGuard(next, current)
            : undefined,
          expectedRevision: current.revision,
        });
        return { changed: true, result, state: clone(next) };
      } finally {
        await lock.release();
      }
    });
    this.localTail = operation.catch(() => {});
    return operation;
  }

  async applyRepositorySnapshot(snapshot, { syncLease = null } = {}) {
    if (!snapshot?.repoNodeId || !Array.isArray(snapshot.pullRequests)) {
      throw new TypeError('Некорректный repository snapshot');
    }
    const incoming = clone(snapshot);
    incoming.digest = snapshotDigest(incoming);
    const outcome = await this.mutate((state) => {
      if (syncLease) this.#assertSyncLeaseGate(state, syncLease);
      const previous = state.repositories[incoming.repoNodeId];
      if (previous?.digest === incoming.digest) {
        this.#compactRetainedState(state);
        return { changedRemarks: [], cancelledRemarks: [] };
      }
      const before = remarksOf(previous);
      const after = remarksOf(incoming);
      const changedRemarks = [];
      const cancelledRemarks = [];
      for (const [key, value] of after) {
        const old = before.get(key)?.remark;
        if ((!old || old.versionId !== value.remark.versionId) && activeRemark(value.remark)) {
          changedRemarks.push(clone(value));
        }
        if (old && activeRemark(old) && !activeRemark(value.remark)) {
          cancelledRemarks.push({ pullRequest: value.pullRequest, remark: value.remark });
        }
      }
      for (const [key, value] of before) {
        if (!after.has(key) && activeRemark(value.remark)) cancelledRemarks.push(clone(value));
      }
      const previousPullRequests = new Map(
        (previous?.pullRequests || []).map((item) => [item.prNodeId, item]),
      );
      const incomingIds = new Set(incoming.pullRequests.map((item) => item.prNodeId));
      // OPEN pagination не сообщает закрытые PR. Сохраняем их последнюю версию
      // как неактивную историю, а не стираем вместе с комментариями.
      for (const oldPullRequest of previousPullRequests.values()) {
        if (incomingIds.has(oldPullRequest.prNodeId)) continue;
        const archived = clone(oldPullRequest);
        archived.state = 'closed';
        archived.closedDetectedAt ||= nowIso(this.clock);
        archived.remarks = (archived.remarks || []).map((oldRemark) => {
          const version = createRemarkVersion({
            ...oldRemark,
            headSha: archived.headSha,
            state: 'closed',
            updatedAt: oldRemark.updatedAt,
            body: oldRemark.body,
          });
          return { ...oldRemark, ...version, state: 'closed', actionable: false };
        });
        incoming.pullRequests.push(archived);
      }
      state.repositories[incoming.repoNodeId] = incoming;
      for (const { remark } of changedRemarks) {
        const record = state.analyses[remark.key];
        if (record?.current && record.current.versionId !== remark.versionId) {
          record.current.stale = true;
          record.current.staleReason = 'version_changed';
        }
      }
      const latestVersions = new Map(
        changedRemarks.map(({ remark }) => [remark.key, remark.versionId]),
      );
      for (const job of Object.values(state.jobs)) {
        if (!['pending', 'running'].includes(job.status)) continue;
        const superseded = (requestItems(job.payload) || []).some((reference) => {
          const key = reference.itemKey || reference.key;
          return latestVersions.has(key) && latestVersions.get(key) !== reference.versionId;
        });
        if (!superseded) continue;
        if (job.status === 'pending') job.status = 'cancelled';
        else job.cancellationRequested = true;
        job.cancelReason = 'superseded_version';
        job.updatedAt = nowIso(this.clock);
        compactTerminalJob(job);
      }
      const cancelledKeys = new Set(cancelledRemarks.map(({ remark }) => remark.key));
      for (const job of Object.values(state.jobs)) {
        const refs = requestItems(job.payload) || [];
        if (!refs.some((item) => cancelledKeys.has(item.key || item.itemKey))) continue;
        if (job.status === 'pending') {
          job.status = 'cancelled';
          job.cancelReason = 'remark_inactive';
          job.updatedAt = nowIso(this.clock);
          compactTerminalJob(job);
        } else if (job.status === 'running') {
          job.cancellationRequested = true;
          job.cancelReason = 'remark_inactive';
        }
      }
      for (const pullRequest of incoming.pullRequests) {
        const key = snapshotKey(incoming.repoNodeId, pullRequest.prNodeId);
        const oldPullRequest = previousPullRequests.get(pullRequest.prNodeId);
        const oldAttention = Math.max(Number(oldPullRequest?.attentionVersion || 0), 0);
        const isArchived = !incomingIds.has(pullRequest.prNodeId);
        const semanticChange = !oldPullRequest
          || pullRequestDigest(oldPullRequest) !== pullRequestDigest(pullRequest);
        pullRequest.attentionVersion = oldAttention + (
          !isArchived && semanticChange ? 1 : 0
        );
        pullRequest.readVersion = Number(state.readVersions[key] || 0);
      }
      const cutoff = this.clock() - CLOSED_PULL_REQUEST_RETENTION_MS;
      const openPullRequests = incoming.pullRequests.filter((item) => item.state !== 'closed');
      const closedPullRequests = incoming.pullRequests
        .filter((item) => item.state === 'closed')
        .filter((item) => Date.parse(item.closedDetectedAt || item.updatedAt || 0) >= cutoff)
        .sort((left, right) => (
          Date.parse(right.closedDetectedAt || right.updatedAt || 0)
          - Date.parse(left.closedDetectedAt || left.updatedAt || 0)
        ))
        .slice(0, MAX_CLOSED_PULL_REQUESTS);
      incoming.pullRequests = [...openPullRequests, ...closedPullRequests];
      incoming.pullRequests.sort((left, right) => Number(left.number) - Number(right.number));

      this.#compactRetainedState(state);
      return { changedRemarks, cancelledRemarks };
    }, {
      commitGuard: syncLease
        ? (_next, current) => this.#assertSyncLeaseGate(current, syncLease)
        : null,
    });
    return {
      changed: outcome.changed,
      revision: outcome.state.revision,
      changedRemarks: outcome.result.changedRemarks,
      cancelledRemarks: outcome.result.cancelledRemarks,
      snapshot: clone(outcome.state.repositories[incoming.repoNodeId]),
    };
  }

  async getRepositorySnapshot(repoNodeId) {
    return clone((await this.read()).repositories[repoNodeId] || null);
  }

  async listPullRequests() {
    const state = await this.read();
    return Object.values(state.repositories).flatMap((repository) => (
      (repository.pullRequests || []).map((pullRequest) => ({
        ...clone(pullRequest),
        repoNodeId: repository.repoNodeId,
        nameWithOwner: repository.nameWithOwner,
        readVersion: Number(state.readVersions[
          snapshotKey(repository.repoNodeId, pullRequest.prNodeId)
        ] || 0),
      }))
    ));
  }

  async enqueueJob({
    id = randomUUID(),
    queue,
    dedupKey,
    payload,
    availableAt = this.clock(),
    maxAttempts = 3,
    capacity = null,
    budget = null,
  }) {
    if (!queue || !dedupKey) throw new TypeError('Job требует queue и dedupKey');
    const outcome = await this.mutate((state) => {
      const candidates = Object.values(state.jobs).filter((job) => (
        job.queue === queue
        && job.dedupKey === dedupKey
        && ['pending', 'running'].includes(job.status)
      ));
      const duplicate = candidates.find((job) => job.status === 'pending')
        || candidates.find((job) => job.status === 'running');
      if (duplicate) {
        if (duplicate.status === 'pending') {
          const mergedPayload = mergePendingPayload(duplicate.payload, payload);
          if (duplicate.payload?.inputLimits && payload?.inputLimits) {
            mergedPayload.inputLimits = Object.fromEntries(
              Object.keys(duplicate.payload.inputLimits).map((key) => [
                key,
                Math.min(
                  Number(duplicate.payload.inputLimits[key]),
                  Number(payload.inputLimits[key]),
                ),
              ]),
            );
          }
          const limitReason = analysisInputLimitReason(mergedPayload);
          if (limitReason) {
            return {
              job: null,
              deduplicated: false,
              rejected: 'input_limit',
              reason: limitReason,
            };
          }
          if (!sameItemVersions(requestItems(duplicate.payload), requestItems(payload))) {
            const reservation = this.#reserveAnalysisBudget(state, budget, {
              attempts: Math.max(1, Number(maxAttempts) || 1),
              includeCalls: false,
            });
            if (!reservation.allowed) return reservation.result;
          }
          duplicate.payload = mergedPayload;
          duplicate.availableAt = Math.max(duplicate.availableAt, Number(availableAt));
          duplicate.updatedAt = nowIso(this.clock);
          return { job: duplicate, deduplicated: true };
        }
        if (sameItemVersions(requestItems(duplicate.payload), requestItems(payload))) {
          return { job: duplicate, deduplicated: true };
        }
        // Пока старая версия уже анализируется, новая получает отдельную pending
        // job с тем же PR-dedupKey. CAS старого результата её не затронет.
      }
      if (capacity?.repoNodeId && Number.isInteger(capacity.maxDepth)) {
        const active = Object.values(state.jobs).filter((job) => (
          ['pending', 'running'].includes(job.status)
          && job.payload?.request?.identity?.repoNodeId === capacity.repoNodeId
        )).length;
        if (active >= capacity.maxDepth) {
          return {
            job: null,
            deduplicated: false,
            rejected: 'queue_depth',
            active,
          };
        }
      }
      const limitReason = analysisInputLimitReason(payload);
      if (limitReason) {
        return {
          job: null,
          deduplicated: false,
          rejected: 'input_limit',
          reason: limitReason,
        };
      }
      const reservation = this.#reserveAnalysisBudget(state, budget, {
        attempts: Math.max(1, Number(maxAttempts) || 1),
        includeCalls: true,
      });
      if (!reservation.allowed) return reservation.result;
      const timestamp = nowIso(this.clock);
      const job = {
        id,
        queue,
        dedupKey,
        payload: clone(payload),
        status: 'pending',
        availableAt: Number(availableAt),
        attempts: 0,
        maxAttempts: Math.max(1, Number(maxAttempts) || 1),
        createdAt: timestamp,
        updatedAt: timestamp,
        lease: null,
        result: null,
        error: null,
      };
      state.jobs[id] = job;
      state.jobOrder.push(id);
      return { job, deduplicated: false };
    });
    return { ...clone(outcome.result), revision: outcome.state.revision };
  }

  async claimJob({ queue, workerId, leaseMs = 60_000 }) {
    if (!queue || !workerId) throw new TypeError('claimJob требует queue и workerId');
    const timestamp = this.clock();
    const outcome = await this.mutate((state) => {
      const recoveredFailures = [];
      for (const job of Object.values(state.jobs)) {
        if (
          job.queue !== queue
          || job.status !== 'running'
          || !job.lease
          || job.lease.expiresAt > timestamp
        ) continue;
        if (job.attempts >= job.maxAttempts) {
          job.status = 'failed';
          job.error = { code: 'RETRY_BUDGET_EXHAUSTED', message: 'Исчерпан бюджет повторов' };
          recoveredFailures.push(...this.#materializeExpiredJobFailure(state, job));
          compactTerminalJob(job);
        } else {
          job.status = 'pending';
          job.availableAt = timestamp;
        }
        job.lease = null;
        job.updatedAt = nowIso(this.clock);
      }
      let job = null;
      for (const id of state.jobOrder) {
        const candidate = state.jobs[id];
        if (
          candidate?.queue !== queue
          || candidate.status !== 'pending'
          || candidate.availableAt > timestamp
        ) continue;
        job = candidate;
        break;
      }
      if (!job) {
        return recoveredFailures.length
          ? { maintenance: true, recoveredFailures }
          : null;
      }
      state.nextFence += 1;
      job.status = 'running';
      job.attempts += 1;
      job.updatedAt = nowIso(this.clock);
      job.lease = {
        workerId,
        fencingToken: state.nextFence,
        expiresAt: timestamp + Math.max(1, leaseMs),
      };
      return job;
    });
    if (!outcome.result) return null;
    if (outcome.result.maintenance) return clone(outcome.result);
    return {
      ...clone(outcome.result),
      workerId,
      fencingToken: outcome.result.lease.fencingToken,
      leaseExpiresAt: outcome.result.lease.expiresAt,
    };
  }

  async renewJobLease({ jobId, workerId, fencingToken, leaseMs = 60_000 }) {
    const leaseGate = { jobId, workerId, fencingToken };
    const outcome = await this.mutate((state) => {
      const job = state.jobs[jobId];
      this.#assertLease(job, workerId, fencingToken);
      job.lease.expiresAt = this.clock() + Math.max(1, leaseMs);
      job.updatedAt = nowIso(this.clock);
      return job;
    }, {
      commitGuard: (_next, current) => this.#assertJobLeaseGate(current, leaseGate),
    });
    return clone(outcome.result);
  }

  async completeJob({ jobId, workerId, fencingToken, result = null }) {
    const leaseGate = { jobId, workerId, fencingToken };
    const outcome = await this.mutate((state) => {
      const job = state.jobs[jobId];
      this.#assertLease(job, workerId, fencingToken);
      job.status = 'completed';
      job.result = clone(result);
      job.error = null;
      job.lease = null;
      job.updatedAt = nowIso(this.clock);
      compactTerminalJob(job);
      return job;
    }, {
      commitGuard: (_next, current) => this.#assertJobLeaseGate(current, leaseGate),
    });
    return clone(outcome.result);
  }

  async failJob({
    jobId,
    workerId,
    fencingToken,
    error,
    retryable = true,
    retryAt = this.clock(),
  }) {
    const leaseGate = { jobId, workerId, fencingToken };
    const outcome = await this.mutate((state) => {
      const job = state.jobs[jobId];
      this.#assertLease(job, workerId, fencingToken);
      job.error = {
        code: String(error?.code || 'JOB_FAILED'),
        message: String(error?.message || error || 'Неизвестная ошибка'),
      };
      job.lease = null;
      if (retryable && job.attempts < job.maxAttempts) {
        job.status = 'pending';
        job.availableAt = Number(retryAt);
      } else {
        job.status = 'failed';
        if (job.attempts >= job.maxAttempts) job.error.terminal = true;
        compactTerminalJob(job);
      }
      job.updatedAt = nowIso(this.clock);
      return job;
    }, {
      commitGuard: (_next, current) => this.#assertJobLeaseGate(current, leaseGate),
    });
    return clone(outcome.result);
  }

  async cancelJobs(predicate, reason = 'cancelled') {
    const outcome = await this.mutate((state) => {
      let count = 0;
      for (const job of Object.values(state.jobs)) {
        if (!['pending', 'running'].includes(job.status) || !predicate(clone(job))) continue;
        if (job.status === 'running') {
          job.cancellationRequested = true;
        } else {
          job.status = 'cancelled';
          compactTerminalJob(job);
        }
        job.cancelReason = reason;
        job.updatedAt = nowIso(this.clock);
        count += 1;
      }
      return count;
    });
    return outcome.result;
  }

  async compareAndSetAnalysis(args, options = {}) {
    return this.#compareAndSetArtifacts('analyses', [args], options);
  }

  async compareAndSetAnalysisBatch(items, options = {}) {
    return this.#compareAndSetArtifacts('analyses', items, options);
  }

  async compareAndSetTranslation(args) {
    return this.compareAndSetTranslationBatch([args], {
      jobLease: args.jobLease || null,
    });
  }

  async compareAndSetTranslationBatch(items, { jobLease = null } = {}) {
    if (!Array.isArray(items) || !items.length) throw new TypeError('Пустой batch переводов');
    const outcome = await this.mutate((state) => {
      if (jobLease) this.#assertJobLeaseGate(state, jobLease);
      const seen = new Set();
      for (const item of items) {
        if (seen.has(item.itemKey)) return { applied: false, reason: 'duplicate_item' };
        seen.add(item.itemKey);
        const current = this.#findRemark(state, item.itemKey);
        if (!current || current.remark.versionId !== item.versionId) {
          return { applied: false, reason: 'version_changed' };
        }
        if (!activeRemark(current.remark)) {
          return { applied: false, reason: 'remark_inactive' };
        }
        if (current.pullRequest.headSha !== item.headSha) {
          return { applied: false, reason: 'head_changed' };
        }
        const analysis = state.analyses[item.itemKey]?.current;
        if (!analysis
            || analysis.analysisId !== item.analysisId
            || analysis.headSha !== item.headSha
            || analysis.stale) {
          return { applied: false, reason: 'analysis_changed' };
        }
      }
      let unchanged = true;
      const affectedPullRequests = new Set();
      for (const item of items) {
        const record = state.translations[item.itemKey] || { history: [], current: null };
        if (record.current?.translationId === item.artifact?.translationId) continue;
        unchanged = false;
        const current = this.#findRemark(state, item.itemKey);
        affectedPullRequests.add(snapshotKey(
          current.repository.repoNodeId,
          current.pullRequest.prNodeId,
        ));
        if (record.current) {
          record.history.push(record.current);
          if (record.history.length > MAX_ARTIFACT_HISTORY) {
            record.history = record.history.slice(-MAX_ARTIFACT_HISTORY);
          }
        }
        record.current = clone(item.artifact);
        record.error = null;
        delete record.autoDeferred;
        state.translations[item.itemKey] = record;
      }
      this.#bumpAttention(state, affectedPullRequests);
      return { applied: true, unchanged };
    }, {
      commitGuard: jobLease
        ? (_next, current) => this.#assertJobLeaseGate(current, jobLease)
        : null,
    });
    return outcome.result;
  }

  async recordArtifactError({ stage, itemKey, versionId, error, jobLease = null }) {
    const field = stage === 'translation' ? 'translations' : 'analyses';
    const outcome = await this.mutate((state) => {
      if (jobLease) this.#assertJobLeaseGate(state, jobLease);
      const current = this.#findRemark(state, itemKey);
      if (!current || current.remark.versionId !== versionId) {
        return { applied: false, reason: 'version_changed' };
      }
      const record = state[field][itemKey] || { history: [], current: null };
      record.error = {
        versionId,
        code: String(error?.code || 'MODEL_FAILED'),
        message: String(error?.message || error || 'Не удалось выполнить этап'),
        at: nowIso(this.clock),
      };
      state[field][itemKey] = record;
      return { applied: true };
    }, {
      commitGuard: jobLease
        ? (_next, current) => this.#assertJobLeaseGate(current, jobLease)
        : null,
    });
    return outcome.result;
  }

  async recordAutoAnalysisDeferral({
    items,
    reason,
    message,
  }, { syncLease = null } = {}) {
    if (!Array.isArray(items) || !items.length) return { applied: 0 };
    const normalizedReason = String(reason || 'manual_required');
    const normalizedMessage = String(message || 'Для анализа нужен ручной запуск').slice(0, 2_000);
    const outcome = await this.mutate((state) => {
      if (syncLease) this.#assertSyncLeaseGate(state, syncLease);
      let applied = 0;
      for (const item of items) {
        const current = this.#findRemark(state, item.key);
        if (!current || current.remark.versionId !== item.versionId) continue;
        const record = state.analyses[item.key] || { history: [], current: null };
        if (
          record.autoDeferred?.versionId === item.versionId
          && record.autoDeferred.reason === normalizedReason
          && record.autoDeferred.message === normalizedMessage
        ) {
          continue;
        }
        record.autoDeferred = {
          versionId: item.versionId,
          reason: normalizedReason,
          message: normalizedMessage,
          at: nowIso(this.clock),
        };
        state.analyses[item.key] = record;
        applied += 1;
      }
      return { applied };
    }, {
      commitGuard: syncLease
        ? (_next, current) => this.#assertSyncLeaseGate(current, syncLease)
        : null,
    });
    return outcome.result;
  }

  async clearAutoAnalysisDeferrals(itemKeys, { syncLease = null } = {}) {
    const keys = new Set(Array.isArray(itemKeys) ? itemKeys : []);
    if (!keys.size) return 0;
    const outcome = await this.mutate((state) => {
      if (syncLease) this.#assertSyncLeaseGate(state, syncLease);
      let cleared = 0;
      for (const key of keys) {
        const record = state.analyses[key];
        if (!record?.autoDeferred) continue;
        delete record.autoDeferred;
        cleared += 1;
      }
      return cleared;
    }, {
      commitGuard: syncLease
        ? (_next, current) => this.#assertSyncLeaseGate(current, syncLease)
        : null,
    });
    return outcome.result;
  }

  async markRead({ repoNodeId, prNodeId, version }) {
    const key = snapshotKey(repoNodeId, prNodeId);
    const outcome = await this.mutate((state) => {
      const repository = state.repositories[repoNodeId];
      const pullRequest = repository?.pullRequests?.find((item) => item.prNodeId === prNodeId);
      if (!pullRequest) return { applied: false, reason: 'pr_not_found' };
      const requested = Number(version);
      const current = Number(pullRequest.attentionVersion || 0);
      if (!Number.isInteger(requested) || requested < 0 || requested > current) {
        return { applied: false, reason: 'invalid_version' };
      }
      state.readVersions[key] = Math.max(Number(state.readVersions[key] || 0), requested);
      pullRequest.readVersion = state.readVersions[key];
      return { applied: true, version: state.readVersions[key] };
    });
    return outcome.result;
  }

  async setRateLimit(fingerprint, value, { syncLease = null } = {}) {
    if (!fingerprint || /token|gh[pousr]_/i.test(fingerprint)) {
      throw new TypeError('Нужен безопасный fingerprint учётных данных, не токен');
    }
    const outcome = await this.mutate((state) => {
      if (syncLease) this.#assertSyncLeaseGate(state, syncLease);
      state.rateLimits[fingerprint] = {
        until: Number(value?.until || 0),
        reason: String(value?.reason || 'rate_limit'),
        attempts: Math.max(0, Number(value?.attempts || 0)),
        updatedAt: nowIso(this.clock),
      };
      return state.rateLimits[fingerprint];
    }, {
      commitGuard: syncLease
        ? (_next, current) => this.#assertSyncLeaseGate(current, syncLease)
        : null,
    });
    return clone(outcome.result);
  }

  async getRateLimit(fingerprint) {
    return clone((await this.read()).rateLimits[fingerprint] || null);
  }

  async setWatcherState(repositoryId, value, { syncLease = null } = {}) {
    const outcome = await this.mutate((state) => {
      if (syncLease) this.#assertSyncLeaseGate(state, syncLease);
      state.watcher[repositoryId] = {
        ...clone(state.watcher[repositoryId] || {}),
        ...clone(value),
        updatedAt: nowIso(this.clock),
      };
      return state.watcher[repositoryId];
    }, {
      commitGuard: syncLease
        ? (_next, current) => this.#assertSyncLeaseGate(current, syncLease)
        : null,
    });
    return clone(outcome.result);
  }

  async getWatcherState(repositoryId) {
    return clone((await this.read()).watcher[repositoryId] || null);
  }

  async claimRepositorySync({ repositoryId, workerId, leaseMs = 120_000 }) {
    const outcome = await this.mutate((state) => {
      const now = this.clock();
      const lease = state.syncLeases[repositoryId];
      if (lease && lease.expiresAt > now) return null;
      state.nextFence += 1;
      state.syncLeases[repositoryId] = {
        workerId,
        fencingToken: state.nextFence,
        expiresAt: now + Math.max(1, leaseMs),
      };
      return state.syncLeases[repositoryId];
    });
    return clone(outcome.result);
  }

  async renewRepositorySync({ repositoryId, workerId, fencingToken, leaseMs = 120_000 }) {
    const syncLease = { repositoryId, workerId, fencingToken };
    const outcome = await this.mutate((state) => {
      const lease = state.syncLeases[repositoryId];
      if (!lease
          || lease.workerId !== workerId
          || lease.fencingToken !== fencingToken
          || lease.expiresAt <= this.clock()) {
        throw staleFence();
      }
      lease.expiresAt = this.clock() + Math.max(1, leaseMs);
      return lease;
    }, {
      commitGuard: (_next, current) => this.#assertSyncLeaseGate(current, syncLease),
    });
    return clone(outcome.result);
  }

  async releaseRepositorySync({ repositoryId, workerId, fencingToken }) {
    const syncLease = { repositoryId, workerId, fencingToken };
    const outcome = await this.mutate((state) => {
      const lease = state.syncLeases[repositoryId];
      if (!lease
          || lease.workerId !== workerId
          || lease.fencingToken !== fencingToken
          || lease.expiresAt <= this.clock()) {
        throw staleFence();
      }
      delete state.syncLeases[repositoryId];
      return true;
    }, {
      commitGuard: (_next, current) => this.#assertSyncLeaseGate(current, syncLease),
    });
    return outcome.result;
  }

  async #compareAndSetArtifacts(field, items, { jobLease = null } = {}) {
    if (!Array.isArray(items) || !items.length) throw new TypeError('Пустой batch артефактов');
    const outcome = await this.mutate((state) => {
      if (jobLease) this.#assertJobLeaseGate(state, jobLease);
      const seen = new Set();
      for (const item of items) {
        if (seen.has(item.itemKey)) return { applied: false, reason: 'duplicate_item' };
        seen.add(item.itemKey);
        const current = this.#findRemark(state, item.itemKey);
        if (!current) return { applied: false, reason: 'item_not_found' };
        if (current.remark.versionId !== item.versionId) {
          return { applied: false, reason: 'version_changed' };
        }
        if (current.pullRequest.headSha !== item.headSha || !activeRemark(current.remark)) {
          return {
            applied: false,
            reason: activeRemark(current.remark) ? 'head_changed' : 'remark_inactive',
          };
        }
      }
      const affectedPullRequests = new Set();
      for (const item of items) {
        const record = state[field][item.itemKey] || { history: [], current: null };
        const artifactId = item.artifact?.analysisId || item.artifact?.translationId;
        const currentId = record.current?.analysisId || record.current?.translationId;
        if (currentId === artifactId) continue;
        const current = this.#findRemark(state, item.itemKey);
        affectedPullRequests.add(snapshotKey(
          current.repository.repoNodeId,
          current.pullRequest.prNodeId,
        ));
        if (record.current) {
          record.history.push(record.current);
          if (record.history.length > MAX_ARTIFACT_HISTORY) {
            record.history = record.history.slice(-MAX_ARTIFACT_HISTORY);
          }
        }
        record.current = clone(item.artifact);
        record.error = null;
        state[field][item.itemKey] = record;
      }
      this.#bumpAttention(state, affectedPullRequests);
      return { applied: true };
    }, {
      commitGuard: jobLease
        ? (_next, current) => this.#assertJobLeaseGate(current, jobLease)
        : null,
    });
    return outcome.result;
  }

  #findRemark(state, itemKey) {
    for (const repository of Object.values(state.repositories)) {
      for (const pullRequest of repository.pullRequests || []) {
        const remark = (pullRequest.remarks || []).find((item) => item.key === itemKey);
        if (remark) return { repository, pullRequest, remark };
      }
    }
    return null;
  }

  #reserveAnalysisBudget(state, budget, {
    attempts,
    includeCalls,
  }) {
    if (!budget?.repositoryId) return { allowed: true };
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    const watcher = state.watcher[budget.repositoryId] || {};
    const previous = watcher.analysisBudget?.day === day
      ? watcher.analysisBudget
      : { day, calls: 0, bytes: 0 };
    // Для новой job резервируем worst-case всех retry сразу. При coalesce новой
    // версии в pending job model call уже зарезервирован, но входящие bytes
    // резервируются повторно консервативно — недоучёта быть не может.
    const reservedCalls = Math.max(0, Number(
      includeCalls ? budget.reserveCalls ?? attempts : budget.mergeReserveCalls ?? 0,
    ));
    const reservedBytes = Math.max(0, Number(
      includeCalls
        ? budget.reserveBytes ?? (Number(budget.bytes || 0) * attempts)
        : budget.mergeReserveBytes ?? (Number(budget.bytes || 0) * attempts),
    ));
    const nextCalls = Number(previous.calls || 0) + reservedCalls;
    const nextBytes = Number(previous.bytes || 0) + reservedBytes;
    if (
      nextCalls > Math.max(1, Number(budget.maxCalls || 1))
      || nextBytes > Math.max(1, Number(budget.maxBytes || 1))
    ) {
      return {
        allowed: false,
        result: {
          job: null,
          deduplicated: false,
          rejected: 'daily_budget',
          reservedCalls,
          reservedBytes,
        },
      };
    }
    state.watcher[budget.repositoryId] = {
      ...watcher,
      analysisBudget: {
        day,
        calls: nextCalls,
        bytes: nextBytes,
        updatedAt: nowIso(this.clock),
      },
    };
    return { allowed: true };
  }

  #bumpAttention(state, pullKeys) {
    if (!pullKeys.size) return;
    for (const repository of Object.values(state.repositories)) {
      for (const pullRequest of repository.pullRequests || []) {
        const key = snapshotKey(repository.repoNodeId, pullRequest.prNodeId);
        if (!pullKeys.has(key)) continue;
        pullRequest.attentionVersion = Number(pullRequest.attentionVersion || 0) + 1;
        pullRequest.readVersion = Number(state.readVersions[key] || 0);
      }
    }
  }

  #materializeExpiredJobFailure(state, job) {
    if (!['analysis', 'translation'].includes(job.queue)) return [];
    const field = job.queue === 'translation' ? 'translations' : 'analyses';
    const affectedPullRequests = new Set();
    const recovered = [];
    for (const reference of requestItems(job.payload) || []) {
      const itemKey = reference.itemKey || reference.key;
      const versionId = reference.versionId;
      const current = this.#findRemark(state, itemKey);
      if (
        !itemKey
        || !versionId
        || !current
        || !activeRemark(current.remark)
        || current.remark.versionId !== versionId
      ) continue;
      const record = state[field][itemKey] || { history: [], current: null };
      const currentArtifactMatches = record.current?.versionId === versionId
        && (
          job.queue !== 'translation'
          || !reference.analysisId
          || record.current.analysisId === reference.analysisId
        );
      if (currentArtifactMatches || record.error?.versionId === versionId) continue;
      record.error = {
        versionId,
        ...(reference.analysisId ? { analysisId: reference.analysisId } : {}),
        code: 'RETRY_BUDGET_EXHAUSTED',
        message: job.queue === 'translation'
          ? 'Не удалось подготовить понятное объяснение после нескольких попыток'
          : 'Не удалось выполнить технический анализ после нескольких попыток',
        at: nowIso(this.clock),
      };
      state[field][itemKey] = record;
      affectedPullRequests.add(snapshotKey(
        current.repository.repoNodeId,
        current.pullRequest.prNodeId,
      ));
      recovered.push({ queue: job.queue, itemKey, versionId });
    }
    this.#bumpAttention(state, affectedPullRequests);
    return recovered;
  }

  #compactRetainedState(state) {
    const cutoff = this.clock() - CLOSED_PULL_REQUEST_RETENTION_MS;
    const retainedRemarkKeys = new Set();
    const retainedPullKeys = new Set();
    for (const repository of Object.values(state.repositories)) {
      const openPullRequests = (repository.pullRequests || [])
        .filter((item) => item.state !== 'closed');
      const closedPullRequests = (repository.pullRequests || [])
        .filter((item) => item.state === 'closed')
        .filter((item) => Date.parse(item.closedDetectedAt || item.updatedAt || 0) >= cutoff)
        .sort((left, right) => (
          Date.parse(right.closedDetectedAt || right.updatedAt || 0)
          - Date.parse(left.closedDetectedAt || left.updatedAt || 0)
        ))
        .slice(0, MAX_CLOSED_PULL_REQUESTS);
      repository.pullRequests = [...openPullRequests, ...closedPullRequests]
        .sort((left, right) => Number(left.number) - Number(right.number));
      for (const pullRequest of repository.pullRequests) {
        retainedPullKeys.add(snapshotKey(repository.repoNodeId, pullRequest.prNodeId));
        for (const remark of pullRequest.remarks || []) retainedRemarkKeys.add(remark.key);
      }
    }
    for (const records of [state.analyses, state.translations]) {
      for (const [itemKey, record] of Object.entries(records)) {
        if (!retainedRemarkKeys.has(itemKey)) {
          delete records[itemKey];
          continue;
        }
        if (Array.isArray(record?.history) && record.history.length > MAX_ARTIFACT_HISTORY) {
          record.history = record.history.slice(-MAX_ARTIFACT_HISTORY);
        }
      }
    }
    for (const pullKey of Object.keys(state.readVersions)) {
      if (!retainedPullKeys.has(pullKey)) delete state.readVersions[pullKey];
    }
    const terminalJobIds = state.jobOrder.filter((id) => (
      state.jobs[id] && !['pending', 'running'].includes(state.jobs[id].status)
    ));
    const obsoleteJobs = new Set(
      terminalJobIds.slice(0, Math.max(0, terminalJobIds.length - MAX_TERMINAL_JOBS)),
    );
    for (const id of obsoleteJobs) delete state.jobs[id];
    if (obsoleteJobs.size) {
      state.jobOrder = state.jobOrder.filter((id) => !obsoleteJobs.has(id));
    }
  }

  #assertLease(job, workerId, fencingToken) {
    if (
      !job
      || job.status !== 'running'
      || !job.lease
      || job.lease.workerId !== workerId
      || job.lease.fencingToken !== fencingToken
      || job.lease.expiresAt <= this.clock()
    ) {
      throw staleFence();
    }
  }

  #assertJobLeaseGate(state, { jobId, workerId, fencingToken }) {
    this.#assertLease(state.jobs[jobId], workerId, fencingToken);
  }

  #assertSyncLeaseGate(state, {
    repositoryId,
    workerId,
    fencingToken,
  }) {
    const lease = state.syncLeases[repositoryId];
    if (
      !lease
      || lease.workerId !== workerId
      || lease.fencingToken !== fencingToken
      || lease.expiresAt <= this.clock()
    ) {
      throw staleFence('Sync lease уже принадлежит другому владельцу');
    }
  }

  async #lock() {
    return acquireKernelFileLock({
      lockPath: this.lockPath,
      timeoutMs: this.lockTimeoutMs,
      timeoutCode: 'REVIEW_STORE_LOCK_TIMEOUT',
      unavailableCode: 'REVIEW_STORE_LOCK_UNAVAILABLE',
      lostCode: 'REVIEW_STORE_LOCK_LOST',
      label: 'review store',
    });
  }

  async #writeAtomic(state, {
    assertHeld = () => {},
    assertCanCommit = () => {},
    expectedRevision,
    expectedAbsent = false,
  } = {}) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REVIEW_STATE_BYTES) {
      const error = new Error('Review store превышает безопасный лимит размера');
      error.code = 'REVIEW_STORE_SIZE_LIMIT';
      throw error;
    }
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      assertHeld();
      if (expectedAbsent) {
        let exists = false;
        try {
          await fs.access(this.filePath);
          exists = true;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (exists) {
          const error = new Error('Review store появился после потери lock');
          error.code = 'REVIEW_STORE_CAS_MISMATCH';
          throw error;
        }
      } else if (expectedRevision !== undefined) {
        let current;
        try {
          current = validateState(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
        } catch {
          const error = new Error('Review store изменился после потери lock');
          error.code = 'REVIEW_STORE_CAS_MISMATCH';
          throw error;
        }
        if (current.revision !== expectedRevision) {
          const error = new Error('Review store изменился после потери lock');
          error.code = 'REVIEW_STORE_CAS_MISMATCH';
          throw error;
        }
      }
      assertHeld();
      assertCanCommit();
      await fs.rename(temporary, this.filePath);
      assertHeld();
      try {
        const directory = await fs.open(path.dirname(this.filePath), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
