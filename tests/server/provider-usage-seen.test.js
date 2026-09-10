import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProviderUsageSeenStore, isFreshGroup } from '../../server/src/lib/providerUsageSeen.ts';

const DAY = 24 * 60 * 60 * 1000;

function tempStore(now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-usage-seen-'));

  return {
    dir,
    filePath: path.join(dir, 'provider-usage-seen.json'),
    open(clock = now) {
      return new ProviderUsageSeenStore({ filePath: path.join(dir, 'provider-usage-seen.json'), now: clock });
    },
  };
}

test('the first observation is a baseline, so nothing is announced as new', () => {
  // Иначе первый же показ объявит новым сразу весь список — та же грабля, что
  // с меткой «новая» у задач B24, где пустой набор нельзя путать с «не смотрели».
  const at = 1_800_000_000_000;
  const store = tempStore(() => at);
  const firstSeen = store.open().observe('codex', ['codex', 'codex_bengalfox']);

  assert.deepEqual(firstSeen, { codex: 0, codex_bengalfox: 0 });
  assert.equal(isFreshGroup(firstSeen.codex, at), false);

  fs.rmSync(store.dir, { recursive: true, force: true });
});

test('a bucket that appears after the baseline is fresh and then fades on its own', () => {
  const at = 1_800_000_000_000;
  const store = tempStore(() => at);

  store.open().observe('codex', ['codex']);

  const firstSeen = store.open(() => at + DAY).observe('codex', ['codex', 'base_model_inference']);

  assert.equal(firstSeen.codex, 0);
  assert.equal(firstSeen.base_model_inference, at + DAY);
  assert.equal(isFreshGroup(firstSeen.base_model_inference, at + DAY), true);
  assert.equal(isFreshGroup(firstSeen.base_model_inference, at + DAY + 13 * DAY), true);
  assert.equal(isFreshGroup(firstSeen.base_model_inference, at + DAY + 15 * DAY), false);

  fs.rmSync(store.dir, { recursive: true, force: true });
});

test('a bucket present in the answer is never evicted and cannot fake being new', () => {
  // Выброси запись присутствующего ведра — и оно вернётся с новым временем, то есть
  // притворится новым. Вытесняются только те, которых в текущем ответе уже нет.
  const at = 1_800_000_000_000;
  const store = tempStore(() => at);
  const groups = Array.from({ length: 70 }, (unused, index) => `bucket-${index}`);

  store.open().observe('codex', groups);

  const firstSeen = store.open(() => at + DAY).observe('codex', groups);

  assert.equal(Object.keys(firstSeen).length, groups.length);
  assert.deepEqual([...new Set(Object.values(firstSeen))], [0]);

  fs.rmSync(store.dir, { recursive: true, force: true });
});

test('a corrupt file re-baselines instead of announcing every bucket as new', () => {
  const at = 1_800_000_000_000;
  const store = tempStore(() => at);

  fs.writeFileSync(store.filePath, '{ это не json');

  const firstSeen = store.open().observe('codex', ['codex', 'base_model_inference']);

  assert.deepEqual(firstSeen, { codex: 0, base_model_inference: 0 });

  fs.rmSync(store.dir, { recursive: true, force: true });
});

test('memory survives a restart, so a bucket is not re-announced every time', () => {
  const at = 1_800_000_000_000;
  const store = tempStore(() => at);

  store.open().observe('codex', ['codex']);
  store.open(() => at + DAY).observe('codex', ['codex', 'base_model_inference']);

  const later = store.open(() => at + 2 * DAY).observe('codex', ['codex', 'base_model_inference']);

  assert.equal(later.base_model_inference, at + DAY);

  fs.rmSync(store.dir, { recursive: true, force: true });
});
