import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ReviewStateError,
  ReviewStateStore,
  acceptReviewRunState,
  acquireLeaseState,
  approveScopeState,
  canonicalDigest,
  completeBuildState,
  completeVerifyState,
  createReviewRunState,
  reviewCriterionId,
  startBuildState,
  startVerifyState,
  validateReadyToPublish,
} from '../../server/src/lib/reviews/review-state-machine.js';

const baseInput = {
  reviewRunId: 'rr-018f-review-a',
  projectId: 'demo',
  repositoryId: 'frontend',
  prNumber: 17,
  snapshot: {
    digest: 'snapshot-v1',
    version: 'v1',
    headSha: 'a'.repeat(40),
  },
  binding: {
    repoPath: '/tmp/example-repo',
    headRepoUrl: '/tmp/fork.git',
    headRef: 'refs/heads/feature/review',
    headSha: 'a'.repeat(40),
  },
  reviewRoute: {
    schemaVersion: 1,
    source: 'factory-profile',
    profileId: 'demo',
    routeId: 'review',
    stages: ['BUILD', 'VERIFY', 'GATE_ACCEPT'],
    revision: `factory-review-route:v1:${'d'.repeat(64)}`,
  },
  verificationPolicy: {
    commands: ['npm test'],
    coversAllCriteria: true,
  },
};

const scope = [{
  itemKey: 'github:owner/repo:pr:17:thread:TR_1',
  itemVersion: 'v2',
  action: 'fix',
  instruction: 'Уточнить обработку пустого значения',
}];

function builtAndVerifiedState() {
  let state = createReviewRunState(baseInput, { now: 100 });
  state = approveScopeState(state, {
    scope,
    scopeVersion: 'scope-v1',
    actor: 'user-1',
  }, { now: 110 });
  state = startBuildState(state, { now: 120 });
  state = completeBuildState(state, {
    candidateCommit: 'b'.repeat(40),
    candidateTree: 'c'.repeat(40),
    diff: { files: [{ path: 'src/a.js', status: 'M' }], stat: '1 file changed' },
  }, { now: 130 });
  state = startVerifyState(state, { now: 140 });
  const criterionId = reviewCriterionId(state.scope[0]);
  state = completeVerifyState(state, {
    report: {
      schemaVersion: 2,
      candidateCommit: 'b'.repeat(40),
      candidateTree: 'c'.repeat(40),
      passed: true,
      commands: [{
        id: 'test',
        required: true,
        ok: true,
        effectiveOk: true,
        exitCode: 0,
      }],
      criteria: [{
        id: criterionId,
        itemKey: state.scope[0].itemKey,
        itemVersion: state.scope[0].itemVersion,
        acceptanceCriterion: state.scope[0].instruction,
        required: true,
        status: 'passed',
        commandIds: ['test'],
      }],
      worktreeClean: true,
    },
  }, { now: 150 });
  return state;
}

test('GATE-06: BUILD требует утверждённый scope именно текущей версии', () => {
  const initial = createReviewRunState(baseInput, { now: 100 });

  assert.throws(
    () => startBuildState(initial),
    (error) => error instanceof ReviewStateError && error.code === 'SCOPE_APPROVAL_REQUIRED',
  );

  const approved = approveScopeState(initial, {
    scope,
    scopeVersion: 'scope-v1',
    actor: 'user-1',
  }, { now: 110 });
  const tampered = {
    ...approved,
    scope: [{ ...scope[0], instruction: 'Другая инструкция' }],
  };
  assert.throws(
    () => startBuildState(tampered),
    (error) => error.code === 'SCOPE_APPROVAL_STALE',
  );
});

test('GATE-03/GATE-05: продуктовый вопрос и неявный пункт не получают пишущих прав', () => {
  const initial = createReviewRunState(baseInput);
  assert.throws(
    () => approveScopeState(initial, {
      scope: [{ ...scope[0], action: 'decision_required' }],
      scopeVersion: 'scope-v1',
      actor: 'user-1',
    }),
    (error) => error.code === 'SCOPE_NOT_WRITABLE',
  );
  assert.throws(
    () => approveScopeState(initial, {
      scope: [],
      scopeVersion: 'scope-v1',
      actor: 'user-1',
    }),
    (error) => error.code === 'SCOPE_EMPTY',
  );
});

test('GATE-07/GATE-08: приёмка связана со snapshot, scope, tree и VERIFY', () => {
  const verified = builtAndVerifiedState();
  const accepted = acceptReviewRunState(verified, { actor: 'user-1' }, { now: 160 });

  assert.equal(validateReadyToPublish(accepted, {
    acceptanceDigest: accepted.acceptance.digest,
  }), true);

  for (const changed of [
    { ...accepted, snapshot: { ...accepted.snapshot, digest: 'snapshot-v2' } },
    { ...accepted, scope: [{ ...accepted.scope[0], instruction: 'Изменено' }] },
    {
      ...accepted,
      reviewRoute: {
        ...accepted.reviewRoute,
        revision: `factory-review-route:v1:${'e'.repeat(64)}`,
      },
    },
    {
      ...accepted,
      verificationPolicy: {
        ...accepted.verificationPolicy,
        commands: ['npm run test:changed'],
      },
    },
    { ...accepted, candidate: { ...accepted.candidate, tree: 'd'.repeat(40) } },
    {
      ...accepted,
      verify: {
        ...accepted.verify,
        report: { ...accepted.verify.report, commands: [] },
      },
    },
  ]) {
    assert.throws(
      () => validateReadyToPublish(changed, {
        acceptanceDigest: accepted.acceptance.digest,
      }),
      (error) => error.code === 'ACCEPTANCE_STALE',
    );
  }
});

test('VERIFY-03 VERIFY-04: обязательный acceptance criterion без доказательства fail-closed', () => {
  const verified = builtAndVerifiedState();
  const verifying = {
    ...verified,
    status: 'verifying',
    verify: null,
  };
  const unchecked = completeVerifyState(verifying, {
    report: {
      ...verified.verify.report,
      passed: true,
      criteria: [],
    },
  }, { now: 151 });

  assert.equal(unchecked.status, 'verification_failed');
  assert.equal(unchecked.verify.passed, false);
  assert.throws(
    () => acceptReviewRunState(unchecked, { actor: 'user-1' }),
    (error) => error.code === 'VERIFY_REQUIRED',
  );
});

test('VERIFY-05: критерий не принимает ссылку на отсутствующую или красную команду', () => {
  const verified = builtAndVerifiedState();
  const verifying = {
    ...verified,
    status: 'verifying',
    verify: null,
  };
  const criterion = verified.verify.report.criteria[0];

  for (const report of [
    {
      ...verified.verify.report,
      commands: [],
      criteria: [{ ...criterion, commandIds: ['missing'] }],
    },
    {
      ...verified.verify.report,
      commands: [{
        id: 'test',
        required: true,
        ok: false,
        effectiveOk: false,
        exitCode: 1,
      }],
      criteria: [criterion],
    },
  ]) {
    const failed = completeVerifyState(verifying, {
      report: { ...report, passed: true },
    });
    assert.equal(failed.status, 'verification_failed');
    assert.equal(failed.verify.passed, false);
  }
});

test('RUN-03/RUN-08: старый fencing token не может записать поздний результат', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStateStore({ stateDir: root, now: () => 1_000 });
  const initial = createReviewRunState(baseInput, { now: 100 });
  await store.create(initial);

  const first = await store.acquireLease(initial.reviewRunId, {
    owner: 'worker-a',
    now: 1_000,
    ttlMs: 10,
  });
  const second = await store.acquireLease(initial.reviewRunId, {
    owner: 'worker-b',
    now: 1_011,
    ttlMs: 100,
  });
  assert.ok(second.lease.fencingToken > first.lease.fencingToken);

  await assert.rejects(
    store.update(initial.reviewRunId, (state) => ({ ...state, status: 'failed' }), {
      owner: 'worker-a',
      fencingToken: first.lease.fencingToken,
    }),
    (error) => error.code === 'FENCING_TOKEN_STALE',
  );
  const current = await store.load(initial.reviewRunId);
  assert.equal(current.lease.owner, 'worker-b');
  assert.notEqual(current.status, 'failed');
});

test('RB-03 RUN-08: истёкший lease не может записать результат без нового владельца', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-expired-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const store = new ReviewStateStore({ stateDir: root, now: () => now });
  const initial = createReviewRunState(baseInput, { now: 100 });
  await store.create(initial);
  const claimed = await store.acquireLease(initial.reviewRunId, {
    owner: 'frozen-worker',
    now,
    ttlMs: 10,
  });
  now = 1_011;

  await assert.rejects(
    store.update(initial.reviewRunId, (state) => ({ ...state, status: 'failed' }), {
      owner: 'frozen-worker',
      fencingToken: claimed.lease.fencingToken,
    }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.equal((await store.load(initial.reviewRunId)).status, initial.status);
});

test('RB-03 RUN-08: lease, истёкший внутри async mutator, не проходит commit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-lease-toctou-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const store = new ReviewStateStore({ stateDir: root, now: () => now });
  const initial = createReviewRunState(baseInput, { now: 100 });
  await store.create(initial);
  const claimed = await store.acquireLease(initial.reviewRunId, {
    owner: 'slow-worker',
    now,
    ttlMs: 10,
  });

  await assert.rejects(
    store.update(initial.reviewRunId, async (state) => {
      now = 1_011;
      state.status = 'failed';
      return state;
    }, {
      owner: 'slow-worker',
      fencingToken: claimed.lease.fencingToken,
    }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.equal((await store.load(initial.reviewRunId)).status, initial.status);
});

test('RB-03 RUN-08: expiry проверяется непосредственно перед atomic rename', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-lease-final-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  let finalGateMode = false;
  const now = () => {
    if (!finalGateMode) return 1_000;
    calls += 1;
    return calls < 3 ? 1_000 : 1_011;
  };
  const store = new ReviewStateStore({ stateDir: root, now });
  const initial = createReviewRunState(baseInput, { now: 100 });
  await store.create(initial);
  const claimed = await store.acquireLease(initial.reviewRunId, {
    owner: 'slow-fsync-worker',
    now: 1_000,
    ttlMs: 10,
  });
  finalGateMode = true;

  await assert.rejects(
    store.update(initial.reviewRunId, (state) => ({ ...state, status: 'failed' }), {
      owner: 'slow-fsync-worker',
      fencingToken: claimed.lease.fencingToken,
    }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.equal((await store.load(initial.reviewRunId)).status, initial.status);
});

test('RUN-08: durable state пишется атомарно и повреждение не маскируется', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-atomic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStateStore({ stateDir: root });
  const initial = createReviewRunState(baseInput);
  await store.create(initial);
  const saved = await store.load(initial.reviewRunId);
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.revision, 0);

  const statePath = store.pathFor(initial.reviewRunId);
  const raw = await readFile(statePath, 'utf8');
  assert.deepEqual(JSON.parse(raw), saved);
  assert.equal(canonicalDigest({ b: 2, a: 1 }), canonicalDigest({ a: 1, b: 2 }));

  await writeFile(statePath, '{bad json');
  await assert.rejects(
    store.load(initial.reviewRunId),
    (error) => error.code === 'STATE_CORRUPT',
  );
});

test('RUN-04: ReviewStateStore использует kernel flock и fail-closed без него', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-flock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new ReviewStateStore({ stateDir: root, lockTimeoutMs: 1_000 });
  const second = new ReviewStateStore({ stateDir: root, lockTimeoutMs: 20 });
  const initial = createReviewRunState(baseInput);
  await first.create(initial);

  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const holder = first.update(initial.reviewRunId, async (state) => {
    entered();
    await releasePromise;
    return state;
  });
  await enteredPromise;
  await assert.rejects(
    second.update(initial.reviewRunId, (state) => state),
    (error) => error.code === 'STATE_LOCK_TIMEOUT',
  );
  release();
  await holder;

  const unavailable = new ReviewStateStore({
    stateDir: path.join(root, 'unavailable'),
    lockBinary: path.join(root, 'missing-flock'),
  });
  await assert.rejects(
    unavailable.create(createReviewRunState({
      ...baseInput,
      reviewRunId: 'rr-flock-unavailable',
    })),
    (error) => error.code === 'STATE_LOCK_UNAVAILABLE',
  );
});

test('STATE-LOCK-LOST: parent fd удерживает kernel lock до commit run state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-state-lock-lost-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = createReviewRunState(baseInput);
  const first = new ReviewStateStore({ stateDir: root });
  const second = new ReviewStateStore({
    stateDir: root,
    lockTimeoutMs: 20,
  });
  await first.create(initial);
  let entered;
  let release;
  const inside = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const holder = first.update(initial.reviewRunId, async (state) => {
    entered();
    await barrier;
    state.status = 'failed';
    return state;
  });
  await inside;
  await assert.rejects(
    second.update(initial.reviewRunId, (state) => ({ ...state, status: 'blocked' })),
    (error) => error.code === 'STATE_LOCK_TIMEOUT',
  );
  release();
  await holder;
  const persisted = await first.load(initial.reviewRunId);
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.revision, 1);
});

test('lease pure transition monotonically increases fencing token', () => {
  const initial = createReviewRunState(baseInput);
  const first = acquireLeaseState(initial, {
    owner: 'a',
    now: 100,
    ttlMs: 10,
  });
  assert.throws(
    () => acquireLeaseState(first, { owner: 'b', now: 105, ttlMs: 10 }),
    (error) => error.code === 'LEASE_BUSY',
  );
  const second = acquireLeaseState(first, {
    owner: 'b',
    now: 111,
    ttlMs: 10,
  });
  assert.equal(second.lease.fencingToken, first.lease.fencingToken + 1);
});
