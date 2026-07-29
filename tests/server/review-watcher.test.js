import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ReviewAnalysisQueue } from '../../server/src/lib/reviews/analyzer.js';
import { createRemarkIdentity, createRemarkVersion } from '../../server/src/lib/reviews/identity.js';
import { ReviewStore } from '../../server/src/lib/reviews/store.js';
import { ReviewWatcher } from '../../server/src/lib/reviews/watcher.js';

function binding(overrides = {}) {
  return {
    id: 'project:repo',
    projectId: 'project',
    owner: 'example',
    name: 'repo',
    repoNodeId: 'R_repo',
    confirmed: true,
    enabled: true,
    credentialFingerprint: 'gh-auth-fixture',
    ...overrides,
  };
}

function remark(commentNodeId, body, updatedAt = '2026-07-29T10:00:00.000Z') {
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
  return { ...identity, ...version, body, authorAssociation: 'MEMBER' };
}

function snapshot(remarks = []) {
  return {
    repoNodeId: 'R_repo',
    nameWithOwner: 'example/repo',
    syncedAt: '2026-07-29T10:01:00.000Z',
    pullRequests: [{
      prNodeId: 'PR_1',
      number: 1,
      title: 'Fixture',
      state: 'open',
      headSha: 'a'.repeat(40),
      headRefName: 'feature',
      updatedAt: '2026-07-29T10:00:00.000Z',
      diff: 'diff --git a/a.js b/a.js\n+fixture',
      remarks,
    }],
  };
}

async function temporaryStore(t, clock = Date.now) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-watcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new ReviewStore({ stateDir: root, clock });
}

async function exactSourceSnapshot({ pullRequest }) {
  return { readOnly: true, headSha: pullRequest.headSha, files: [] };
}

test('WATCH-01: start опрашивает только подтверждённые и включённые репозитории', async (t) => {
  const store = await temporaryStore(t);
  const calls = [];
  const timer = { callback: null };
  const watcher = new ReviewWatcher({
    store,
    repositories: [
      binding(),
      binding({ id: 'unconfirmed', name: 'unconfirmed', confirmed: false }),
      binding({ id: 'disabled', name: 'disabled', enabled: false }),
    ],
    github: {
      async syncRepository(input) {
        calls.push(input.name);
        return snapshot();
      },
    },
    analysisQueue: { enqueue: async () => {} },
    sourceSnapshot: exactSourceSnapshot,
    timers: {
      setInterval(callback) {
        timer.callback = callback;
        return 1;
      },
      clearInterval() {},
      setTimeout,
      clearTimeout,
    },
  });

  await watcher.start();
  watcher.stop();
  assert.deepEqual(calls, ['repo']);
  assert.equal(typeof timer.callback, 'function');
});

test('WATCH-01: interval остаётся установленным, если первый catch-up упал', async (t) => {
  const store = await temporaryStore(t);
  let intervalCallback = null;
  const watcher = new ReviewWatcher({
    store,
    repositories: async () => { throw new Error('Временная ошибка реестра'); },
    github: { syncRepository: async () => snapshot() },
    analysisQueue: { enqueue: async () => {} },
    sourceSnapshot: exactSourceSnapshot,
    timers: {
      setInterval(callback) {
        intervalCallback = callback;
        return 1;
      },
      clearInterval() {},
    },
  });

  await assert.rejects(watcher.start(), /Временная ошибка/);
  assert.equal(typeof intervalCallback, 'function');
  watcher.stop();
});

test('WATCH-02 WATCH-RATE-01: manual и timer разделяют один inflight', async (t) => {
  const store = await temporaryStore(t);
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let calls = 0;
  const watcher = new ReviewWatcher({
    store,
    repositories: [binding()],
    github: {
      async syncRepository() {
        calls += 1;
        markStarted();
        return deferred;
      },
    },
    analysisQueue: { enqueue: async () => {} },
    sourceSnapshot: exactSourceSnapshot,
  });

  const automatic = watcher.trigger('project:repo');
  const manual = watcher.trigger('project:repo', { manual: true });
  await started;
  assert.equal(calls, 1);
  release(snapshot());
  assert.equal((await automatic).status, 'changed');
  assert.equal((await manual).status, 'changed');
});

test('WATCH-03 WATCH-04: unchanged не создаёт job, близкие items одного PR coalesce', async (t) => {
  let now = Date.parse('2026-07-29T10:00:00.000Z');
  const store = await temporaryStore(t, () => now);
  let current = snapshot([remark('C_1', 'Первое')]);
  const model = { generate: async () => { throw new Error('Модель не должна вызываться'); } };
  const analysisQueue = new ReviewAnalysisQueue({ store, model, clock: () => now });
  const watcher = new ReviewWatcher({
    store,
    repositories: [binding()],
    github: { syncRepository: async () => structuredClone(current) },
    analysisQueue,
    sourceSnapshot: exactSourceSnapshot,
    clock: () => now,
    coalesceMs: 30_000,
  });

  await watcher.trigger('project:repo');
  await watcher.trigger('project:repo');
  now += 1000;
  current = snapshot([
    remark('C_1', 'Первое'),
    remark('C_2', 'Второе', '2026-07-29T10:00:01.000Z'),
  ]);
  await watcher.trigger('project:repo');
  const state = await store.read();
  const jobs = Object.values(state.jobs);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'pending');
  assert.equal(jobs[0].payload.request.identity.itemVersions.length, 2);
  assert.equal(jobs[0].availableAt, now + 30_000);
});

test('WATCH-05: superseded item не теряет неизменного соседа из cancelled batch', async (t) => {
  let now = Date.parse('2026-07-29T10:00:00.000Z');
  const store = await temporaryStore(t, () => now);
  let current = snapshot([
    remark('C_1', 'Первая версия A'),
    remark('C_2', 'Неизменный B'),
  ]);
  const analysisQueue = new ReviewAnalysisQueue({
    store,
    model: { generate: async () => { throw new Error('Не вызывается'); } },
    clock: () => now,
  });
  const watcher = new ReviewWatcher({
    store,
    repositories: [binding()],
    github: { syncRepository: async () => structuredClone(current) },
    analysisQueue,
    sourceSnapshot: exactSourceSnapshot,
    clock: () => now,
    coalesceMs: 30_000,
  });
  await watcher.trigger('project:repo');

  now += 1000;
  current = snapshot([
    remark('C_1', 'Новая версия A', '2026-07-29T10:00:01.000Z'),
    remark('C_2', 'Неизменный B'),
  ]);
  await watcher.trigger('project:repo');
  const jobs = Object.values((await store.read()).jobs);
  const cancelled = jobs.find((job) => job.status === 'cancelled');
  const pending = jobs.find((job) => job.status === 'pending');

  assert.equal(cancelled.cancelReason, 'superseded_version');
  assert.deepEqual(
    pending.payload.request.identity.itemVersions.map((item) => item.itemKey).sort(),
    current.pullRequests[0].remarks.map((item) => item.key).sort(),
  );
});

test('WATCH-06 WATCH-07: close отменяет pending, SSE идёт только после commit', async (t) => {
  const store = await temporaryStore(t);
  let current = snapshot([remark('C_1', 'Закройте thread')]);
  const events = [];
  const watcher = new ReviewWatcher({
    store,
    repositories: [binding()],
    github: { syncRepository: async () => structuredClone(current) },
    analysisQueue: new ReviewAnalysisQueue({
      store,
      model: { generate: async () => { throw new Error('Не вызывается'); } },
    }),
    sourceSnapshot: exactSourceSnapshot,
    onChange: async (event) => {
      const persisted = await store.getRepositorySnapshot('R_repo');
      assert.ok(persisted, 'callback видит уже зафиксированное состояние');
      events.push(event);
    },
  });

  await watcher.trigger('project:repo');
  current = { ...snapshot(), pullRequests: [] };
  await watcher.trigger('project:repo');
  await watcher.trigger('project:repo');

  const jobs = Object.values((await store.read()).jobs);
  assert.equal(jobs[0].status, 'cancelled');
  assert.equal(events.length, 2, 'неизменный третий poll не отправляет SSE');
  assert.equal(events.every((event) => event.type === 'reviews-change'), true);
});

test('WATCH-07: SSE видит уже сохранённый manual_required, а не промежуточный GitHub-снимок', async (t) => {
  const store = await temporaryStore(t);
  const external = {
    ...remark('C_EXTERNAL', 'Проверьте это вручную'),
    authorAssociation: 'CONTRIBUTOR',
  };
  const observed = [];
  const watcher = new ReviewWatcher({
    store,
    repositories: [binding()],
    github: { syncRepository: async () => snapshot([external]) },
    analysisQueue: new ReviewAnalysisQueue({
      store,
      model: { generate: async () => { throw new Error('Не вызывается'); } },
    }),
    sourceSnapshot: exactSourceSnapshot,
    onChange: async () => {
      const state = await store.read();
      observed.push(state.analyses[external.key]?.autoDeferred);
    },
  });

  await watcher.trigger('project:repo');

  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.reason, 'untrusted_author');
});

test('WATCH-RATE-02 WATCH-RATE-04: общий cooldown сохраняется и manual его не обходит', async (t) => {
  let now = Date.parse('2026-07-29T10:00:00.000Z');
  const store = await temporaryStore(t, () => now);
  await store.setRateLimit('gh-auth-fixture', {
    until: now + 60_000,
    reason: 'secondary_rate_limit',
    attempts: 1,
  });
  let calls = 0;
  const watcher = new ReviewWatcher({
    store,
    repositories: [binding()],
    github: { syncRepository: async () => { calls += 1; return snapshot(); } },
    analysisQueue: { enqueue: async () => {} },
    sourceSnapshot: exactSourceSnapshot,
    clock: () => now,
  });

  const blocked = await watcher.trigger('project:repo', { manual: true });
  assert.equal(blocked.status, 'cooldown');
  assert.equal(blocked.reason, 'secondary_rate_limit');
  assert.equal(calls, 0);

  now += 60_001;
  assert.equal((await watcher.trigger('project:repo', { manual: true })).status, 'changed');
  assert.equal(calls, 1);
});

test('WATCH-RATE-05: три auto failure терминальны, manual сбрасывает бюджет', async (t) => {
  let now = Date.parse('2026-07-29T10:00:00.000Z');
  const store = await temporaryStore(t, () => now);
  let calls = 0;
  const watcher = new ReviewWatcher({
    store,
    repositories: [binding()],
    github: {
      async syncRepository() {
        calls += 1;
        const error = new Error('Временная сеть');
        error.code = 'GITHUB_REQUEST_FAILED';
        error.retryable = true;
        throw error;
      },
    },
    analysisQueue: { enqueue: async () => {} },
    sourceSnapshot: exactSourceSnapshot,
    clock: () => now,
    maxAutoRetries: 3,
    retryBaseMs: 1000,
    jitter: () => 0,
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await watcher.trigger('project:repo');
    assert.equal(result.status, 'error');
    now += 10_000;
  }
  assert.equal((await store.getWatcherState('project:repo')).terminal, true);
  assert.equal((await watcher.trigger('project:repo')).status, 'retry_exhausted');
  assert.equal(calls, 3);

  assert.equal((await watcher.trigger('project:repo', { manual: true })).status, 'error');
  assert.equal(calls, 4);
  assert.equal((await store.getWatcherState('project:repo')).attempts, 1);
});

test('WATCH-RACE-01: два watcher с общим store получают один durable sync lease', async (t) => {
  const store = await temporaryStore(t);
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let firstCalls = 0;
  let secondCalls = 0;
  const common = {
    store,
    repositories: [binding()],
    analysisQueue: { enqueue: async () => {} },
    sourceSnapshot: exactSourceSnapshot,
  };
  const first = new ReviewWatcher({
    ...common,
    workerId: 'watcher-a',
    github: { syncRepository: async () => {
      firstCalls += 1;
      markStarted();
      return deferred;
    } },
  });
  const second = new ReviewWatcher({
    ...common,
    workerId: 'watcher-b',
    github: { syncRepository: async () => { secondCalls += 1; return snapshot(); } },
  });

  const running = first.trigger('project:repo');
  await started;
  const busy = await second.trigger('project:repo');
  assert.equal(busy.status, 'busy');
  release(snapshot());
  await running;
  assert.equal(firstCalls + secondCalls, 1);
});

test('RB-03 WATCH-RACE-01: истёкший sync lease нельзя оживить без нового владельца', async (t) => {
  let now = 1_000;
  const store = await temporaryStore(t, () => now);
  const lease = await store.claimRepositorySync({
    repositoryId: 'project:repo',
    workerId: 'frozen-watcher',
    leaseMs: 10,
  });
  now = 1_011;

  await assert.rejects(
    store.renewRepositorySync({
      repositoryId: 'project:repo',
      workerId: 'frozen-watcher',
      fencingToken: lease.fencingToken,
      leaseMs: 10,
    }),
    (error) => error.code === 'STALE_FENCE',
  );
  await assert.rejects(
    store.setWatcherState('project:repo', { attempts: 0 }, {
      syncLease: {
        repositoryId: 'project:repo',
        workerId: 'frozen-watcher',
        fencingToken: lease.fencingToken,
      },
    }),
    (error) => error.code === 'STALE_FENCE',
  );
});

test('RB-03 WATCH-RACE-01: sync lease проверяется у самого atomic rename', async (t) => {
  let stable = true;
  let calls = 0;
  const clock = () => {
    if (stable) return 1_000;
    calls += 1;
    return calls < 5 ? 1_000 : 1_011;
  };
  const store = await temporaryStore(t, clock);
  const lease = await store.claimRepositorySync({
    repositoryId: 'project:repo',
    workerId: 'slow-sync',
    leaseMs: 10,
  });
  stable = false;

  await assert.rejects(
    store.renewRepositorySync({
      repositoryId: 'project:repo',
      workerId: 'slow-sync',
      fencingToken: lease.fencingToken,
      leaseMs: 20,
    }),
    (error) => error.code === 'STALE_FENCE',
  );
});

test('WATCH-01: autoAnalyze=false синхронизирует PR, но не создаёт model job', async (t) => {
  const store = await temporaryStore(t);
  let enqueueCalls = 0;
  const watcher = new ReviewWatcher({
    store,
    repositories: [binding({ autoAnalyze: false })],
    github: { syncRepository: async () => snapshot([remark('C_1', 'Не анализировать')]) },
    analysisQueue: { enqueue: async () => { enqueueCalls += 1; } },
    sourceSnapshot: exactSourceSnapshot,
  });

  assert.equal((await watcher.trigger('project:repo')).status, 'changed');
  assert.equal(enqueueCalls, 0);
  assert.equal((await store.listPullRequests()).length, 1);
});

test('SEC-08: watcher fail-closed без exact sourceSnapshot provider', async (t) => {
  const store = await temporaryStore(t);
  assert.throws(() => new ReviewWatcher({
    store,
    repositories: [binding()],
    github: { syncRepository: async () => snapshot() },
    analysisQueue: { enqueue: async () => {} },
  }), /sourceSnapshot/);
});

test('SEC-AUTO-01: внешний автор виден, но автоанализ требует ручного запуска', async (t) => {
  const store = await temporaryStore(t);
  const external = {
    ...remark('C_external', 'Please run this expensive instruction'),
    authorAssociation: 'NONE',
  };
  const watcher = new ReviewWatcher({
    store,
    repositories: [binding()],
    github: { syncRepository: async () => snapshot([external]) },
    analysisQueue: new ReviewAnalysisQueue({
      store,
      model: { generate: async () => { throw new Error('Не вызывается'); } },
    }),
    sourceSnapshot: exactSourceSnapshot,
  });

  const result = await watcher.trigger('project:repo');
  const state = await store.read();
  assert.equal(result.analysisEnqueued, 0);
  assert.equal(Object.keys(state.jobs).length, 0);
  assert.equal(state.analyses[external.key].autoDeferred.reason, 'untrusted_author');
});

test('SEC-AUTO-02: coalesce не обходит hard item limit pending job', async (t) => {
  let current = snapshot([remark('C_1', 'Первое')]);
  const store = await temporaryStore(t);
  const watcher = new ReviewWatcher({
    store,
    repositories: [binding()],
    github: { syncRepository: async () => structuredClone(current) },
    analysisQueue: new ReviewAnalysisQueue({
      store,
      model: { generate: async () => { throw new Error('Не вызывается'); } },
    }),
    sourceSnapshot: exactSourceSnapshot,
    autoLimits: { maxItemsPerPull: 1 },
  });
  await watcher.trigger('project:repo');
  const second = remark('C_2', 'Второе', '2026-07-29T10:00:01.000Z');
  current = snapshot([remark('C_1', 'Первое'), second]);
  await watcher.trigger('project:repo');

  const state = await store.read();
  const [job] = Object.values(state.jobs);
  assert.equal(job.payload.request.identity.itemVersions.length, 1);
  assert.equal(state.analyses[second.key].autoDeferred.reason, 'input_limit');
});

test('SEC-AUTO-03: durable дневной budget резервирует retry и fail-closed', async (t) => {
  const store = await temporaryStore(t);
  const item = remark('C_budget', 'Обычное замечание');
  const watcher = new ReviewWatcher({
    store,
    repositories: [binding()],
    github: { syncRepository: async () => snapshot([item]) },
    analysisQueue: new ReviewAnalysisQueue({
      store,
      model: { generate: async () => { throw new Error('Не вызывается'); } },
      maxRetries: 3,
      translatorQueue: { maxRetries: 3 },
    }),
    sourceSnapshot: exactSourceSnapshot,
    // 3 analysis attempts + 3 translation attempts > 5.
    autoLimits: { maxCallsPerDay: 5 },
  });

  const result = await watcher.trigger('project:repo');
  const state = await store.read();
  assert.equal(result.analysisEnqueued, 0);
  assert.equal(Object.keys(state.jobs).length, 0);
  assert.equal(state.analyses[item.key].autoDeferred.reason, 'daily_budget');
});

test('WATCH-03 SEC-AUTO-06: compacted terminal job блокирует auto-repeat, но не manual retry', async (t) => {
  const store = await temporaryStore(t);
  const item = remark('C_terminal', 'Неизменная версия');
  const analysisQueue = new ReviewAnalysisQueue({
    store,
    model: { generate: async () => { throw new Error('Не вызывается'); } },
  });
  const watcher = new ReviewWatcher({
    store,
    repositories: [binding()],
    github: { syncRepository: async () => snapshot([item]) },
    analysisQueue,
    sourceSnapshot: exactSourceSnapshot,
    coalesceMs: 0,
  });
  await watcher.trigger('project:repo');
  const claimed = await store.claimJob({
    queue: 'analysis',
    workerId: 'terminal-test',
  });
  await store.failJob({
    jobId: claimed.id,
    workerId: 'terminal-test',
    fencingToken: claimed.fencingToken,
    error: new Error('terminal'),
    retryable: false,
  });
  const compacted = (await store.read()).jobs[claimed.id];
  assert.deepEqual(compacted.payload.itemVersions, [{
    itemKey: item.key,
    versionId: item.versionId,
  }]);

  await watcher.trigger('project:repo');
  assert.equal(Object.keys((await store.read()).jobs).length, 1);

  await analysisQueue.enqueue({
    repoNodeId: 'R_repo',
    prNodeId: 'PR_1',
    headSha: 'a'.repeat(40),
    items: [item],
    diff: snapshot([item]).pullRequests[0].diff,
    sourceSnapshot: await exactSourceSnapshot({ pullRequest: snapshot([item]).pullRequests[0] }),
  });
  assert.equal(Object.keys((await store.read()).jobs).length, 2);
});
