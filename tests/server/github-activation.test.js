import assert from 'node:assert/strict';
import test from 'node:test';

import {
  githubActivationCodec,
  githubActivationEpochFor,
  githubActivationMarker,
  githubIssueBundleKey,
} from '../../server/src/lib/github/activation.js';

const marker = (afterSeq, afterOccurredAt) => ({ schema: 1, afterSeq, afterOccurredAt });

test('GitHub marker exact, canonical и строится только из server boundary', () => {
  assert.deepEqual(githubActivationMarker({ afterSeq: 7, nowMs: 12_999 }), marker(7, 12));
  assert.deepEqual(githubActivationCodec.decode(marker(7, 12)), marker(7, 12));
  for (const bad of [
    { ...marker(7, 12), extra: true },
    { schema: 2, afterSeq: 7, afterOccurredAt: 12 },
    { schema: 1, afterSeq: -1, afterOccurredAt: 12 },
    { schema: 1, afterSeq: 7, afterOccurredAt: 1.2 },
  ]) assert.throws(() => githubActivationCodec.decode(bad), /GitHub marker/);
});

test('late redelivery не перескакивает start, а запись после close не возвращается из gap', () => {
  const windows = [
    { epoch: 1, startMarker: marker(10, 100), endMarker: marker(20, 200) },
    { epoch: 2, startMarker: marker(30, 300), endMarker: null },
  ];

  assert.equal(githubActivationEpochFor({ seq: 11, occurredAt: 101 }, windows), 1);
  assert.equal(githubActivationEpochFor({ seq: 20, occurredAt: 200 }, windows), 1);
  assert.equal(githubActivationEpochFor({ seq: 31, occurredAt: 301 }, windows), 2);
  assert.equal(githubActivationEpochFor({ seq: 11, occurredAt: 100 }, windows), null, 'start equality — history');
  assert.equal(githubActivationEpochFor({ seq: 31, occurredAt: 150 }, windows), null, 'late old issue не входит во вторую epoch');
  assert.equal(githubActivationEpochFor({ seq: 21, occurredAt: 201 }, windows), null, 'gap после deactivate исключён');
  assert.equal(githubActivationEpochFor({ seq: 29, occurredAt: 301 }, windows), null, 'provider time один не обходит local boundary');
});

test('GitHub grouping использует semantic issue id', () => {
  assert.deepEqual(githubIssueBundleKey({ channel: 'github', id: '9988' }), { kind: 'issue', id: '9988' });
  assert.throws(() => githubIssueBundleKey({ channel: 'telegram', id: '9988' }), /grouping/);
});
