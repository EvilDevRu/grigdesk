import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  normalizeSeenTaskId,
  TaskSeenStore,
} from '../../server/src/lib/task-seen-store.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-task-seen-'));
  const filePath = path.join(root, 'task-seen.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { filePath, store: new TaskSeenStore({ filePath }) };
}

test('SEEN-STORE-01: пустой scope не инициализирован и пуст', async (t) => {
  const { store } = await fixture(t);

  assert.deepEqual(await store.list('scope-a'), {
    revision: 0,
    initialized: false,
    taskIds: [],
  });
});

test('SEEN-STORE-02: пометка сохраняется, переживает новый store и идемпотентна', async (t) => {
  const { filePath, store } = await fixture(t);

  assert.deepEqual(await store.markSeen('scope-a', ['00123']), {
    revision: 1,
    initialized: false,
    taskIds: ['123'],
  });
  assert.deepEqual(await store.markSeen('scope-a', [123]), {
    revision: 1,
    initialized: false,
    taskIds: ['123'],
  });

  const reopened = new TaskSeenStore({ filePath });
  assert.deepEqual(await reopened.list('scope-a'), {
    revision: 1,
    initialized: false,
    taskIds: ['123'],
  });
});

test('SEEN-STORE-03: initialized ставит только baseline, обычная пометка его не трогает', async (t) => {
  const { store } = await fixture(t);

  // Задачу открыли из конвейера раньше первой загрузки доски: набор ещё не базовый,
  // иначе все остальные давние задачи разом стали бы «новыми».
  const early = await store.markSeen('scope-a', ['5']);
  assert.equal(early.initialized, false);

  const baseline = await store.markSeen('scope-a', ['5', '6'], { baseline: true });
  assert.deepEqual(baseline, { revision: 2, initialized: true, taskIds: ['5', '6'] });

  // Повторная базовая линия без новых задач не крутит ревизию.
  assert.deepEqual(await store.markSeen('scope-a', ['5', '6'], { baseline: true }), {
    revision: 2,
    initialized: true,
    taskIds: ['5', '6'],
  });
});

test('SEEN-STORE-04: пустой baseline инициализирует scope', async (t) => {
  const { store } = await fixture(t);

  assert.deepEqual(await store.markSeen('scope-a', [], { baseline: true }), {
    revision: 1,
    initialized: true,
    taskIds: [],
  });
});

test('SEEN-STORE-05: области B24-аккаунтов изолированы', async (t) => {
  const { store } = await fixture(t);

  await store.markSeen('scope-a', ['11'], { baseline: true });
  await store.markSeen('scope-b', ['22']);

  assert.deepEqual(await store.list('scope-a'), {
    revision: 1, initialized: true, taskIds: ['11'],
  });
  assert.deepEqual(await store.list('scope-b'), {
    revision: 1, initialized: false, taskIds: ['22'],
  });
});

test('SEEN-STORE-06: параллельные пометки не теряют обновления read-modify-write', async (t) => {
  const { store } = await fixture(t);

  await Promise.all([
    store.markSeen('scope-a', ['1']),
    store.markSeen('scope-a', ['2', '3']),
    store.markSeen('scope-a', ['4']),
    store.markSeen('scope-a', [], { baseline: true }),
  ]);

  const snapshot = await store.list('scope-a');
  assert.equal(snapshot.initialized, true);
  assert.deepEqual([...snapshot.taskIds].sort(), ['1', '2', '3', '4']);
  assert.equal(snapshot.revision, 4);
});

test('SEEN-STORE-07: файл создаётся с правами 0600', async (t) => {
  const { filePath, store } = await fixture(t);
  await store.markSeen('scope-a', ['1']);

  const info = await stat(filePath);
  assert.equal(info.mode & 0o777, 0o600);
});

test('SEEN-STORE-08: повреждённый JSON не заменяется пустым набором', async (t) => {
  const { filePath, store } = await fixture(t);
  const corrupt = '{"schemaVersion":1,"scopes":';
  await writeFile(filePath, corrupt, { mode: 0o600 });

  await assert.rejects(
    store.markSeen('scope-a', ['1']),
    (error) => error?.code === 'TASK_SEEN_CORRUPT',
  );
  assert.equal(await readFile(filePath, 'utf8'), corrupt);
});

test('SEEN-STORE-09: task id нормализуется строго до положительного целого', async (t) => {
  const { store } = await fixture(t);

  assert.equal(normalizeSeenTaskId('00042'), '42');
  assert.equal(normalizeSeenTaskId(42), '42');
  for (const value of ['', '0', 0, -1, '1.5', 1.5, 'abc', '1'.repeat(21), null]) {
    assert.throws(
      () => normalizeSeenTaskId(value),
      (error) => error?.code === 'BAD_SEEN_TASK_ID',
    );
    await assert.rejects(
      store.markSeen('scope-a', [value]),
      (error) => error?.code === 'BAD_SEEN_TASK_ID',
    );
  }
});

test('SEEN-STORE-10: набор ограничен сверху и режется с головы', async (t) => {
  const { store } = await fixture(t);
  const first = Array.from({ length: 2000 }, (_, index) => String(index + 1));
  await store.markSeen('scope-a', first);

  const snapshot = await store.markSeen('scope-a', ['9001', '9002']);
  assert.equal(snapshot.taskIds.length, 2000);
  assert.equal(snapshot.taskIds[0], '3');
  assert.deepEqual(snapshot.taskIds.slice(-2), ['9001', '9002']);
});
