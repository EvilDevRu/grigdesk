import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ShelfContractError,
  parseShelfEntrySnapshot,
  parseShelfState,
} from '../../shared/shelfContracts.ts';
import { api } from '../../web/src/shared/api-client.js';
import { shelfApi } from '../../web/src/shared/shelfApi.ts';

const snapshot = {
  analysis: {
    state: 'queued',
    queuedAt: 1_788_249_600_000,
    startedAt: null,
    finishedAt: null,
    generatedAt: null,
  },
  pipeline: {
    attempt: 'a1',
    daemon: 'running',
    result: null,
    stall: null,
    gateKnown: true,
    gate: null,
  },
  b24: {
    present: true,
    status: 'IN_PROGRESS',
    statusKind: 'active',
    unread: 0,
  },
};
const entry = {
  taskId: '42',
  title: 'Задача 42',
  addedAt: '2026-09-01T08:00:00.000Z',
  reason: 'manual',
  snapshot,
};
const state = { scope: 'scope-a', revision: 3, entries: [entry] };

test('контракт полки принимает подтверждённый снимок и отбрасывает посторонние поля', () => {
  assert.deepEqual(parseShelfState({ ...state, ignored: 'лишнее поле' }), state);
  assert.deepEqual(parseShelfEntrySnapshot(snapshot), snapshot);
  assert.deepEqual(
    parseShelfState({ scope: '', revision: 0, entries: [] }),
    { scope: '', revision: 0, entries: [] },
  );
  for (const invalid of [null, [], 'text', 12, false, {}]) {
    assert.throws(() => parseShelfState(invalid), ShelfContractError);
  }
});

test('время оценки читается числом, а запись прошлого формата переводится', () => {
  const legacy = {
    ...snapshot,
    analysis: { ...snapshot.analysis, queuedAt: '2026-09-01T08:00:00.000Z' },
  };

  assert.deepEqual(parseShelfEntrySnapshot(legacy).analysis, snapshot.analysis);
  assert.throws(
    () => parseShelfEntrySnapshot({
      ...snapshot,
      analysis: { ...snapshot.analysis, queuedAt: 'позавчера' },
    }),
    /shelfSnapshot\.analysis\.queuedAt/,
  );
});

test('повреждённая запись отклоняет весь снимок до обновления полки', () => {
  const broken = (patch) => ({ ...state, entries: [entry, { ...entry, ...patch }] });

  assert.throws(() => parseShelfState(broken({ reason: 'потом' })), /shelf\.entries\[1\]\.reason/);
  assert.throws(() => parseShelfState(broken({ taskId: 42 })), /shelf\.entries\[1\]\.taskId/);
  const badAnalysis = { ...snapshot, analysis: { ...snapshot.analysis, state: 'busy' } };

  assert.throws(
    () => parseShelfState(broken({ snapshot: badAnalysis })),
    /entries\[1\]\.snapshot\.analysis\.state/,
  );
  assert.throws(
    () => parseShelfState(broken({ snapshot: { ...snapshot, b24: { ...snapshot.b24, unread: -1 } } })),
    /entries\[1\]\.snapshot\.b24\.unread/,
  );
  assert.throws(() => parseShelfState({ ...state, revision: 1.5 }), /shelf\.revision/);
  // gateKnown отличает «ворот нет» от «о воротах ничего не известно».
  assert.throws(
    () => parseShelfEntrySnapshot({ ...snapshot, pipeline: { ...snapshot.pipeline, gateKnown: null } }),
    /shelfSnapshot\.pipeline\.gateKnown/,
  );
});

test('адаптер полки кодирует номер задачи и отдаёт проверенный снимок', async (t) => {
  const seen = [];
  t.mock.method(api, 'get', async (url) => {
    seen.push(['GET', url]);
    return state;
  });
  t.mock.method(api, 'put', async (url, body) => {
    seen.push(['PUT', url, body]);
    return state;
  });
  t.mock.method(api, 'del', async (url) => {
    seen.push(['DELETE', url]);
    return state;
  });

  assert.deepEqual(await shelfApi.list(), state);
  await shelfApi.put('42/../43', {
    title: 'Задача 42',
    reason: 'analysis',
    snapshot,
    createIfMissing: true,
  });
  await shelfApi.remove('42');

  assert.deepEqual(seen, [
    ['GET', '/api/b24/task-shelf'],
    ['PUT', `/api/b24/task-shelf/${encodeURIComponent('42/../43')}`, {
      title: 'Задача 42',
      reason: 'analysis',
      snapshot,
      createIfMissing: true,
    }],
    ['DELETE', '/api/b24/task-shelf/42'],
  ]);
});

test('снимок, который сервер не примет, не уходит в сеть', async (t) => {
  const calls = [];
  t.mock.method(api, 'put', async (url, body) => {
    calls.push([url, body]);
    return state;
  });

  await assert.rejects(shelfApi.put('42', {
    title: 'Задача 42',
    reason: 'manual',
    snapshot: { ...snapshot, analysis: { ...snapshot.analysis, state: null } },
    createIfMissing: true,
  }), ShelfContractError);

  assert.deepEqual(calls, []);
});

test('адаптер не выдаёт повреждённый ответ мутации за подтверждённый снимок', async (t) => {
  t.mock.method(api, 'put', async () => ({ ...state, entries: [{ ...entry, addedAt: 12 }] }));
  t.mock.method(api, 'del', async () => ({ scope: 'scope-a', revision: -1, entries: [] }));

  await assert.rejects(shelfApi.put('42', {
    title: 'Задача 42',
    reason: 'manual',
    snapshot,
    createIfMissing: false,
  }), ShelfContractError);
  await assert.rejects(shelfApi.remove('42'), ShelfContractError);
});
