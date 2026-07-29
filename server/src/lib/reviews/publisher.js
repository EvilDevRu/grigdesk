// Единственная host-side точка публикации review-кандидата.
// Агент её не получает: здесь повторно проверяются acceptance, Git tree и remote CAS.
import crypto from 'node:crypto';

import {
  REVIEW_RUN_STATES,
  ReviewStateError,
  completePublicationState,
  isSafeHeadRepoUrl,
  startPublicationState,
  validateReadyToPublish,
} from './review-state-machine.js';
import { defaultGit } from './runner.js';

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const HEAD_REF = /^refs\/heads\/.+/;

function publicationError(code, message, details) {
  return new ReviewStateError(code, message, details);
}

function ownerId() {
  return `publisher-${process.pid}-${crypto.randomUUID()}`;
}

function operationId() {
  return `publish-${crypto.randomUUID()}`;
}

function normalized(result) {
  if (typeof result === 'string') return { stdout: result, stderr: '', exitCode: 0 };
  return {
    stdout: String(result?.stdout ?? result?.out ?? ''),
    stderr: String(result?.stderr ?? result?.err ?? ''),
    exitCode: Number(result?.exitCode ?? result?.code ?? 0),
  };
}

function remoteSha(output, expectedRef) {
  for (const line of String(output || '').split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === expectedRef && SHA.test(sha || '')) return sha.toLowerCase();
  }
  return null;
}

function pushAccessDenied(error) {
  const text = `${error?.message || ''}\n${error?.result?.stderr || ''}`.toLowerCase();
  return /(?:permission denied|permission to .+ denied|authentication failed|write access.+denied|http 403|returned error: 403|not permitted to update|authorization failed)/.test(text);
}

export function createReviewPublisher({
  store,
  git: injectedGit,
  gitBin = 'git',
  beforePush = null,
  now = Date.now,
  leaseTtlMs = 10 * 60_000,
} = {}) {
  if (!store
      || typeof store.load !== 'function'
      || typeof store.update !== 'function'
      || typeof store.acquireLease !== 'function'
      || typeof store.renewLease !== 'function') {
    throw publicationError('PUBLISH_STORE_INVALID', 'Publisher требует ReviewStateStore');
  }
  const git = injectedGit
    ? async (cwd, args, options) => normalized(await injectedGit(cwd, args, options))
    : async (cwd, args, options = {}) => defaultGit(cwd, args, { ...options, gitBin });

  async function lsRemote(state) {
    const { headRepoUrl, headRef } = state.binding;
    if (!isSafeHeadRepoUrl(headRepoUrl)
        || !HEAD_REF.test(headRef || '')) {
      throw publicationError('PUBLISH_BINDING_INVALID', 'Небезопасная Git-привязка');
    }
    let result;
    try {
      result = await git(state.binding.worktreePath, [
        'ls-remote',
        '--exit-code',
        headRepoUrl,
        headRef,
      ], { timeout: 60_000, network: true });
    } catch (error) {
      // `git ls-remote --exit-code` использует 2 именно для отсутствующего ref.
      // Это известное состояние, а не «сеть неизвестна».
      if (Number(error?.result?.exitCode ?? error?.exitCode) === 2) return null;
      throw error;
    }
    return remoteSha(result.stdout, headRef);
  }

  function startLeaseHeartbeat(reviewRunId, lease) {
    const state = { stopped: false, error: null, pending: Promise.resolve() };
    const renew = () => {
      if (state.stopped) return state.pending;
      state.pending = state.pending.then(() => store.renewLease(reviewRunId, {
        owner: lease.owner,
        fencingToken: lease.fencingToken,
        now,
        ttlMs: leaseTtlMs,
      })).catch((error) => {
        state.error = error;
      });
      return state.pending;
    };
    const timer = setInterval(
      renew,
      Math.max(25, Math.min(60_000, Math.floor(leaseTtlMs / 3))),
    );
    timer.unref?.();
    return {
      assertOwned: async () => {
        await renew();
        if (state.error) throw state.error;
      },
      stop: async () => {
        state.stopped = true;
        clearInterval(timer);
        await state.pending;
      },
    };
  }

  async function validateLocalCandidate(state) {
    validateReadyToPublish(state, {
      acceptanceDigest: state.acceptance.digest,
    });
    const cwd = state.binding.worktreePath;
    if (!cwd) throw publicationError('WORKTREE_REQUIRED', 'Не найден candidate worktree');
    const [commitResult, treeResult, headResult, statusResult] = await Promise.all([
      git(cwd, ['rev-parse', `${state.candidate.commit}^{commit}`]),
      git(cwd, ['rev-parse', `${state.candidate.commit}^{tree}`]),
      git(cwd, ['rev-parse', 'HEAD']),
      git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
    ]);
    const commit = commitResult.stdout.trim().toLowerCase();
    const tree = treeResult.stdout.trim().toLowerCase();
    const head = headResult.stdout.trim().toLowerCase();
    if (commit !== state.candidate.commit
        || tree !== state.candidate.tree
        || head !== state.candidate.commit
        || statusResult.stdout.trim()) {
      throw publicationError('CANDIDATE_CHANGED', 'Локальный candidate не совпадает с приёмкой');
    }
    try {
      await git(cwd, [
        'merge-base',
        '--is-ancestor',
        state.binding.headSha,
        state.candidate.commit,
      ]);
    } catch {
      throw publicationError(
        'CANDIDATE_NOT_FAST_FORWARD',
        'Candidate не является продолжением exact PR head',
      );
    }
  }

  async function finish(reviewRunId, lease, result) {
    return store.update(reviewRunId, (state) => completePublicationState(state, result, { now }), {
      owner: lease.owner,
      fencingToken: lease.fencingToken,
    });
  }

  async function blockPreflight(reviewRunId, lease, error) {
    return store.update(reviewRunId, (state) => {
      state.status = REVIEW_RUN_STATES.BLOCKED;
      state.failure = {
        code: error?.code || 'PUBLISH_PREFLIGHT_FAILED',
        message: String(error?.message || 'Локальный candidate недоступен').slice(0, 2_000),
        detectedAt: Number(typeof now === 'function' ? now() : now),
      };
      state.acceptance = null;
      state.publication = null;
      return state;
    }, {
      owner: lease.owner,
      fencingToken: lease.fencingToken,
    });
  }

  async function release(reviewRunId, lease, heartbeat = null) {
    await heartbeat?.stop?.();
    try {
      return await store.releaseLease(reviewRunId, {
        owner: lease.owner,
        fencingToken: lease.fencingToken,
        now,
      });
    } catch (error) {
      if (error?.code === 'FENCING_TOKEN_STALE') return store.load(reviewRunId);
      throw error;
    }
  }

  async function reconcileClaimed(state, lease, heartbeat = null) {
    const id = state.publication.id;
    let remote;
    try {
      remote = await lsRemote(state);
    } catch (error) {
      const unknown = await finish(state.reviewRunId, lease, {
        operationId: id,
        status: 'unknown',
        reason: 'remote_unavailable',
        error: error.message,
      });
      await release(state.reviewRunId, lease, heartbeat);
      return store.load(unknown.reviewRunId);
    }
    let result;
    if (remote === state.candidate.commit) {
      result = {
        operationId: id,
        status: 'published',
        reason: 'remote_matches_candidate',
        remoteSha: remote,
        reconciled: true,
      };
    } else if (remote !== state.publication.expectedRemoteSha) {
      result = {
        operationId: id,
        status: 'stale',
        reason: remote ? 'remote_head_changed' : 'remote_ref_missing',
        remoteSha: remote,
        reconciled: true,
      };
    } else {
      result = {
        operationId: id,
        status: 'unknown',
        reason: 'push_result_unknown',
        remoteSha: remote,
        reconciled: true,
      };
    }
    await finish(state.reviewRunId, lease, result);
    await release(state.reviewRunId, lease, heartbeat);
    return store.load(state.reviewRunId);
  }

  async function publish({
    reviewRunId,
    acceptanceDigest,
    actor,
    operationId: requestedOperationId,
    retryUnknown = false,
  }) {
    let initial = await store.load(reviewRunId);
    if (initial.status === REVIEW_RUN_STATES.PUBLISHED) {
      validateReadyToPublish(initial, { acceptanceDigest });
      return initial;
    }
    validateReadyToPublish(initial, { acceptanceDigest });
    const owner = ownerId();
    let claimed;
    try {
      claimed = await store.acquireLease(reviewRunId, {
        owner,
        now,
        ttlMs: leaseTtlMs,
      });
    } catch (error) {
      if (error?.code !== 'LEASE_BUSY') throw error;
      // Вторая HTTP-команда видит уже durable operation и не создаёт новую.
      const current = await store.load(reviewRunId);
      if (current.publication) return current;
      throw error;
    }
    const lease = claimed.lease;
    const heartbeat = startLeaseHeartbeat(reviewRunId, lease);
    try {
      initial = claimed;
      validateReadyToPublish(initial, { acceptanceDigest });
      if (initial.publication) {
        if (![REVIEW_RUN_STATES.PUBLISHING, REVIEW_RUN_STATES.PUBLICATION_UNKNOWN]
          .includes(initial.status)) {
          await release(reviewRunId, lease, heartbeat);
          return initial;
        }
        if (retryUnknown !== true) return reconcileClaimed(initial, lease, heartbeat);

        // Ручной retry сначала доказывает, что remote всё ещё на исходном SHA.
        // Только после этого продолжается та же durable operation.
        let observed;
        try {
          observed = await lsRemote(initial);
        } catch (error) {
          await finish(reviewRunId, lease, {
            operationId: initial.publication.id,
            status: 'unknown',
            reason: 'remote_unavailable',
            error: error.message,
          });
          await release(reviewRunId, lease, heartbeat);
          return store.load(reviewRunId);
        }
        if (observed === initial.candidate.commit) {
          await finish(reviewRunId, lease, {
            operationId: initial.publication.id,
            status: 'published',
            reason: 'remote_matches_candidate',
            remoteSha: observed,
            reconciled: true,
          });
          await release(reviewRunId, lease, heartbeat);
          return store.load(reviewRunId);
        }
        if (observed !== initial.publication.expectedRemoteSha) {
          await finish(reviewRunId, lease, {
            operationId: initial.publication.id,
            status: 'stale',
            reason: observed ? 'remote_head_changed' : 'remote_ref_missing',
            remoteSha: observed,
            reconciled: true,
          });
          await release(reviewRunId, lease, heartbeat);
          return store.load(reviewRunId);
        }
        initial = await store.update(reviewRunId, (state) => {
          state.status = REVIEW_RUN_STATES.PUBLISHING;
          state.publication.status = 'running';
          state.publication.retryCount = Number(state.publication.retryCount || 0) + 1;
          state.publication.lastRetryAt = Number(typeof now === 'function' ? now() : now);
          return state;
        }, {
          owner: lease.owner,
          fencingToken: lease.fencingToken,
        });
      }
      try {
        await validateLocalCandidate(initial);
      } catch (error) {
        await blockPreflight(reviewRunId, lease, error);
        await release(reviewRunId, lease, heartbeat);
        return store.load(reviewRunId);
      }
      const id = initial.publication?.id || requestedOperationId || operationId();
      let state = initial.publication
        ? initial
        : await store.update(reviewRunId, (current) => startPublicationState(current, {
          operationId: id,
          acceptanceDigest,
          actor,
        }, { now }), {
          owner: lease.owner,
          fencingToken: lease.fencingToken,
        });
      const before = await lsRemote(state);
      if (before !== state.binding.headSha) {
        await finish(reviewRunId, lease, {
          operationId: id,
          status: 'stale',
          reason: before ? 'remote_head_changed' : 'remote_ref_missing',
          remoteSha: before,
          reconciled: true,
        });
        await release(reviewRunId, lease, heartbeat);
        return store.load(reviewRunId);
      }
      if (beforePush) {
        try {
          await beforePush(structuredClone(state));
        } catch (error) {
          await finish(reviewRunId, lease, {
            operationId: id,
            status: 'stale',
            reason: error?.code || 'freshness_check_failed',
            error: String(error?.message || error).slice(0, 2_000),
          });
          await release(reviewRunId, lease, heartbeat);
          return store.load(reviewRunId);
        }
      }
      try {
        // Freshness и remote CAS отделены сетевыми вызовами. Прямо перед
        // внешним side effect обновляем lease и доказываем ownership.
        await heartbeat.assertOwned();
        await git(state.binding.worktreePath, [
          'push',
          '--porcelain',
          '--no-signed',
          '--no-follow-tags',
          '--recurse-submodules=no',
          // Обычный fast-forward push не защищает от rewind между ls-remote
          // и обновлением ref: candidate всё равно был бы потомком нового head.
          // Явное ожидание превращает серверное обновление в exact CAS.
          `--force-with-lease=${state.binding.headRef}:${state.publication.expectedRemoteSha}`,
          state.binding.headRepoUrl,
          `${state.candidate.commit}:${state.binding.headRef}`,
        ], { timeout: 120_000, network: true });
        await heartbeat.assertOwned();
        const confirmed = await lsRemote(state);
        await finish(reviewRunId, lease, confirmed === state.candidate.commit ? {
          operationId: id,
          status: 'published',
          reason: 'push_ok_remote_confirmed',
          remoteSha: confirmed,
          reconciled: true,
        } : {
          operationId: id,
          status: confirmed ? 'stale' : 'unknown',
          reason: confirmed ? 'remote_head_changed_after_push' : 'remote_unavailable_after_push',
          remoteSha: confirmed,
          reconciled: true,
        });
        await release(reviewRunId, lease, heartbeat);
        return store.load(reviewRunId);
      } catch (pushError) {
        // После ошибки нельзя слепо повторять push: сначала читаем exact remote ref.
        let after = null;
        try {
          after = await lsRemote(state);
        } catch {
          // Неизвестный результат сохраняется durable и ждёт нового reconcile.
        }
        if (after === state.candidate.commit) {
          await finish(reviewRunId, lease, {
            operationId: id,
            status: 'published',
            reason: 'remote_matches_candidate',
            remoteSha: after,
            reconciled: true,
          });
        } else if (after && after !== state.binding.headSha) {
          await finish(reviewRunId, lease, {
            operationId: id,
            status: 'stale',
            reason: 'remote_head_changed',
            remoteSha: after,
            reconciled: true,
            error: pushError.message,
          });
        } else if (pushAccessDenied(pushError) && after === state.binding.headSha) {
          await finish(reviewRunId, lease, {
            operationId: id,
            status: 'blocked',
            reason: 'push_access_denied',
            remoteSha: after,
            reconciled: true,
            error: pushError.message,
          });
        } else {
          await finish(reviewRunId, lease, {
            operationId: id,
            status: 'unknown',
            reason: 'push_result_unknown',
            remoteSha: after,
            error: pushError.message,
          });
        }
        await release(reviewRunId, lease, heartbeat);
        return store.load(reviewRunId);
      }
    } catch (error) {
      await release(reviewRunId, lease, heartbeat);
      throw error;
    }
  }

  async function reconcile({ reviewRunId, actor = 'system-reconcile' }) {
    const initial = await store.load(reviewRunId);
    if (initial.status === REVIEW_RUN_STATES.PUBLISHED) return initial;
    if (!initial.publication || ![
      REVIEW_RUN_STATES.PUBLISHING,
      REVIEW_RUN_STATES.PUBLICATION_UNKNOWN,
    ].includes(initial.status)) {
      throw publicationError('PUBLICATION_NOT_RECONCILABLE', 'Нет неизвестной операции');
    }
    const owner = `${ownerId()}-${actor}`;
    const claimed = await store.acquireLease(reviewRunId, {
      owner,
      now,
      ttlMs: leaseTtlMs,
    });
    const heartbeat = startLeaseHeartbeat(reviewRunId, claimed.lease);
    return reconcileClaimed(claimed, claimed.lease, heartbeat);
  }

  return Object.freeze({ publish, reconcile });
}

export async function publishReviewRun(options) {
  const { publisherOptions = {}, ...request } = options;
  return createReviewPublisher(publisherOptions).publish(request);
}
