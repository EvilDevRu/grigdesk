import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ReviewStateStore,
  acceptReviewRunState,
  approveScopeState,
  completeBuildState,
  completeVerifyState,
  createReviewRunState,
  startBuildState,
  startVerifyState,
} from '../../server/src/lib/reviews/review-state-machine.js';
import { createReviewPublisher } from '../../server/src/lib/reviews/publisher.js';

function stateAt(status = 'accepted') {
  const input = {
    reviewRunId: 'rr-publish-contract',
    projectId: 'demo',
    repositoryId: 'frontend',
    prNumber: 17,
    snapshot: { digest: 'snap', version: 'v1', headSha: 'a'.repeat(40) },
    binding: {
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      headRepoUrl: '/tmp/fork.git',
      headRef: 'refs/heads/feature',
      headSha: 'a'.repeat(40),
    },
  };
  let state = createReviewRunState(input);
  state = approveScopeState(state, {
    scope: [{ itemKey: 'item-1', itemVersion: 'v1', action: 'fix' }],
    scopeVersion: 'scope-v1',
    actor: 'user',
  });
  if (status === 'approved') return state;
  state = startBuildState(state);
  state = completeBuildState(state, {
    candidateCommit: 'b'.repeat(40),
    candidateTree: 'c'.repeat(40),
    diff: { files: [] },
    worktreePath: '/tmp/worktree',
    candidateBranch: 'cockpit/review/rr-publish-contract',
  });
  state = startVerifyState(state);
  state = completeVerifyState(state, {
    report: {
      candidateCommit: 'b'.repeat(40),
      candidateTree: 'c'.repeat(40),
      passed: true,
      worktreeClean: true,
      commands: [{ id: 'test', required: true, ok: true, exitCode: 0 }],
    },
  });
  if (status === 'verified') return state;
  return acceptReviewRunState(state, { actor: 'user' });
}

test('PUBLISH-01: прямой publish до приёмки отклоняется до обращения к Git', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-publish-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStateStore({ stateDir: root });
  const state = stateAt('verified');
  await store.create(state);
  let gitCalls = 0;
  const publisher = createReviewPublisher({
    store,
    git: async () => {
      gitCalls += 1;
      throw new Error('Git не должен вызываться');
    },
  });

  await assert.rejects(
    publisher.publish({
      reviewRunId: state.reviewRunId,
      acceptanceDigest: 'поддельный',
      actor: 'user',
    }),
    (error) => error.code === 'ACCEPTANCE_REQUIRED',
  );
  assert.equal(gitCalls, 0);
});

test('PUBLISH-02/PUBLISH-06: durable operation идемпотентна и unknown сначала reconciles', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-publish-op-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStateStore({ stateDir: root });
  const accepted = stateAt();
  await store.create(accepted);
  let remote = accepted.binding.headSha;
  let pushes = 0;
  const git = async (_cwd, args) => {
    if (args[0] === 'rev-parse') {
      if (args[1].endsWith('^{tree}')) return { stdout: `${accepted.candidate.tree}\n` };
      return { stdout: `${accepted.candidate.commit}\n` };
    }
    if (args[0] === 'status') return { stdout: '' };
    if (args[0] === 'merge-base') return { stdout: '' };
    if (args[0] === 'ls-remote') return { stdout: `${remote}\t${accepted.binding.headRef}\n` };
    if (args[0] === 'push') {
      pushes += 1;
      remote = accepted.candidate.commit;
      const error = new Error('Соединение потеряно после записи ref');
      error.code = 'ECONNRESET';
      throw error;
    }
    throw new Error(`Неожиданная git-команда: ${args.join(' ')}`);
  };
  const publisher = createReviewPublisher({ store, git });

  const first = await publisher.publish({
    reviewRunId: accepted.reviewRunId,
    acceptanceDigest: accepted.acceptance.digest,
    actor: 'user',
    operationId: 'publish-op-1',
  });
  assert.equal(first.status, 'published');
  assert.equal(first.publication.reconciled, true);
  assert.equal(pushes, 1);

  const second = await publisher.publish({
    reviewRunId: accepted.reviewRunId,
    acceptanceDigest: accepted.acceptance.digest,
    actor: 'user',
    operationId: 'publish-op-2',
  });
  assert.equal(second.status, 'published');
  assert.equal(second.publication.id, 'publish-op-1');
  assert.equal(pushes, 1);
});

test('PUBLISH-05: CAS-гонка переводит запуск в stale и не повторяет push', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-publish-cas-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStateStore({ stateDir: root });
  const accepted = stateAt();
  await store.create(accepted);
  const otherSha = 'd'.repeat(40);
  let remote = accepted.binding.headSha;
  let pushes = 0;
  const git = async (_cwd, args) => {
    if (args[0] === 'rev-parse') return {
      stdout: `${args[1].endsWith('^{tree}') ? accepted.candidate.tree : accepted.candidate.commit}\n`,
    };
    if (args[0] === 'status') return { stdout: '' };
    if (args[0] === 'merge-base') return { stdout: '' };
    if (args[0] === 'ls-remote') return { stdout: `${remote}\t${accepted.binding.headRef}\n` };
    if (args[0] === 'push') {
      pushes += 1;
      const error = new Error('non-fast-forward');
      error.exitCode = 1;
      throw error;
    }
    throw new Error(`Неожиданная git-команда: ${args.join(' ')}`);
  };
  const publisher = createReviewPublisher({
    store,
    git,
    beforePush: async () => {
      remote = otherSha;
    },
  });

  const result = await publisher.publish({
    reviewRunId: accepted.reviewRunId,
    acceptanceDigest: accepted.acceptance.digest,
    actor: 'user',
  });
  assert.equal(result.status, 'stale');
  assert.equal(result.publication.reason, 'remote_head_changed');
  assert.equal(pushes, 1);
});

test('PUBLISH-02: два одновременных запроса используют одну durable operation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-publish-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStateStore({ stateDir: root });
  const accepted = stateAt();
  await store.create(accepted);
  let remote = accepted.binding.headSha;
  let pushes = 0;
  let enterPush;
  let releasePush;
  const entered = new Promise((resolve) => { enterPush = resolve; });
  const barrier = new Promise((resolve) => { releasePush = resolve; });
  const git = async (_cwd, args) => {
    if (args[0] === 'rev-parse') return {
      stdout: `${args[1].endsWith('^{tree}') ? accepted.candidate.tree : accepted.candidate.commit}\n`,
    };
    if (args[0] === 'status') return { stdout: '' };
    if (args[0] === 'merge-base') return { stdout: '' };
    if (args[0] === 'ls-remote') return {
      stdout: `${remote}\t${accepted.binding.headRef}\n`,
    };
    if (args[0] === 'push') {
      pushes += 1;
      remote = accepted.candidate.commit;
      return { stdout: 'ok\n' };
    }
    throw new Error(`Неожиданная git-команда: ${args.join(' ')}`);
  };
  const publisher = createReviewPublisher({
    store,
    git,
    beforePush: async () => {
      enterPush();
      await barrier;
    },
  });
  const first = publisher.publish({
    reviewRunId: accepted.reviewRunId,
    acceptanceDigest: accepted.acceptance.digest,
    actor: 'user',
    operationId: 'one-durable-operation',
  });
  await entered;
  const second = await publisher.publish({
    reviewRunId: accepted.reviewRunId,
    acceptanceDigest: accepted.acceptance.digest,
    actor: 'user',
    operationId: 'must-not-be-created',
  });
  assert.equal(second.status, 'publishing');
  assert.equal(second.publication.id, 'one-durable-operation');
  releasePush();
  const completed = await first;
  assert.equal(completed.status, 'published');
  assert.equal(pushes, 1);
});

test('PUBLISH-06: unknown не повторяет push без явной ручной команды', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-publish-unknown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStateStore({ stateDir: root });
  const accepted = stateAt();
  await store.create(accepted);
  let remote = accepted.binding.headSha;
  let pushes = 0;
  let failPush = true;
  const git = async (_cwd, args) => {
    if (args[0] === 'rev-parse') return {
      stdout: `${args[1].endsWith('^{tree}') ? accepted.candidate.tree : accepted.candidate.commit}\n`,
    };
    if (args[0] === 'status') return { stdout: '' };
    if (args[0] === 'merge-base') return { stdout: '' };
    if (args[0] === 'ls-remote') return {
      stdout: `${remote}\t${accepted.binding.headRef}\n`,
    };
    if (args[0] === 'push') {
      pushes += 1;
      if (failPush) throw new Error('Ответ от remote потерян');
      remote = accepted.candidate.commit;
      return { stdout: 'ok\n' };
    }
    throw new Error(`Неожиданная git-команда: ${args.join(' ')}`);
  };
  const publisher = createReviewPublisher({ store, git });
  const first = await publisher.publish({
    reviewRunId: accepted.reviewRunId,
    acceptanceDigest: accepted.acceptance.digest,
    actor: 'user',
  });
  assert.equal(first.status, 'publication_unknown');
  assert.equal(pushes, 1);

  const reconciled = await publisher.publish({
    reviewRunId: accepted.reviewRunId,
    acceptanceDigest: accepted.acceptance.digest,
    actor: 'user',
  });
  assert.equal(reconciled.status, 'publication_unknown');
  assert.equal(pushes, 1);

  failPush = false;
  const retried = await publisher.publish({
    reviewRunId: accepted.reviewRunId,
    acceptanceDigest: accepted.acceptance.digest,
    actor: 'user',
    retryUnknown: true,
  });
  assert.equal(retried.status, 'published');
  assert.equal(pushes, 2);
});

test('PUBLISH-08: отсутствующий remote ref становится stale без попытки push', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-publish-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStateStore({ stateDir: root });
  const accepted = stateAt();
  await store.create(accepted);
  let pushes = 0;
  const publisher = createReviewPublisher({
    store,
    git: async (_cwd, args) => {
      if (args[0] === 'rev-parse') return {
        stdout: `${args[1].endsWith('^{tree}') ? accepted.candidate.tree : accepted.candidate.commit}\n`,
      };
      if (args[0] === 'status' || args[0] === 'merge-base') return { stdout: '' };
      if (args[0] === 'ls-remote') {
        const error = new Error('remote ref отсутствует');
        error.result = { exitCode: 2, stdout: '', stderr: '' };
        throw error;
      }
      if (args[0] === 'push') pushes += 1;
      return { stdout: '' };
    },
  });

  const result = await publisher.publish({
    reviewRunId: accepted.reviewRunId,
    acceptanceDigest: accepted.acceptance.digest,
    actor: 'user',
  });
  assert.equal(result.status, 'stale');
  assert.equal(result.publication.reason, 'remote_ref_missing');
  assert.equal(pushes, 0);
});

test('PUBLISH-08: доказанный отказ push-доступа становится blocked, а не unknown', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-publish-denied-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStateStore({ stateDir: root });
  const accepted = stateAt();
  await store.create(accepted);
  const publisher = createReviewPublisher({
    store,
    git: async (_cwd, args) => {
      if (args[0] === 'rev-parse') return {
        stdout: `${args[1].endsWith('^{tree}') ? accepted.candidate.tree : accepted.candidate.commit}\n`,
      };
      if (args[0] === 'status' || args[0] === 'merge-base') return { stdout: '' };
      if (args[0] === 'ls-remote') {
        return { stdout: `${accepted.binding.headSha}\t${accepted.binding.headRef}\n` };
      }
      if (args[0] === 'push') {
        const error = new Error('ERROR: Permission to owner/repo.git denied to alice.');
        error.result = { exitCode: 128, stderr: error.message };
        throw error;
      }
      throw new Error(`Неожиданная git-команда: ${args.join(' ')}`);
    },
  });

  const result = await publisher.publish({
    reviewRunId: accepted.reviewRunId,
    acceptanceDigest: accepted.acceptance.digest,
    actor: 'user',
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.publication.reason, 'push_access_denied');
});

test('PUBLISH-02: heartbeat удерживает publisher lease во время freshness gate', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-publish-heartbeat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStateStore({ stateDir: root });
  const accepted = stateAt();
  await store.create(accepted);
  let releaseFreshness;
  let freshnessStarted;
  const started = new Promise((resolve) => { freshnessStarted = resolve; });
  const barrier = new Promise((resolve) => { releaseFreshness = resolve; });
  let remote = accepted.binding.headSha;
  const publisher = createReviewPublisher({
    store,
    leaseTtlMs: 90,
    beforePush: async () => {
      freshnessStarted();
      await barrier;
    },
    git: async (_cwd, args) => {
      if (args[0] === 'rev-parse') return {
        stdout: `${args[1].endsWith('^{tree}') ? accepted.candidate.tree : accepted.candidate.commit}\n`,
      };
      if (args[0] === 'status' || args[0] === 'merge-base') return { stdout: '' };
      if (args[0] === 'ls-remote') {
        return { stdout: `${remote}\t${accepted.binding.headRef}\n` };
      }
      if (args[0] === 'push') {
        remote = accepted.candidate.commit;
        return { stdout: 'ok\n' };
      }
      throw new Error(`Неожиданная git-команда: ${args.join(' ')}`);
    },
  });
  const publishing = publisher.publish({
    reviewRunId: accepted.reviewRunId,
    acceptanceDigest: accepted.acceptance.digest,
    actor: 'user',
  });
  await started;
  await new Promise((resolve) => setTimeout(resolve, 160));
  await assert.rejects(
    store.acquireLease(accepted.reviewRunId, {
      owner: 'competing-publisher',
      ttlMs: 90,
    }),
    (error) => error.code === 'LEASE_BUSY',
  );
  releaseFreshness();
  assert.equal((await publishing).status, 'published');
});
