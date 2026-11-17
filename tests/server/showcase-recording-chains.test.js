// Выбор цепочек записи: устаревшие и принудительно переснимаемые идут целиком.
import assert from 'node:assert/strict';
import test from 'node:test';

import { selectRecordingChains } from '../../server/src/lib/showcase/recordingOps.ts';

const scene = (id) => ({
  id,
  title: id,
  order: 1,
});
const CHAINS = [[scene('a'), scene('b')], [scene('c')]];

test('устаревшая сцена тянет свою цепочку продолжений', () => {
  const pending = selectRecordingChains(CHAINS, (id) => id === 'b', []);

  assert.deepEqual(pending.map((item) => item.id), ['a', 'b']);
});

test('принудительная пересъёмка свежей сцены берёт её цепочку', () => {
  const pending = selectRecordingChains(CHAINS, () => false, ['c']);

  assert.deepEqual(pending.map((item) => item.id), ['c']);

  const chain = selectRecordingChains(CHAINS, () => false, ['b']);

  assert.deepEqual(chain.map((item) => item.id), ['a', 'b']);
});

test('без устаревших и без принуждения записывать нечего', () => {
  assert.deepEqual(selectRecordingChains(CHAINS, () => false, []), []);
});


test('явная пересъёмка не включает другую устаревшую цепочку', () => {
  const pending = selectRecordingChains(CHAINS, (id) => id === 'b', ['c']);

  assert.deepEqual(pending.map((item) => item.id), ['c']);
});
