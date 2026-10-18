import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

let shelfModule;
let shelfModuleError;
try {
  shelfModule = await import('../../server/src/lib/taskShelfStore.ts');
} catch (error) {
  shelfModuleError = error;
}

function requireShelfModule() {
  assert.ok(
    shelfModule,
    `Серверный стор полки ещё не реализован: ${shelfModuleError?.message || 'нет экспорта'}`,
  );
  return shelfModule;
}

function snapshot(unread = 0) {
  return {
    analysis: null,
    pipeline: null,
    b24: {
      present: true,
      status: 'IN_PROGRESS',
      statusKind: 'active',
      unread,
    },
  };
}

function input(overrides = {}) {
  return {
    title: 'Проверить поставку',
    reason: 'manual',
    snapshot: snapshot(),
    createIfMissing: true,
    ...overrides,
  };
}

async function fixture(t) {
  const { TaskShelfStore } = requireShelfModule();
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-task-shelf-'));
  const filePath = path.join(root, 'task-shelf.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { filePath, store: new TaskShelfStore({ filePath }) };
}

test('Пустая полка имеет нулевую ревизию и пустой список', async (t) => {
  const { store } = await fixture(t);

  assert.deepEqual(await store.list('scope-a'), { revision: 0, entries: [] });
});

test('Первая постановка канонизирует id и назначает серверное время', async (t) => {
  const { store } = await fixture(t);
  const before = Date.now();
  const result = await store.put('scope-a', '0042', input());

  assert.deepEqual({
    revision: result.revision,
    taskId: result.entries[0]?.taskId,
    title: result.entries[0]?.title,
    reason: result.entries[0]?.reason,
    snapshot: result.entries[0]?.snapshot,
    addedAtIsServerTime: Date.parse(result.entries[0]?.addedAt) >= before,
  }, {
    revision: 1,
    taskId: '42',
    title: 'Проверить поставку',
    reason: 'manual',
    snapshot: snapshot(),
    addedAtIsServerTime: true,
  });
});

test('Время оценки принимается числом, а запись прошлого формата переводится', async (t) => {
  const { store } = await fixture(t);
  const withAnalysis = (queuedAt) => ({
    ...input(),
    snapshot: {
      ...snapshot(),
      analysis: {
        state: 'queued',
        queuedAt,
        startedAt: null,
        finishedAt: null,
        generatedAt: null,
      },
    },
  });
  const numeric = await store.put('scope-a', 42, withAnalysis(1_788_249_600_000));
  const legacy = await store.put('scope-b', 42, withAnalysis('2026-09-01T08:00:00.000Z'));

  assert.deepEqual([
    numeric.entries[0]?.snapshot.analysis?.queuedAt,
    legacy.entries[0]?.snapshot.analysis?.queuedAt,
  ], [1_788_249_600_000, 1_788_249_600_000]);
  await assert.rejects(() => store.put('scope-c', 42, withAnalysis('позавчера')));
});

test('Повторная запись без изменений сохраняет revision и addedAt', async (t) => {
  const { store } = await fixture(t);
  const first = await store.put('scope-a', 42, input());
  const second = await store.put('scope-a', 42, input());

  assert.deepEqual(
    [second.revision, second.entries[0]?.addedAt],
    [first.revision, first.entries[0]?.addedAt],
  );
});

test('Авто-постановка не перезаписывает снимок уже лежащей записи', async (t) => {
  const { store } = await fixture(t);
  const first = await store.put('scope-a', 42, input());
  const second = await store.put('scope-a', 42, input({
    reason: 'analysis',
    snapshot: snapshot(7),
    createIfMissing: true,
  }));

  assert.deepEqual(second, first);
});

test('Обновление снимка существующей записи не меняет addedAt', async (t) => {
  const { store } = await fixture(t);
  const first = await store.put('scope-a', 42, input());
  const second = await store.put('scope-a', 42, input({
    snapshot: snapshot(3),
    createIfMissing: false,
  }));

  assert.deepEqual({
    revision: second.revision,
    addedAt: second.entries[0]?.addedAt,
    unread: second.entries[0]?.snapshot?.b24?.unread,
  }, {
    revision: 2,
    addedAt: first.entries[0]?.addedAt,
    unread: 3,
  });
});

test('Acknowledge после удаления не воскрешает запись', async (t) => {
  const { store } = await fixture(t);
  await store.put('scope-a', 42, input());
  await store.remove('scope-a', 42);

  assert.deepEqual(
    await store.put('scope-a', 42, input({ createIfMissing: false })),
    { revision: 2, entries: [] },
  );
});

test('Области портальных аккаунтов изолированы', async (t) => {
  const { store } = await fixture(t);
  await store.put('scope-a', 11, input({ title: 'A' }));
  await store.put('scope-b', 22, input({ title: 'B' }));

  assert.deepEqual([
    await store.list('scope-a'),
    await store.list('scope-b'),
  ].map((value) => value.entries.map((entry) => entry.taskId)), [['11'], ['22']]);
});

test('Смешанные параллельные мутации не теряют записи', async (t) => {
  const { store } = await fixture(t);
  await store.put('scope-a', 1, input());
  await store.put('scope-a', 2, input());
  await Promise.all([
    store.remove('scope-a', 1),
    store.put('scope-a', 3, input()),
    store.put('scope-a', 4, input()),
  ]);

  const result = await store.list('scope-a');
  assert.deepEqual({
    revision: result.revision,
    taskIds: result.entries.map((entry) => entry.taskId),
  }, {
    revision: 5,
    taskIds: ['2', '3', '4'],
  });
});

test('Файл полки создаётся с правами 0600', async (t) => {
  const { filePath, store } = await fixture(t);
  await store.put('scope-a', 1, input());

  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test('Сбой создания временного файла сохраняет прежний полный JSON', async (t) => {
  const { filePath, store } = await fixture(t);
  await store.put('scope-a', 1, input());
  const before = await readFile(filePath, 'utf8');
  const root = path.dirname(filePath);
  await chmod(root, 0o500);
  let errorCode = null;
  try {
    await store.put('scope-a', 2, input());
  } catch (error) {
    errorCode = error?.code;
  } finally {
    await chmod(root, 0o700);
  }

  assert.deepEqual({ errorCode, source: await readFile(filePath, 'utf8') }, {
    errorCode: 'TASK_SHELF_UNAVAILABLE',
    source: before,
  });
});

test('Повреждённый JSON не заменяется пустой полкой', async (t) => {
  const { filePath, store } = await fixture(t);
  const corrupt = '{"schemaVersion":1,"scopes":';
  await writeFile(filePath, corrupt, { mode: 0o600 });
  let errorCode = null;
  try {
    await store.put('scope-a', 1, input());
  } catch (error) {
    errorCode = error?.code;
  }

  assert.deepEqual({
    errorCode,
    source: await readFile(filePath, 'utf8'),
  }, {
    errorCode: 'TASK_SHELF_CORRUPT',
    source: corrupt,
  });
});

test('Неизвестная версия схемы не перезаписывается', async (t) => {
  const { filePath, store } = await fixture(t);
  const corrupt = JSON.stringify({ schemaVersion: 99, scopes: {} });
  await writeFile(filePath, corrupt, { mode: 0o600 });

  await assert.rejects(
    store.list('scope-a'),
    (error) => error?.code === 'TASK_SHELF_CORRUPT',
  );
});

test('Некорректная вложенная запись не превращается в пустую полку', async (t) => {
  const { filePath, store } = await fixture(t);
  await writeFile(filePath, JSON.stringify({
    schemaVersion: 1,
    scopes: {
      'scope-a': {
        revision: 1,
        entries: [{ taskId: '42', addedAt: 'not-a-date', reason: 'manual' }],
      },
    },
  }), { mode: 0o600 });

  await assert.rejects(
    store.list('scope-a'),
    (error) => error?.code === 'TASK_SHELF_CORRUPT',
  );
});
