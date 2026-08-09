import assert from 'node:assert/strict';
import test from 'node:test';

import {
  telegramActivationBounds,
  telegramActivationCodec,
  telegramActivationEpochFor,
  telegramActivationMarker,
} from '../../server/src/lib/telegram/activation.js';

const marker = (afterSeq, afterOccurredAt) => ({ schema: 1, afterSeq, afterOccurredAt });

test('marker фиксирует seq и provider occurrence boundary в canonical schema', () => {
  assert.deepEqual(
    telegramActivationMarker({ afterSeq: 7, nowMs: 12_999 }),
    marker(7, 12),
  );
  assert.deepEqual(
    telegramActivationMarker({ afterSeq: 8, occurredAt: 10, nowMs: 99_999 }),
    marker(8, 10),
  );
  assert.deepEqual(telegramActivationCodec.decode(marker(1, 2)), marker(1, 2));
  assert.throws(
    () => telegramActivationCodec.decode({ schema: 1, afterSeq: 1, afterOccurredAt: 2, extra: true }),
    /schema|поля/i,
  );
});

test('seq boundary, late delivery, gaps и history без seq fail-closed', () => {
  const windows = [
    { epoch: 1, startMarker: marker(10, 100), endMarker: marker(20, 200) },
    { epoch: 2, startMarker: marker(30, 300), endMarker: null },
  ];
  const epoch = (seq, occurredAt) => telegramActivationEpochFor({ seq, occurredAt }, windows);

  assert.equal(epoch(10, 101), null, 'exact seq start — history');
  assert.equal(
    epoch(11, 100),
    1,
    'post-marker append в ту же provider-секунду не теряется',
  );
  assert.equal(epoch(11, 99), null, 'late delivery до provider-time start — history');
  assert.equal(epoch(11, 101), 1);
  assert.equal(epoch(21, 201), null, 'после закрывающего marker — gap');
  assert.equal(epoch(31, 150), null, 'late delivery не становится epoch 2');
  assert.equal(epoch(31, 301), 2);
  assert.equal(telegramActivationEpochFor({ seq: null, occurredAt: 999 }, windows), null);
  assert.equal(telegramActivationEpochFor({ occurredAt: 999 }, windows), null);

  assert.deepEqual(telegramActivationBounds(windows), {
    windows: [
      { epoch: 1, startMarker: marker(10, 100), endMarker: marker(20, 200) },
      { epoch: 2, startMarker: marker(30, 300), endMarker: null },
    ],
    afterSeq: 10,
    throughSeq: null,
  });
});

test('обратные, пересекающиеся и следующие за open windows отвергаются', () => {
  assert.throws(() => telegramActivationEpochFor({ seq: 2, occurredAt: 2 }, [
    { epoch: 1, startMarker: marker(10, 100), endMarker: marker(9, 101) },
  ]), /обратную/i);
  assert.throws(() => telegramActivationEpochFor({ seq: 2, occurredAt: 2 }, [
    { epoch: 1, startMarker: marker(10, 100), endMarker: marker(20, 200) },
    { epoch: 2, startMarker: marker(19, 201), endMarker: null },
  ]), /пересекается/i);
  assert.throws(() => telegramActivationEpochFor({ seq: 2, occurredAt: 2 }, [
    { epoch: 1, startMarker: marker(1, 1), endMarker: null },
    { epoch: 2, startMarker: marker(2, 2), endMarker: null },
  ]), /открытой/i);
});
