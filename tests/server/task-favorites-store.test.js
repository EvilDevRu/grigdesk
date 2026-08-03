import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  normalizeFavoriteTaskId,
  TaskFavoritesStore,
} from '../../server/src/lib/task-favorites-store.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-task-favorites-'));
  const filePath = path.join(root, 'task-favorites.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { filePath, store: new TaskFavoritesStore({ filePath }) };
}

test('STORE-01: пустой scope имеет нулевую ревизию и пустой список', async (t) => {
  const { store } = await fixture(t);

  assert.deepEqual(await store.list('scope-a'), {
    revision: 0,
    taskIds: [],
  });
});

test('STORE-02/03: add сохраняется, переживает новый store и идемпотентен', async (t) => {
  const { filePath, store } = await fixture(t);

  assert.deepEqual(await store.add('scope-a', '00123'), {
    revision: 1,
    taskIds: ['123'],
  });
  assert.deepEqual(await store.add('scope-a', 123), {
    revision: 1,
    taskIds: ['123'],
  });

  const reopened = new TaskFavoritesStore({ filePath });
  assert.deepEqual(await reopened.list('scope-a'), {
    revision: 1,
    taskIds: ['123'],
  });
  assert.deepEqual(await reopened.remove('scope-a', '123'), {
    revision: 2,
    taskIds: [],
  });
  assert.deepEqual(await reopened.remove('scope-a', '123'), {
    revision: 2,
    taskIds: [],
  });
});

test('STORE-04: области B24-аккаунтов изолированы', async (t) => {
  const { store } = await fixture(t);

  await store.add('scope-a', '11');
  await store.add('scope-b', '22');

  assert.deepEqual(await store.list('scope-a'), { revision: 1, taskIds: ['11'] });
  assert.deepEqual(await store.list('scope-b'), { revision: 1, taskIds: ['22'] });
});

test('STORE-05: параллельные add не теряют обновления read-modify-write', async (t) => {
  const { store } = await fixture(t);

  await Promise.all([
    store.add('scope-a', '1'),
    store.add('scope-a', '2'),
    store.add('scope-a', '3'),
    store.add('scope-a', '4'),
  ]);

  assert.deepEqual(await store.list('scope-a'), {
    revision: 4,
    taskIds: ['1', '2', '3', '4'],
  });
});

test('STORE-06: смешанные параллельные мутации дают последовательный результат', async (t) => {
  const { store } = await fixture(t);
  await store.add('scope-a', '1');
  await store.add('scope-a', '2');

  await Promise.all([
    store.remove('scope-a', '1'),
    store.add('scope-a', '3'),
    store.add('scope-a', '4'),
  ]);

  assert.deepEqual(await store.list('scope-a'), {
    revision: 5,
    taskIds: ['2', '3', '4'],
  });
});

test('STORE-07: файл избранного создаётся с правами 0600', async (t) => {
  const { filePath, store } = await fixture(t);
  await store.add('scope-a', '1');

  const info = await stat(filePath);
  assert.equal(info.mode & 0o777, 0o600);
});

test('STORE-08: повреждённый JSON не заменяется пустым списком', async (t) => {
  const { filePath, store } = await fixture(t);
  const corrupt = '{"schemaVersion":1,"scopes":';
  await writeFile(filePath, corrupt, { mode: 0o600 });

  await assert.rejects(
    store.add('scope-a', '1'),
    (error) => error?.code === 'TASK_FAVORITES_CORRUPT',
  );
  assert.equal(await readFile(filePath, 'utf8'), corrupt);
});

test('STORE-09: task id нормализуется строго до положительного целого', async (t) => {
  const { store } = await fixture(t);

  assert.equal(normalizeFavoriteTaskId('00042'), '42');
  assert.equal(normalizeFavoriteTaskId(42), '42');
  for (const value of ['', '0', 0, -1, '1.5', 1.5, 'abc', '1'.repeat(21), null]) {
    assert.throws(
      () => normalizeFavoriteTaskId(value),
      (error) => error?.code === 'BAD_FAVORITE_TASK_ID',
    );
    await assert.rejects(
      store.add('scope-a', value),
      (error) => error?.code === 'BAD_FAVORITE_TASK_ID',
    );
  }
});
