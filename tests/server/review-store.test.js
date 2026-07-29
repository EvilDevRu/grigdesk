import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRemarkIdentity, createRemarkVersion } from '../../server/src/lib/reviews/identity.js';
import { ReviewStore, REVIEW_STORE_SCHEMA_VERSION } from '../../server/src/lib/reviews/store.js';

function fixtureSnapshot({ body = 'Замечание', headSha = 'a'.repeat(40), state = 'open' } = {}) {
  const identity = createRemarkIdentity({
    repoNodeId: 'R_repo',
    prNodeId: 'PR_1',
    kind: 'thread_comment',
    threadNodeId: 'T_1',
    commentNodeId: 'C_1',
  });
  const version = createRemarkVersion({
    ...identity,
    headSha,
    state,
    updatedAt: '2026-07-29T10:00:00.000Z',
    body,
  });
  return {
    repoNodeId: 'R_repo',
    nameWithOwner: 'example/repo',
    syncedAt: '2026-07-29T10:00:01.000Z',
    pullRequests: [{
      prNodeId: 'PR_1',
      number: 1,
      title: 'Fixture',
      state: 'open',
      updatedAt: '2026-07-29T10:00:00.000Z',
      headSha,
      remarks: [{ ...identity, ...version, body }],
    }],
  };
}

function withSecondPullRequest(value) {
  const result = structuredClone(value);
  const identity = createRemarkIdentity({
    repoNodeId: 'R_repo',
    prNodeId: 'PR_2',
    kind: 'issue_comment',
    commentNodeId: 'IC_2',
  });
  const body = 'Независимое замечание второго PR';
  const version = createRemarkVersion({
    ...identity,
    headSha: 'b'.repeat(40),
    state: 'open',
    updatedAt: '2026-07-29T10:00:00.000Z',
    body,
  });
  result.pullRequests.push({
    prNodeId: 'PR_2',
    number: 2,
    title: 'Second fixture',
    state: 'open',
    updatedAt: '2026-07-29T10:00:00.000Z',
    headSha: 'b'.repeat(40),
    remarks: [{ ...identity, ...version, body }],
  });
  return result;
}

async function temporaryStore(t, now = Date.parse('2026-07-29T10:00:00.000Z')) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewStore({ stateDir: root, clock: () => now });
  await store.init();
  return { root, store };
}

test('RUN-08: store пишет атомарный JSON с schema version и переживает restart', async (t) => {
  const { root, store } = await temporaryStore(t);
  const applied = await store.applyRepositorySnapshot(fixtureSnapshot());

  assert.equal(applied.changed, true);
  const restarted = new ReviewStore({ stateDir: root });
  const state = await restarted.read();
  assert.equal(state.schemaVersion, REVIEW_STORE_SCHEMA_VERSION);
  assert.equal(state.revision, 1);
  assert.equal(state.repositories.R_repo.pullRequests[0].remarks[0].body, 'Замечание');
  assert.deepEqual((await readdir(path.join(root, 'reviews'))).sort(), [
    'state.json',
    'state.json.lock',
  ]);
  const persisted = await readFile(path.join(root, 'reviews', 'state.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(persisted));
});

test('SYNC-03 WATCH-03: неизменный смысловой снимок не создаёт новую revision', async (t) => {
  const { store } = await temporaryStore(t);
  assert.equal((await store.applyRepositorySnapshot(fixtureSnapshot())).changed, true);
  assert.equal((await store.applyRepositorySnapshot({
    ...fixtureSnapshot(),
    syncedAt: '2026-07-29T11:00:00.000Z',
  })).changed, false);
  assert.equal((await store.read()).revision, 1);
});

test('SYNC-06 RB-02: поздний анализ v1 не заменяет текущую v2', async (t) => {
  const { store } = await temporaryStore(t);
  const first = fixtureSnapshot({ body: 'v1' });
  const firstRemark = first.pullRequests[0].remarks[0];
  await store.applyRepositorySnapshot(first);
  const second = fixtureSnapshot({ body: 'v2' });
  const secondRemark = second.pullRequests[0].remarks[0];
  await store.applyRepositorySnapshot(second);

  const late = await store.compareAndSetAnalysis({
    itemKey: firstRemark.key,
    versionId: firstRemark.versionId,
    headSha: first.pullRequests[0].headSha,
    artifact: { analysisId: 'analysis-v1' },
  });
  const current = await store.compareAndSetAnalysis({
    itemKey: secondRemark.key,
    versionId: secondRemark.versionId,
    headSha: second.pullRequests[0].headSha,
    artifact: { analysisId: 'analysis-v2' },
  });

  assert.deepEqual(late, { applied: false, reason: 'version_changed' });
  assert.equal(current.applied, true);
  assert.equal((await store.read()).analyses[firstRemark.key].current.analysisId, 'analysis-v2');
});

test('WATCH-05 WATCH-06: новая версия отменяет pending job старой версии', async (t) => {
  const { store } = await temporaryStore(t);
  const first = fixtureSnapshot({ body: 'v1' });
  const oldRemark = first.pullRequests[0].remarks[0];
  await store.applyRepositorySnapshot(first);
  await store.enqueueJob({
    id: 'old-analysis',
    queue: 'analysis',
    dedupKey: 'analysis:PR_1',
    payload: {
      request: {
        identity: {
          itemVersions: [{
            itemKey: oldRemark.key,
            versionId: oldRemark.versionId,
          }],
        },
      },
    },
  });

  await store.applyRepositorySnapshot(fixtureSnapshot({ body: 'v2' }));
  const job = (await store.read()).jobs['old-analysis'];
  assert.equal(job.status, 'cancelled');
  assert.equal(job.cancelReason, 'superseded_version');
});

test('WATCH-06: новая версия отменяет pending translation по payload.entries', async (t) => {
  const { store } = await temporaryStore(t);
  const first = fixtureSnapshot({ body: 'v1' });
  const oldRemark = first.pullRequests[0].remarks[0];
  await store.applyRepositorySnapshot(first);
  await store.enqueueJob({
    id: 'old-translation',
    queue: 'translation',
    dedupKey: 'translation:PR_1',
    payload: {
      entries: [{
        itemKey: oldRemark.key,
        versionId: oldRemark.versionId,
        analysisId: 'analysis:old',
      }],
    },
  });

  await store.applyRepositorySnapshot(fixtureSnapshot({ body: 'v2' }));
  const job = (await store.read()).jobs['old-translation'];
  assert.equal(job.status, 'cancelled');
  assert.equal(job.cancelReason, 'superseded_version');
});

test('RB-03: fencing token запрещает завершение job прежним владельцем', async (t) => {
  let now = Date.parse('2026-07-29T10:00:00.000Z');
  const { store } = await temporaryStore(t, now);
  store.clock = () => now;
  await store.enqueueJob({
    id: 'job-1',
    queue: 'analysis',
    dedupKey: 'analysis:PR_1:v1',
    payload: { value: 1 },
    maxAttempts: 3,
  });
  const first = await store.claimJob({ queue: 'analysis', workerId: 'worker-a', leaseMs: 1000 });
  now += 1001;
  const second = await store.claimJob({ queue: 'analysis', workerId: 'worker-b', leaseMs: 1000 });

  assert.ok(second.fencingToken > first.fencingToken);
  await assert.rejects(
    store.completeJob({
      jobId: 'job-1',
      workerId: 'worker-a',
      fencingToken: first.fencingToken,
      result: { wrong: true },
    }),
    (error) => error.code === 'STALE_FENCE',
  );
  assert.equal((await store.completeJob({
    jobId: 'job-1',
    workerId: 'worker-b',
    fencingToken: second.fencingToken,
    result: { ok: true },
  })).status, 'completed');
});

test('QUEUE-RECOVERY-01: последний истёкший analysis lease становится видимой ошибкой', async (t) => {
  let now = Date.parse('2026-07-29T10:00:00.000Z');
  const { store } = await temporaryStore(t, now);
  store.clock = () => now;
  const snapshot = fixtureSnapshot();
  const remark = snapshot.pullRequests[0].remarks[0];
  await store.applyRepositorySnapshot(snapshot);
  await store.enqueueJob({
    id: 'analysis-crashed-last-attempt',
    queue: 'analysis',
    dedupKey: 'analysis:crashed',
    maxAttempts: 1,
    payload: {
      request: {
        identity: {
          itemVersions: [{
            itemKey: remark.key,
            versionId: remark.versionId,
          }],
        },
      },
    },
  });
  await store.claimJob({
    queue: 'analysis',
    workerId: 'crashed-worker',
    leaseMs: 1_000,
  });

  now += 1_001;
  const recovery = await store.claimJob({
    queue: 'analysis',
    workerId: 'recovery-worker',
    leaseMs: 1_000,
  });
  const state = await store.read();

  assert.equal(recovery.maintenance, true);
  assert.deepEqual(recovery.recoveredFailures, [{
    queue: 'analysis',
    itemKey: remark.key,
    versionId: remark.versionId,
  }]);
  assert.equal(state.jobs['analysis-crashed-last-attempt'].status, 'failed');
  assert.equal(state.analyses[remark.key].error.code, 'RETRY_BUDGET_EXHAUSTED');
  assert.equal(state.analyses[remark.key].error.versionId, remark.versionId);
});

test('QUEUE-RECOVERY-02: последний истёкший translation lease становится видимой ошибкой', async (t) => {
  let now = Date.parse('2026-07-29T10:00:00.000Z');
  const { store } = await temporaryStore(t, now);
  store.clock = () => now;
  const snapshot = fixtureSnapshot();
  const remark = snapshot.pullRequests[0].remarks[0];
  await store.applyRepositorySnapshot(snapshot);
  await store.enqueueJob({
    id: 'translation-crashed-last-attempt',
    queue: 'translation',
    dedupKey: 'translation:crashed',
    maxAttempts: 1,
    payload: {
      entries: [{
        itemKey: remark.key,
        versionId: remark.versionId,
        analysisId: 'analysis:current',
      }],
    },
  });
  await store.claimJob({
    queue: 'translation',
    workerId: 'crashed-worker',
    leaseMs: 1_000,
  });

  now += 1_001;
  const recovery = await store.claimJob({
    queue: 'translation',
    workerId: 'recovery-worker',
    leaseMs: 1_000,
  });
  const state = await store.read();

  assert.equal(recovery.maintenance, true);
  assert.equal(state.jobs['translation-crashed-last-attempt'].status, 'failed');
  assert.equal(state.translations[remark.key].error.code, 'RETRY_BUDGET_EXHAUSTED');
  assert.equal(state.translations[remark.key].error.analysisId, 'analysis:current');
});

test('RB-03 ANALYZE-07: старый fencing token не может записать model artifact', async (t) => {
  let now = Date.parse('2026-07-29T10:00:00.000Z');
  const { store } = await temporaryStore(t, now);
  store.clock = () => now;
  const current = fixtureSnapshot();
  const remark = current.pullRequests[0].remarks[0];
  await store.applyRepositorySnapshot(current);
  await store.enqueueJob({
    id: 'analysis-job',
    queue: 'analysis',
    dedupKey: 'analysis:fence',
    payload: { items: [{ key: remark.key }] },
    maxAttempts: 3,
  });
  const oldLease = await store.claimJob({
    queue: 'analysis',
    workerId: 'old-worker',
    leaseMs: 1000,
  });
  now += 1001;
  await store.claimJob({
    queue: 'analysis',
    workerId: 'new-worker',
    leaseMs: 1000,
  });

  await assert.rejects(
    store.compareAndSetAnalysisBatch([{
      itemKey: remark.key,
      versionId: remark.versionId,
      headSha: current.pullRequests[0].headSha,
      artifact: { analysisId: 'analysis:late' },
    }], {
      jobLease: {
        jobId: oldLease.id,
        workerId: 'old-worker',
        fencingToken: oldLease.fencingToken,
      },
    }),
    (error) => error.code === 'STALE_FENCE',
  );
  assert.equal((await store.read()).analyses[remark.key], undefined);
});

test('WATCH-RATE-03 UI-04: cooldown и readVersion сохраняются на диске', async (t) => {
  const { root, store } = await temporaryStore(t);
  await store.applyRepositorySnapshot(fixtureSnapshot());
  await store.setRateLimit('credential-fingerprint', {
    until: Date.parse('2026-07-29T10:10:00.000Z'),
    reason: 'secondary_rate_limit',
    attempts: 2,
  });
  await store.markRead({ repoNodeId: 'R_repo', prNodeId: 'PR_1', version: 1 });

  const restarted = new ReviewStore({ stateDir: root });
  assert.equal((await restarted.getRateLimit('credential-fingerprint')).attempts, 2);
  assert.equal((await restarted.read()).readVersions['pr:v1:WyJSX3JlcG8iLCJQUl8xIl0'], 1);
});

test('UI-04: готовый analysis и translation снова делают текущий PR непрочитанным', async (t) => {
  const { store } = await temporaryStore(t);
  const current = fixtureSnapshot();
  const pullRequest = current.pullRequests[0];
  const remark = pullRequest.remarks[0];
  await store.applyRepositorySnapshot(current);
  await store.markRead({ repoNodeId: 'R_repo', prNodeId: 'PR_1', version: 1 });
  const analysis = {
    analysisId: 'analysis:attention',
    itemKey: remark.key,
    versionId: remark.versionId,
    headSha: pullRequest.headSha,
  };
  await store.compareAndSetAnalysis({
    itemKey: remark.key,
    versionId: remark.versionId,
    headSha: pullRequest.headSha,
    artifact: analysis,
  });
  let saved = (await store.getRepositorySnapshot('R_repo')).pullRequests[0];
  assert.equal(saved.attentionVersion, 2);
  assert.equal(saved.readVersion, 1);

  await store.markRead({ repoNodeId: 'R_repo', prNodeId: 'PR_1', version: 2 });
  const translation = {
    translationId: 'translation:attention',
    analysisId: analysis.analysisId,
    itemKey: remark.key,
    versionId: remark.versionId,
  };
  await store.compareAndSetTranslation({
    itemKey: remark.key,
    versionId: remark.versionId,
    headSha: pullRequest.headSha,
    analysisId: analysis.analysisId,
    artifact: translation,
  });
  saved = (await store.getRepositorySnapshot('R_repo')).pullRequests[0];
  assert.equal(saved.attentionVersion, 3);
  assert.equal(saved.readVersion, 2);

  await store.compareAndSetTranslation({
    itemKey: remark.key,
    versionId: remark.versionId,
    headSha: pullRequest.headSha,
    analysisId: analysis.analysisId,
    artifact: translation,
  });
  assert.equal(
    (await store.getRepositorySnapshot('R_repo')).pullRequests[0].attentionVersion,
    3,
    'идемпотентный CAS не создаёт новое уведомление',
  );
});

test('FRESH-08: поздний перевод закрытого замечания не становится current', async (t) => {
  const { store } = await temporaryStore(t);
  const opened = fixtureSnapshot();
  const pullRequest = opened.pullRequests[0];
  const remark = pullRequest.remarks[0];
  await store.applyRepositorySnapshot(opened);
  const analysis = {
    analysisId: 'analysis:before-close',
    itemKey: remark.key,
    versionId: remark.versionId,
    headSha: pullRequest.headSha,
  };
  assert.equal((await store.compareAndSetAnalysis({
    itemKey: remark.key,
    versionId: remark.versionId,
    headSha: pullRequest.headSha,
    artifact: analysis,
  })).applied, true);

  const closed = structuredClone(opened);
  closed.pullRequests[0].remarks[0].state = 'closed';
  // Сохраняем versionId, имитируя самый опасный late-result race: защита не
  // должна полагаться только на смену версии.
  await store.applyRepositorySnapshot(closed);
  const result = await store.compareAndSetTranslation({
    itemKey: remark.key,
    versionId: remark.versionId,
    headSha: pullRequest.headSha,
    analysisId: analysis.analysisId,
    artifact: {
      translationId: 'translation:late-after-close',
      analysisId: analysis.analysisId,
      itemKey: remark.key,
      versionId: remark.versionId,
    },
  });

  assert.deepEqual(result, { applied: false, reason: 'remark_inactive' });
  assert.equal((await store.read()).translations[remark.key], undefined);
});

test('UI-04: изменение одного PR не возвращает unread соседнему PR', async (t) => {
  const { store } = await temporaryStore(t);
  await store.applyRepositorySnapshot(withSecondPullRequest(fixtureSnapshot()));
  await store.markRead({ repoNodeId: 'R_repo', prNodeId: 'PR_1', version: 1 });
  await store.markRead({ repoNodeId: 'R_repo', prNodeId: 'PR_2', version: 1 });

  await store.applyRepositorySnapshot(withSecondPullRequest(fixtureSnapshot({
    body: 'Изменилось только первое замечание',
  })));
  const pullRequests = (await store.getRepositorySnapshot('R_repo')).pullRequests;
  const first = pullRequests.find((item) => item.prNodeId === 'PR_1');
  const second = pullRequests.find((item) => item.prNodeId === 'PR_2');

  assert.equal(first.attentionVersion, 2);
  assert.equal(first.readVersion, 1);
  assert.equal(second.attentionVersion, 1);
  assert.equal(second.readVersion, 1);
});

test('SYNC-02: исчезнувший из OPEN pagination PR остаётся закрытой историей', async (t) => {
  const { store } = await temporaryStore(t);
  await store.applyRepositorySnapshot(withSecondPullRequest(fixtureSnapshot()));

  const outcome = await store.applyRepositorySnapshot(fixtureSnapshot());
  const repository = await store.getRepositorySnapshot('R_repo');
  const archived = repository.pullRequests.find((item) => item.prNodeId === 'PR_2');

  assert.equal(outcome.cancelledRemarks.some(({ remark }) => remark.prNodeId === 'PR_2'), true);
  assert.equal(archived.state, 'closed');
  assert.equal(archived.remarks[0].state, 'closed');
  assert.equal(archived.remarks[0].actionable, false);
  assert.equal(archived.attentionVersion, 1, 'закрытие не создаёт новый unread');
});

test('RETENTION-01: неизменный sync удаляет просроченный PR и его артефакты', async (t) => {
  let now = Date.parse('2026-07-29T10:00:00.000Z');
  const { store } = await temporaryStore(t, now);
  store.clock = () => now;
  const snapshot = fixtureSnapshot();
  const remark = snapshot.pullRequests[0].remarks[0];
  await store.applyRepositorySnapshot(snapshot);
  await store.compareAndSetAnalysis({
    itemKey: remark.key,
    versionId: remark.versionId,
    headSha: snapshot.pullRequests[0].headSha,
    artifact: {
      analysisId: 'analysis:retained',
      itemKey: remark.key,
      versionId: remark.versionId,
      headSha: snapshot.pullRequests[0].headSha,
    },
  });
  await store.compareAndSetTranslation({
    itemKey: remark.key,
    versionId: remark.versionId,
    headSha: snapshot.pullRequests[0].headSha,
    analysisId: 'analysis:retained',
    artifact: {
      translationId: 'translation:retained',
      analysisId: 'analysis:retained',
      itemKey: remark.key,
      versionId: remark.versionId,
    },
  });
  const emptySnapshot = {
    repoNodeId: snapshot.repoNodeId,
    nameWithOwner: snapshot.nameWithOwner,
    syncedAt: new Date(now).toISOString(),
    pullRequests: [],
  };
  await store.applyRepositorySnapshot(emptySnapshot);
  assert.equal((await store.read()).repositories.R_repo.pullRequests.length, 1);

  now += 91 * 24 * 60 * 60_000;
  const compacted = await store.applyRepositorySnapshot({
    ...emptySnapshot,
    syncedAt: new Date(now).toISOString(),
  });
  const state = await store.read();

  assert.equal(compacted.changed, true);
  assert.deepEqual(state.repositories.R_repo.pullRequests, []);
  assert.equal(state.analyses[remark.key], undefined);
  assert.equal(state.translations[remark.key], undefined);
});

test('RB-03: два экземпляра store не теряют конкурентные обновления под OS flock', async (t) => {
  const { root, store: first } = await temporaryStore(t);
  const second = new ReviewStore({ stateDir: root });
  const increments = Array.from({ length: 20 }, (_, index) => (
    (index % 2 ? first : second).mutate(async (state) => {
      const value = Number(state.watcher.counter || 0);
      await new Promise((resolve) => setImmediate(resolve));
      state.watcher.counter = value + 1;
    })
  ));

  await Promise.all(increments);
  assert.equal((await first.read()).watcher.counter, 20);
});

test('REVIEW-STORE-LOCK-LOST: parent fd удерживает kernel lock до commit', async (t) => {
  const { root, store: first } = await temporaryStore(t);
  const second = new ReviewStore({ stateDir: root, lockTimeoutMs: 20 });
  let entered;
  let release;
  const inside = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const holder = first.mutate(async (state) => {
    entered();
    await barrier;
    state.watcher.first = true;
  });
  await inside;
  await assert.rejects(
    second.mutate((state) => { state.watcher.second = true; }),
    (error) => error.code === 'REVIEW_STORE_LOCK_TIMEOUT',
  );
  release();
  await holder;
  const persisted = await first.read();
  assert.equal(persisted.watcher.first, true);
  assert.equal(persisted.watcher.second, undefined);
});
