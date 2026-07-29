import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRemarkIdentity,
  createRemarkVersion,
  serializeRemarkIdentity,
  snapshotDigest,
  snapshotKey,
} from '../../server/src/lib/reviews/identity.js';

test('SYNC-04 RB-02: репозиторий и PR входят в устойчивый ключ замечания', () => {
  const first = createRemarkIdentity({
    repoNodeId: 'R_repo_a',
    prNodeId: 'PR_same_number_a',
    kind: 'issue_comment',
    commentNodeId: 'IC_42',
  });
  const second = createRemarkIdentity({
    repoNodeId: 'R_repo_b',
    prNodeId: 'PR_same_number_b',
    kind: 'issue_comment',
    commentNodeId: 'IC_42',
  });

  assert.notEqual(first.key, second.key);
  assert.equal(snapshotKey(first.repoNodeId, first.prNodeId), 'pr:v1:WyJSX3JlcG9fYSIsIlBSX3NhbWVfbnVtYmVyX2EiXQ');
});

test('SYNC-05 RB-02: тип и thread ID не дают смешать разные источники', () => {
  const common = {
    repoNodeId: 'R_repo',
    prNodeId: 'PR_7',
    commentNodeId: 'C_9',
  };
  const review = serializeRemarkIdentity({ ...common, kind: 'review_body' });
  const issue = serializeRemarkIdentity({ ...common, kind: 'issue_comment' });
  const threadA = serializeRemarkIdentity({
    ...common,
    kind: 'thread_comment',
    threadNodeId: 'T_a',
  });
  const threadB = serializeRemarkIdentity({
    ...common,
    kind: 'thread_comment',
    threadNodeId: 'T_b',
  });

  assert.equal(new Set([review, issue, threadA, threadB]).size, 4);
});

test('SYNC-03: версия зависит от SHA, состояния, updatedAt и полного хеша тела', () => {
  const identity = {
    repoNodeId: 'R_repo',
    prNodeId: 'PR_7',
    kind: 'issue_comment',
    commentNodeId: 'IC_1',
  };
  const base = {
    ...identity,
    headSha: '1111111111111111111111111111111111111111',
    state: 'open',
    updatedAt: '2026-07-29T10:00:00.000Z',
    body: 'Полный исходный текст',
  };
  const version = createRemarkVersion(base);

  assert.match(version.bodyHash, /^[a-f0-9]{64}$/);
  assert.match(version.versionId, /^remark-version:v1:[a-f0-9]{64}$/);
  for (const changed of [
    { headSha: '2222222222222222222222222222222222222222' },
    { state: 'resolved' },
    { updatedAt: '2026-07-29T10:00:01.000Z' },
    { body: 'Полный исходный текст.' },
  ]) {
    assert.notEqual(createRemarkVersion({ ...base, ...changed }).versionId, version.versionId);
  }
});

test('SYNC-03: служебное время синхронизации не меняет digest снимка', () => {
  const snapshot = {
    repoNodeId: 'R_repo',
    nameWithOwner: 'example/repo',
    pullRequests: [{
      prNodeId: 'PR_1',
      number: 1,
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      updatedAt: '2026-07-29T10:00:00.000Z',
      remarks: [],
    }],
  };

  assert.equal(
    snapshotDigest({ ...snapshot, syncedAt: '2026-07-29T10:01:00.000Z' }),
    snapshotDigest({ ...snapshot, syncedAt: '2026-07-29T10:02:00.000Z' }),
  );
});

test('identity отклоняет неполный thread key и управляющие символы', () => {
  assert.throws(() => createRemarkIdentity({
    repoNodeId: 'R_repo',
    prNodeId: 'PR_1',
    kind: 'thread_comment',
    commentNodeId: 'C_1',
  }), /threadNodeId/);
  assert.throws(() => createRemarkIdentity({
    repoNodeId: 'R_repo\nsecret',
    prNodeId: 'PR_1',
    kind: 'issue_comment',
    commentNodeId: 'C_1',
  }), /repoNodeId/);
});
