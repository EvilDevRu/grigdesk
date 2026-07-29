import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ReviewControlStore } from '../../server/src/lib/reviews/control-store.js';
import { ReviewAnalysisQueue } from '../../server/src/lib/reviews/analyzer.js';
import { createRemarkIdentity, createRemarkVersion, snapshotKey } from '../../server/src/lib/reviews/identity.js';
import { ReviewService, parseReviewVerifyCommand } from '../../server/src/lib/reviews/service.js';
import { ReviewStore } from '../../server/src/lib/reviews/store.js';

const HEAD = 'a'.repeat(40);

function githubSnapshot() {
  const identity = createRemarkIdentity({
    repoNodeId: 'R_service',
    prNodeId: 'PR_service',
    kind: 'thread_comment',
    threadNodeId: 'T_service',
    commentNodeId: 'C_service',
  });
  const version = createRemarkVersion({
    ...identity,
    headSha: HEAD,
    state: 'open',
    updatedAt: '2026-07-29T12:00:00.000Z',
    body: 'Проверяй пустое значение до сохранения.',
  });
  return {
    repoNodeId: 'R_service',
    nameWithOwner: 'Example/Service',
    syncedAt: '2026-07-29T12:00:01.000Z',
    pullRequests: [{
      prNodeId: 'PR_service',
      number: 17,
      title: 'Validation',
      url: 'https://github.com/Example/Service/pull/17',
      state: 'open',
      updatedAt: '2026-07-29T12:00:00.000Z',
      headSha: HEAD,
      headRefName: 'review/input-validation',
      headRepositoryUrl: '/tmp/example-service-head.git',
      diff: 'diff --git a/src/input.js b/src/input.js\n',
      remarks: [{
        ...identity,
        ...version,
        body: 'Проверяй пустое значение до сохранения.',
        url: 'https://github.com/Example/Service/pull/17#discussion_r1',
        path: 'src/input.js',
        line: 12,
        actionable: true,
        authorAssociation: 'NONE',
      }],
    }],
  };
}

async function fixture(t, {
  beforeCreateRun = null,
  seedAnalysis = true,
  analysisQueueFactory = null,
  executorAvailable = true,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-service.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStore({ filePath: path.join(root, 'inbox.json') });
  const controlStore = new ReviewControlStore({ filePath: path.join(root, 'control.json') });
  await Promise.all([store.init(), controlStore.init()]);
  const snapshot = githubSnapshot();
  await store.applyRepositorySnapshot(snapshot);
  const remark = snapshot.pullRequests[0].remarks[0];
  if (seedAnalysis) await store.compareAndSetAnalysis({
    itemKey: remark.key,
    versionId: remark.versionId,
    headSha: HEAD,
    artifact: {
      analysisId: 'analysis:service-current',
      itemKey: remark.key,
      versionId: remark.versionId,
      headSha: HEAD,
      reviewerRequest: 'Добавить раннюю проверку пустого значения.',
      expectedChange: 'Сохранение не запускается для пустого значения.',
      verification: 'Unit-тест подтверждает отсутствие вызова save.',
      decisionId: 'FIX_RECOMMENDED',
      confidenceId: 'HIGH',
      evidence: [{ id: 'evidence:input', text: 'Ветка вызывает save', sourceRefs: ['src/input.js:12'] }],
      risks: [],
    },
  });

  let runState = null;
  let approvedInput = null;
  const sideEffects = {
    build: 0,
    verify: 0,
    accept: 0,
    publish: 0,
    reconcile: 0,
  };
  const runner = {
    store: {
      update: async (_id, mutator) => {
        runState = await mutator(structuredClone(runState));
        return structuredClone(runState);
      },
    },
    listRuns: async () => (runState ? [structuredClone(runState)] : []),
    createRun: async (input) => {
      if (beforeCreateRun) await beforeCreateRun(input);
      runState = {
        reviewRunId: input.reviewRunId,
        status: 'awaiting_scope',
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        prNumber: input.prNumber,
        snapshot: {
          headSha: input.headSha,
          digest: input.snapshotDigest,
          version: input.snapshotVersion,
        },
        reviewRoute: structuredClone(input.reviewRoute),
        verificationPolicy: structuredClone(input.verificationPolicy),
        binding: {
          repoPath: input.repoPath,
          headSha: input.headSha,
          headRef: input.headRef,
          headRepoUrl: input.headRepoUrl,
        },
        updatedAt: Date.now(),
      };
      return structuredClone(runState);
    },
    approveScope: async (_id, input) => {
      approvedInput = structuredClone(input);
      runState.status = 'approved';
      runState.scope = structuredClone(input.scope);
      runState.scopeApproval = {
        version: input.scopeVersion,
        actor: input.actor,
      };
      return structuredClone(runState);
    },
    build: async () => {
      sideEffects.build += 1;
      runState.status = 'built';
      return structuredClone(runState);
    },
    verify: async () => {
      sideEffects.verify += 1;
      runState.status = 'verified';
      return structuredClone(runState);
    },
    accept: async (_id, { actor }) => {
      sideEffects.accept += 1;
      runState.status = 'accepted';
      runState.acceptance = { digest: 'acceptance:service', actor };
      return structuredClone(runState);
    },
    abandon: async () => {
      runState.status = 'blocked';
      runState.failure = { code: 'RUN_ABANDONED' };
      return structuredClone(runState);
    },
    getRun: async () => {
      if (!runState) {
        const error = new Error('Run state ещё не создан');
        error.code = 'RUN_NOT_FOUND';
        throw error;
      }
      return structuredClone(runState);
    },
  };
  const repository = {
    id: 'binding-service',
    projectId: 'demo',
    repoKey: 'app',
    repoPath: root,
    slug: 'Example/Service',
    owner: 'Example',
    name: 'Service',
    confirmed: true,
    enabled: true,
    autoAnalyze: true,
    verifyCommands: ['npm test'],
    verifyCoversCriteria: true,
    factoryReviewExecutorAvailable: executorAvailable,
    reviewRoute: {
      schemaVersion: 1,
      source: 'factory-profile',
      profileId: 'demo',
      routeId: 'review',
      stages: ['BUILD', 'VERIFY', 'GATE_ACCEPT'],
      revision: `factory-review-route:v1:${'b'.repeat(64)}`,
    },
    credentialFingerprint: 'github-cli:default',
    runnerProjectId: 'project-demo',
    runnerRepositoryId: 'repository-service',
  };
  const analysisQueue = analysisQueueFactory
    ? analysisQueueFactory(store)
    : {};
  const service = new ReviewService({
    store,
    controlStore,
    watcher: { trigger: async () => ({ status: 'unchanged' }) },
    analysisQueue,
    translatorQueue: {},
    runner,
    publisher: {
      reconcile: async () => {
        sideEffects.reconcile += 1;
        runState.status = 'published';
        return structuredClone(runState);
      },
      publish: async () => {
        sideEffects.publish += 1;
        runState.status = 'published';
        return structuredClone(runState);
      },
    },
    repositoryProvider: async () => [structuredClone(repository)],
  });
  const pullId = snapshotKey(snapshot.repoNodeId, snapshot.pullRequests[0].prNodeId);
  return {
    service,
    store,
    controlStore,
    pullId,
    remark,
    approved: () => approvedInput,
    currentRun: () => structuredClone(runState),
    seedRun: (value) => { runState = structuredClone(value); },
    mutateRepository: (mutator) => mutator(repository),
    sideEffects,
  };
}

async function createQueuedRun(fx) {
  await fx.service.setScope(fx.pullId, [{
    remarkId: fx.remark.key,
    action: 'fix',
    acceptance: 'Unit-тест проходит',
    allowedPaths: ['src/input.js'],
  }]);
  // Запуск создаётся durable, но scheduler пока не получает очередь.
  fx.service.closed = true;
  return fx.service.run(fx.pullId);
}

test('QUEUE-FAIR-01: поток analysis не может бесконечно вытеснять translation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-fairness.'));
  const store = new ReviewStore({ filePath: path.join(root, 'inbox.json') });
  const controlStore = new ReviewControlStore({ filePath: path.join(root, 'control.json') });
  const order = [];
  let analyses = 4;
  let translations = 2;
  const service = new ReviewService({
    store,
    controlStore,
    watcher: {
      start: async () => {},
      stop: async () => {},
    },
    analysisQueue: {
      runNext: async () => {
        if (!analyses) return null;
        analyses -= 1;
        order.push('analysis');
        return { status: 'completed' };
      },
    },
    translatorQueue: {
      runNext: async () => {
        if (!translations) return null;
        translations -= 1;
        order.push('translation');
        return { status: 'completed' };
      },
    },
    runner: { listRuns: async () => [] },
    publisher: {},
    repositoryProvider: async () => [],
    modelConcurrency: 1,
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  await service.init();
  for (let attempt = 0; attempt < 20 && (analyses || translations); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await service.modelDrain;

  assert.deepEqual(order, [
    'analysis',
    'translation',
    'analysis',
    'translation',
    'analysis',
    'analysis',
  ]);
});

const immutableConfigurationChanges = [
  {
    name: 'Factory route revision',
    apply: (repository) => {
      repository.reviewRoute.revision = `factory-review-route:v1:${'c'.repeat(64)}`;
    },
  },
  {
    name: 'verification policy',
    apply: (repository) => {
      repository.verifyCommands = ['npm run test:review'];
    },
  },
];

test('SCOPE-04 RB-04: прямой service вызов не принимает fix без критерия готовности', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    fx.service.setScope(fx.pullId, [{
      remarkId: fx.remark.key,
      action: 'fix',
      acceptance: '',
    }]),
    (error) => error.code === 'SCOPE_ACCEPTANCE_REQUIRED',
  );
});

test('SEC-AUTO-04: manual_required виден человеку, ручной analyze создаёт job', async (t) => {
  const fx = await fixture(t, {
    seedAnalysis: false,
    analysisQueueFactory: (store) => new ReviewAnalysisQueue({
      store,
      model: { generate: async () => { throw new Error('Не должен запускаться в тесте'); } },
    }),
  });
  await fx.store.recordAutoAnalysisDeferral({
    items: [fx.remark],
    reason: 'untrusted_author',
    message: 'Нужен ручной запуск для внешнего автора',
  });

  let pull = (await fx.service.snapshot()).pulls[0];
  assert.equal(pull.remarks[0].analysisStatus, 'manual_required');
  assert.equal(pull.remarks[0].autoAnalysis.reason, 'untrusted_author');

  await fx.store.recordArtifactError({
    stage: 'analysis',
    itemKey: fx.remark.key,
    versionId: fx.remark.versionId,
    error: { code: 'ANALYSIS_FAILED', message: 'Предыдущая попытка упала' },
  });
  fx.service.closed = true;
  await fx.service.analyze(fx.pullId);
  const state = await fx.store.read();
  assert.equal(Object.values(state.jobs).some((job) => job.status === 'pending'), true);
  assert.equal(state.analyses[fx.remark.key]?.autoDeferred, undefined);
  pull = (await fx.service.snapshot()).pulls[0];
  assert.equal(pull.remarks[0].analysisStatus, 'queued');
});

test('WATCH-01 UI-04: отключённый автоанализ предлагает ручной запуск и остаётся в чипе после чтения', async (t) => {
  const fx = await fixture(t, { seedAnalysis: false });
  fx.mutateRepository((repository) => {
    repository.autoAnalyze = false;
  });
  const trusted = githubSnapshot();
  trusted.pullRequests[0].remarks[0].authorAssociation = 'MEMBER';
  await fx.store.applyRepositorySnapshot(trusted);

  const before = (await fx.service.snapshot()).pulls[0];
  assert.equal(before.remarks[0].analysisStatus, 'manual_required');
  assert.equal(before.remarks[0].autoAnalysis.reason, 'auto_analysis_disabled');
  assert.equal(before.attention.needsAnalysis, true);
  assert.equal(before.attention.tone, 'yellow');

  await fx.service.markRead(fx.pullId);
  const after = (await fx.service.snapshot()).pulls[0];
  assert.equal(after.attention.unread, false);
  assert.equal(after.attention.active, true);
  assert.equal(after.attention.tone, 'yellow');
});

test('SYNC-02 UI-05: закрытое и устаревшее замечание не выглядит ожидающим анализ', async (t) => {
  for (const state of ['resolved', 'outdated']) {
    await t.test(state, async (st) => {
      const fx = await fixture(st, { seedAnalysis: false });
      const changed = githubSnapshot();
      const remark = changed.pullRequests[0].remarks[0];
      remark.state = state;
      remark.actionable = false;
      Object.assign(remark, createRemarkVersion({
        ...remark,
        headSha: HEAD,
        state,
        updatedAt: remark.updatedAt,
        body: remark.body,
      }));
      await fx.store.applyRepositorySnapshot(changed);

      const pull = (await fx.service.snapshot()).pulls[0];
      assert.equal(pull.remarks[0].analysisStatus, state);
      assert.equal(pull.remarks[0].autoAnalysis, null);
      assert.equal(pull.attention.needsAnalysis, false);
    });
  }
});

test('SYNC-06: ошибка и running job старой версии не определяют статус нового текста', async (t) => {
  const fx = await fixture(t, { seedAnalysis: false });
  await fx.store.recordArtifactError({
    stage: 'analysis',
    itemKey: fx.remark.key,
    versionId: fx.remark.versionId,
    error: { code: 'MODEL_FAILED', message: 'Старая версия не разобрана' },
  });
  await fx.store.enqueueJob({
    id: 'analysis-old-version',
    queue: 'analysis',
    dedupKey: 'pull:service',
    payload: {
      request: {
        identity: {
          itemVersions: [{
            itemKey: fx.remark.key,
            versionId: fx.remark.versionId,
          }],
        },
      },
    },
  });
  await fx.store.claimJob({
    queue: 'analysis',
    workerId: 'old-worker',
    leaseMs: 60_000,
  });

  const changed = githubSnapshot();
  const changedRemark = changed.pullRequests[0].remarks[0];
  changedRemark.body = 'Новый текст замечания';
  changedRemark.updatedAt = '2026-07-29T12:01:00.000Z';
  Object.assign(changedRemark, createRemarkVersion({
    ...changedRemark,
    headSha: HEAD,
    state: 'open',
    updatedAt: changedRemark.updatedAt,
    body: changedRemark.body,
  }));
  changed.pullRequests[0].updatedAt = changedRemark.updatedAt;
  await fx.store.applyRepositorySnapshot(changed);

  const pull = (await fx.service.snapshot()).pulls[0];
  assert.equal(pull.remarks[0].analysisStatus, 'manual_required');
  assert.equal(pull.remarks[0].analysisError, null);
});

test('ISOLATE-03: route descriptor без Factory executor не включает исправление', async (t) => {
  const fx = await fixture(t, { executorAvailable: false });
  await fx.service.setScope(fx.pullId, [{
    remarkId: fx.remark.key,
    action: 'fix',
    acceptance: 'Unit-тест проходит',
    allowedPaths: ['src/input.js'],
  }]);

  const pull = (await fx.service.snapshot()).pulls[0];
  assert.equal(pull.canRun, false);
  assert.match(pull.runBlockedReason, /executor/i);
  await assert.rejects(
    fx.service.run(fx.pullId),
    (error) => error.code === 'REVIEW_EXECUTOR_UNAVAILABLE',
  );
  assert.equal(fx.currentRun(), null);
  assert.equal(fx.sideEffects.build, 0);
});

test('ISOLATE-04: restart scheduler не продолжает APPROVED/BUILT без Factory executor', async (t) => {
  for (const status of ['approved', 'built']) {
    await t.test(status, async (st) => {
      const fx = await fixture(st);
      await createQueuedRun(fx);
      fx.seedRun({
        ...fx.currentRun(),
        status,
      });
      fx.mutateRepository((repository) => {
        repository.factoryReviewExecutorAvailable = false;
      });

      // Имитируем новый процесс: durable очередь уже есть, runtime executor — нет.
      fx.service.closed = false;
      await fx.service.init();
      if (fx.service.runMaintenance) await fx.service.runMaintenance;
      if (fx.service.runDrain) await fx.service.runDrain;
      await fx.service.close();

      assert.equal(fx.sideEffects.build, 0);
      assert.equal(fx.sideEffects.verify, 0);
      assert.equal(fx.currentRun().status, 'blocked');
      assert.equal(fx.currentRun().failure.code, 'REVIEW_EXECUTOR_UNAVAILABLE');
    });
  }
});

test('ISOLATE-04: API-команды не обходят отключённый Factory executor', async (t) => {
  const cases = [
    {
      name: 'accept',
      status: 'verified',
      invoke: (fx, runId) => fx.service.accept(runId),
      sideEffect: 'accept',
    },
    {
      name: 'revalidate publication',
      status: 'accepted',
      invoke: (fx, runId) => fx.service.revalidatePublication(runId),
      sideEffect: null,
    },
    {
      name: 'publish',
      status: 'accepted',
      invoke: (fx, runId) => fx.service.publish(runId),
      sideEffect: 'publish',
    },
    {
      name: 'reconcile unknown publication',
      status: 'publication_unknown',
      invoke: (fx, runId) => fx.service.publish(runId),
      sideEffect: 'reconcile',
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const fx = await fixture(st);
      const started = await createQueuedRun(fx);
      fx.seedRun({
        ...fx.currentRun(),
        status: entry.status,
        acceptance: { digest: 'acceptance:service' },
        ...(entry.status === 'publication_unknown' && {
          publication: { id: 'publish:unknown', status: 'unknown' },
        }),
      });
      fx.mutateRepository((repository) => {
        repository.factoryReviewExecutorAvailable = false;
      });

      await assert.rejects(
        entry.invoke(fx, started.run.reviewRunId),
        (error) => error.code === 'REVIEW_EXECUTOR_UNAVAILABLE',
      );
      if (entry.sideEffect) assert.equal(fx.sideEffects[entry.sideEffect], 0);
      assert.equal(fx.currentRun().status, entry.status);
      assert.equal(fx.currentRun().stale, undefined);
      assert.equal(fx.currentRun().failure, undefined);
    });
  }
});

test('BUILD-01 SCOPE-06: runner получает immutable raw remark, analysis и acceptance exact scope', async (t) => {
  const fx = await fixture(t);
  const acceptance = 'Unit-тест доказывает, что save не вызывается для пустого значения.';
  await fx.service.setScope(fx.pullId, [{
    remarkId: fx.remark.key,
    action: 'fix',
    acceptance,
    allowedPaths: ['src/input.js'],
  }]);
  // Не запускаем фоновый drain: этот тест проверяет durable gate и exact BUILD input.
  fx.service.closed = true;
  const response = await fx.service.run(fx.pullId);
  const [item] = fx.approved().scope;

  assert.match(response.run.reviewRunId, /^rr-[0-9a-f-]{36}$/);
  assert.equal(item.itemKey, fx.remark.key);
  assert.equal(item.itemVersion, fx.remark.versionId);
  assert.equal(item.acceptance, acceptance);
  assert.deepEqual(item.allowedPaths, ['src/input.js']);
  assert.equal(item.body, 'Проверяй пустое значение до сохранения.');
  assert.equal(item.path, 'src/input.js');
  assert.equal(item.line, 12);
  assert.match(item.url, /discussion_r1/);
  assert.equal(item.analysisId, 'analysis:service-current');
  assert.equal(item.reviewerRequest, 'Добавить раннюю проверку пустого значения.');
  assert.equal(item.expectedChange, 'Сохранение не запускается для пустого значения.');
  assert.equal(item.verification, 'Unit-тест подтверждает отсутствие вызова save.');
  assert.match(item.pullRequestDiff, /src\/input\.js/);
});

test('GATE-07 GATE-08: immutable route/policy проверяются до начала BUILD', async (t) => {
  for (const change of immutableConfigurationChanges) {
    await t.test(change.name, async (st) => {
      const fx = await fixture(st);
      await createQueuedRun(fx);
      fx.mutateRepository(change.apply);

      // Имитируем restart scheduler после изменения Project-конфигурации.
      fx.service.closed = false;
      await fx.service.init();
      if (fx.service.runMaintenance) await fx.service.runMaintenance;
      if (fx.service.runDrain) await fx.service.runDrain;
      await fx.service.close();

      assert.equal(fx.sideEffects.build, 0);
      assert.equal(fx.currentRun().status, 'stale');
      assert.equal(fx.currentRun().stale.code, 'SCOPE_APPROVAL_STALE');
    });
  }
});

test('GATE-07 GATE-08: immutable route/policy проверяются до accept side effect', async (t) => {
  for (const change of immutableConfigurationChanges) {
    await t.test(change.name, async (st) => {
      const fx = await fixture(st);
      const started = await createQueuedRun(fx);
      fx.seedRun({
        ...fx.currentRun(),
        status: 'verified',
      });
      fx.mutateRepository(change.apply);

      await assert.rejects(
        fx.service.accept(started.run.reviewRunId),
        (error) => error.code === 'SCOPE_APPROVAL_STALE',
      );
      assert.equal(fx.sideEffects.accept, 0);
      assert.equal(fx.currentRun().status, 'stale');
      assert.equal(fx.currentRun().stale.code, 'SCOPE_APPROVAL_STALE');
    });
  }
});

test('GATE-07 GATE-08: immutable route/policy проверяются до publish side effect', async (t) => {
  for (const change of immutableConfigurationChanges) {
    await t.test(change.name, async (st) => {
      const fx = await fixture(st);
      const started = await createQueuedRun(fx);
      fx.seedRun({
        ...fx.currentRun(),
        status: 'accepted',
        acceptance: { digest: 'acceptance:service' },
      });
      fx.mutateRepository(change.apply);

      await assert.rejects(
        fx.service.publish(started.run.reviewRunId),
        (error) => error.code === 'SCOPE_APPROVAL_STALE',
      );
      assert.equal(fx.sideEffects.publish, 0);
      assert.equal(fx.currentRun().status, 'stale');
      assert.equal(fx.currentRun().stale.code, 'SCOPE_APPROVAL_STALE');
    });
  }
});

test('GATE-04: active run блокирует смену scope, abandon освобождает PR', async (t) => {
  const fx = await fixture(t);
  const decision = [{
    remarkId: fx.remark.key,
    action: 'fix',
    acceptance: 'Unit-тест проходит',
    allowedPaths: ['src/input.js'],
  }];
  await fx.service.setScope(fx.pullId, decision);
  fx.service.closed = true;
  const started = await fx.service.run(fx.pullId);
  assert.equal((await fx.controlStore.read()).activeRuns[fx.pullId], started.run.reviewRunId);

  await assert.rejects(
    fx.service.setScope(fx.pullId, decision),
    (error) => error.code === 'ACTIVE_RUN_EXISTS',
  );
  const abandoned = await fx.service.abandon(started.run.reviewRunId);
  assert.equal(abandoned.rawState, 'blocked');
  assert.equal((await fx.controlStore.read()).activeRuns[fx.pullId], undefined);
  await fx.service.setScope(fx.pullId, decision);
});

test('MAP-05: durable reservation блокирует rebind до создания run state', async (t) => {
  let entered;
  let release;
  const insideCreate = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const fx = await fixture(t, {
    beforeCreateRun: async () => {
      entered();
      await barrier;
    },
  });
  await fx.service.setScope(fx.pullId, [{
    remarkId: fx.remark.key,
    action: 'fix',
    acceptance: 'Unit-тест проходит',
    allowedPaths: ['src/input.js'],
  }]);
  fx.service.closed = true;

  const pendingRun = fx.service.run(fx.pullId);
  await insideCreate;
  const reserved = await fx.controlStore.read();
  assert.match(reserved.activeRuns[fx.pullId], /^rr-/);
  assert.equal(reserved.runLinks[reserved.activeRuns[fx.pullId]].pending, true);
  await assert.rejects(
    fx.service.assertRepositoryMutable('demo', 'app'),
    (error) => error.code === 'REPOSITORY_RUN_UNKNOWN',
  );

  release();
  const started = await pendingRun;
  assert.equal(
    (await fx.controlStore.read()).runLinks[started.run.reviewRunId].pending,
    false,
  );
});

test('MAP-05: Project mutation и run reservation разделяют один kernel lock', async (t) => {
  const fx = await fixture(t);
  const secondControl = new ReviewControlStore({
    filePath: fx.controlStore.filePath,
    lockTimeoutMs: 1_000,
  });
  await secondControl.init();
  let mutationEntered;
  let releaseMutation;
  const insideMutation = new Promise((resolve) => { mutationEntered = resolve; });
  const mutationBarrier = new Promise((resolve) => { releaseMutation = resolve; });
  let reservationEntered;
  const insideReservation = new Promise((resolve) => { reservationEntered = resolve; });

  const projectMutation = fx.service.mutateRepositoryConfiguration(
    'demo',
    ['app'],
    async () => {
      mutationEntered();
      await mutationBarrier;
      return 'prefs-written';
    },
  );
  await insideMutation;
  const reservation = secondControl.mutate((state) => {
    reservationEntered();
    state.runLinks['rr-after-rebind'] = {
      runId: 'rr-after-rebind',
      pullId: fx.pullId,
      projectId: 'demo',
      repoKey: 'app',
    };
    state.activeRuns[fx.pullId] = 'rr-after-rebind';
  });

  const interleaving = await Promise.race([
    insideReservation.then(() => 'reservation-entered'),
    new Promise((resolve) => setTimeout(() => resolve('still-locked'), 40)),
  ]);
  assert.equal(interleaving, 'still-locked');
  releaseMutation();
  assert.equal(await projectMutation, 'prefs-written');
  await reservation;
  assert.equal((await fx.controlStore.read()).activeRuns[fx.pullId], 'rr-after-rebind');
});

test('RECOVER-01: restart снимает reservation, для которой run state не был создан', async (t) => {
  const fx = await fixture(t);
  const runId = 'rr-crashed-before-state';
  await fx.controlStore.mutate((state) => {
    state.runLinks[runId] = {
      runId,
      pullId: fx.pullId,
      projectId: 'demo',
      repoKey: 'app',
      pending: true,
      createdAt: 1,
    };
    state.activeRuns[fx.pullId] = runId;
  });

  await fx.service.init();
  await fx.service.close();
  const recovered = await fx.controlStore.read();
  assert.equal(recovered.runLinks[runId], undefined);
  assert.equal(recovered.activeRuns[fx.pullId], undefined);
  assert.equal(recovered.queue.includes(runId), false);
});

test('RECOVER-01: restart блокирует pending run без durable scope и освобождает PR', async (t) => {
  const fx = await fixture(t);
  const runId = 'rr-crashed-before-scope';
  fx.seedRun({
    reviewRunId: runId,
    status: 'awaiting_scope',
    updatedAt: 1,
  });
  await fx.controlStore.mutate((state) => {
    state.runLinks[runId] = {
      runId,
      pullId: fx.pullId,
      projectId: 'demo',
      repoKey: 'app',
      pending: true,
      createdAt: 1,
    };
    state.activeRuns[fx.pullId] = runId;
    state.queue.push(runId);
    state.runClaims[runId] = {
      workerId: 'dead-worker',
      fencingToken: 1,
      expiresAt: 2,
    };
    state.runRetries[runId] = { attempts: 1 };
  });

  await fx.service.init();
  await fx.service.close();
  const recovered = await fx.controlStore.read();
  assert.equal(recovered.runLinks[runId].pending, false);
  assert.equal(recovered.runLinks[runId].failed, true);
  assert.equal(recovered.activeRuns[fx.pullId], undefined);
  assert.equal(recovered.queue.includes(runId), false);
  assert.equal(recovered.runClaims[runId], undefined);
  assert.equal(recovered.runRetries[runId], undefined);
  assert.equal(fx.currentRun().status, 'blocked');
  assert.equal(fx.currentRun().failure.code, 'ORPHAN_SCOPE_INCOMPLETE');
});

test('PUBLISH-06: service reconciles успешный unknown push до GitHub freshness', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-service-reconcile.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controlStore = new ReviewControlStore({ filePath: path.join(root, 'control.json') });
  const store = new ReviewStore({ filePath: path.join(root, 'inbox.json') });
  await Promise.all([controlStore.init(), store.init()]);
  const snapshot = githubSnapshot();
  await store.applyRepositorySnapshot(snapshot);
  const runId = 'rr-unknown-after-success';
  const pullKey = snapshotKey(snapshot.repoNodeId, snapshot.pullRequests[0].prNodeId);
  await controlStore.mutate((state) => {
    state.runLinks[runId] = {
      runId,
      pullId: pullKey,
      repositoryId: 'binding-unknown-publication',
      projectId: 'demo',
      repoKey: 'app',
    };
    state.activeRuns[pullKey] = runId;
  });
  const unknown = {
    reviewRunId: runId,
    status: 'publication_unknown',
    acceptance: { digest: 'acceptance-v1' },
    publication: {
      id: 'publish-v1',
      status: 'unknown',
      expectedRemoteSha: HEAD,
    },
    binding: {},
  };
  let reconciles = 0;
  let publishes = 0;
  let repositoryReads = 0;
  const service = new ReviewService({
    store,
    controlStore,
    watcher: null,
    analysisQueue: null,
    translatorQueue: null,
    runner: { getRun: async () => structuredClone(unknown) },
    publisher: {
      reconcile: async ({ reviewRunId }) => {
        reconciles += 1;
        assert.equal(reviewRunId, runId);
        return {
          ...structuredClone(unknown),
          status: 'published',
          publication: {
            ...unknown.publication,
            status: 'published',
            remoteSha: 'b'.repeat(40),
            reconciled: true,
          },
        };
      },
      publish: async () => {
        publishes += 1;
        throw new Error('Второй push не должен запускаться');
      },
    },
    repositoryProvider: async () => {
      repositoryReads += 1;
      return [{
        id: 'binding-unknown-publication',
        projectId: 'demo',
        repoKey: 'app',
        slug: snapshot.nameWithOwner,
        factoryReviewExecutorAvailable: true,
      }];
    },
  });

  const result = await service.publish(runId);
  assert.equal(result.rawState, 'published');
  assert.equal(reconciles, 1);
  assert.equal(publishes, 0);
  // До reconcile читается только runtime Project binding; GitHub sync не запускается.
  assert.equal(repositoryReads, 1);
  assert.equal((await controlStore.read()).activeRuns[pullKey], undefined);
});

test('VERIFY-05: Project явно решает, покрывают ли команды все критерии', () => {
  const mapped = parseReviewVerifyCommand('npm test', 0, { coversAllCriteria: true });
  assert.equal(mapped.coversAllCriteria, true);
  assert.equal(mapped.compareBaseline, true);
  assert.equal(
    parseReviewVerifyCommand('npm test', 0, { coversAllCriteria: false }).coversAllCriteria,
    false,
  );
});

test('QUEUE-01 RECOVER-RACE-01: два экземпляра scheduler не получают один queued review run', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-control-race.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const filePath = path.join(root, 'control.json');
  const first = new ReviewControlStore({ filePath, now: () => now });
  const second = new ReviewControlStore({ filePath, now: () => now });
  await first.init();
  await first.mutate((state) => {
    state.runLinks['rr-queue-race'] = { runId: 'rr-queue-race', pullId: 'pull-1' };
    state.queue.push('rr-queue-race');
  });

  const [left, right] = await Promise.all([
    first.claimNextRun({ workerId: 'worker-left', leaseMs: 1_000 }),
    second.claimNextRun({ workerId: 'worker-right', leaseMs: 1_000 }),
  ]);
  const winner = left || right;
  assert.ok(winner);
  assert.equal(Number(Boolean(left)) + Number(Boolean(right)), 1);

  now += 1_001;
  const recovered = await second.claimNextRun({ workerId: 'worker-recovery', leaseMs: 1_000 });
  assert.equal(recovered.runId, 'rr-queue-race');
  assert.ok(recovered.fencingToken > winner.fencingToken);
  await assert.rejects(
    first.releaseRunClaim({
      runId: winner.runId,
      workerId: winner.workerId,
      fencingToken: winner.fencingToken,
    }),
    (error) => error.code === 'STALE_FENCE',
  );
});

test('QUEUE-05: временно недоступный run переносится в хвост durable-очереди', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-control-backoff.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const store = new ReviewControlStore({
    filePath: path.join(root, 'control.json'),
    now: () => now,
  });
  await store.init();
  await store.mutate((state) => {
    for (const runId of ['rr-first', 'rr-second']) {
      state.runLinks[runId] = { runId, pullId: `pull-${runId}` };
      state.queue.push(runId);
    }
  });
  const first = await store.claimNextRun({ workerId: 'worker', leaseMs: 1_000 });
  assert.equal(first.runId, 'rr-first');
  await store.deferRunClaim({
    runId: first.runId,
    workerId: first.workerId,
    fencingToken: first.fencingToken,
    availableAt: 10_000,
    error: { code: 'GITHUB_UNAVAILABLE', message: 'temporary' },
  });
  const second = await store.claimNextRun({ workerId: 'worker', leaseMs: 1_000 });
  assert.equal(second.runId, 'rr-second');
  await store.releaseRunClaim(second);
  await store.mutate((state) => {
    state.queue = state.queue.filter((runId) => runId !== 'rr-second');
    delete state.runLinks['rr-second'];
  });
  now = 10_001;
  const retried = await store.claimNextRun({ workerId: 'worker', leaseMs: 1_000 });
  assert.equal(retried.runId, 'rr-first');
});

test('RB-03 QUEUE-01: истёкший scheduler claim нельзя оживить или завершить', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-control-expired.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const store = new ReviewControlStore({
    filePath: path.join(root, 'control.json'),
    now: () => now,
  });
  await store.init();
  await store.mutate((state) => {
    state.runLinks['rr-expired'] = { runId: 'rr-expired', pullId: 'pull-expired' };
    state.queue.push('rr-expired');
  });
  const claim = await store.claimNextRun({ workerId: 'frozen', leaseMs: 1_000 });
  now = 2_001;

  for (const operation of [
    () => store.renewRunClaim({ ...claim, leaseMs: 1_000 }),
    () => store.deferRunClaim({ ...claim, availableAt: 5_000 }),
    () => store.completeRunClaim(claim),
    () => store.releaseRunClaim(claim),
  ]) {
    await assert.rejects(operation(), (error) => error.code === 'STALE_FENCE');
  }
  const state = await store.read();
  assert.deepEqual(state.queue, ['rr-expired']);
  assert.ok(state.runClaims['rr-expired']);
});

test('RB-03 QUEUE-01: run claim проверяется непосредственно перед rename', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-control-final-gate.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let stable = true;
  let calls = 0;
  const now = () => {
    if (stable) return 1_000;
    calls += 1;
    return calls < 4 ? 1_000 : 2_001;
  };
  const store = new ReviewControlStore({
    filePath: path.join(root, 'control.json'),
    now,
  });
  await store.init();
  await store.mutate((state) => {
    state.runLinks['rr-final-gate'] = { runId: 'rr-final-gate', pullId: 'pull-final-gate' };
    state.queue.push('rr-final-gate');
  });
  const claim = await store.claimNextRun({ workerId: 'slow-scheduler', leaseMs: 1_000 });
  stable = false;

  await assert.rejects(
    store.completeRunClaim(claim),
    (error) => error.code === 'STALE_FENCE',
  );
  assert.deepEqual((await store.read()).queue, ['rr-final-gate']);
});

test('CONTROL-LOCK-LOST: parent fd удерживает kernel lock до commit control state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-control-lock-lost.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'control.json');
  const first = new ReviewControlStore({ filePath });
  const second = new ReviewControlStore({
    filePath,
    lockTimeoutMs: 20,
  });
  await first.init();
  let entered;
  let release;
  const inside = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const holder = first.mutate(async (state) => {
    entered();
    await barrier;
    state.queue.push('rr-first');
  });
  await inside;
  await assert.rejects(
    second.mutate((state) => { state.queue.push('rr-second'); }),
    (error) => error.code === 'REVIEW_CONTROL_LOCK_TIMEOUT',
  );
  release();
  await holder;
  assert.deepEqual((await first.read()).queue, ['rr-first']);
});
