import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { webFile } from './helpers/compile-vue.js';

const HISTORY_URL = pathToFileURL(webFile('src/shared/alertHistory.ts')).href;

async function history() {
  const { createAlertHistory, ALERT_HISTORY_LIMIT } = await import(HISTORY_URL);
  let clock = 1_000;

  return {
    limit: ALERT_HISTORY_LIMIT,
    store: createAlertHistory(() => {
      clock += 1;

      return clock;
    }),
  };
}

const states = (store) => store.list().map((entry) => `${entry.id}:${entry.state}`);

test('новые записи сверху, повтор того же id гасит прежнюю живую', async () => {
  const { store } = await history();

  store.record({
    id: 'chat-c1',
    title: 'Первый ответ',
  });
  store.record({
    id: 'chat-c2',
    title: 'Другой чат',
  });
  store.record({
    id: 'chat-c1',
    title: 'Второй ответ',
  });

  assert.deepEqual(states(store), ['chat-c1:live', 'chat-c2:live', 'chat-c1:seen']);
});

test('уход тоста по таймеру и лимиту — пропуск, человеком — просмотр', async () => {
  const { store } = await history();

  for (const id of ['timeout', 'overflow', 'user', 'action', 'program']) {
    store.record({
      id,
      title: id,
    });
    store.toastGone(id, id);
  }

  assert.deepEqual(states(store), [
    'program:resolved',
    'action:seen',
    'user:seen',
    'overflow:missed',
    'timeout:missed',
  ]);
  assert.equal(store.missedCount(), 2);
});

test('разбор по id и по области не трогает просмотренное', async () => {
  const { store } = await history();

  store.record({
    id: 'a',
    title: 'A',
    scope: 'chat:c1',
  });
  store.record({
    id: 'b',
    title: 'B',
    scope: 'chat:c1',
  });
  store.toastGone('b', 'user');
  store.record({
    id: 'c',
    title: 'C',
  });
  store.toastGone('c', 'timeout');

  store.resolveScope('chat:c1');
  store.resolve('c');
  store.resolveScope('');

  assert.deepEqual(states(store), ['c:resolved', 'b:seen', 'a:resolved']);
});

test('просмотр всех или одной записи, очистка и лимит', async () => {
  const { store, limit } = await history();

  store.record({
    id: 'a',
    title: 'A',
  });
  store.record({
    id: 'b',
    title: 'B',
  });
  store.toastGone('a', 'timeout');
  store.toastGone('b', 'timeout');

  const keyOfA = store.list().find((entry) => entry.id === 'a').key;

  store.markSeen(keyOfA);
  assert.deepEqual(states(store), ['b:missed', 'a:seen']);

  store.markSeen();
  assert.equal(store.missedCount(), 0);

  for (let index = 0; index < limit + 5; index += 1) {
    store.record({
      id: `n-${index}`,
      title: 'N',
    });
  }

  assert.equal(store.list().length, limit);

  store.clear();
  assert.deepEqual(store.list(), []);
});

test('подписчик получает снимок сразу и только при изменениях', async () => {
  const { store } = await history();
  const sizes = [];
  const stop = store.subscribe((entries) => {
    sizes.push(entries.length);
  });

  store.record({
    id: 'a',
    title: 'A',
  });
  store.resolve('missing');
  store.markSeen();
  stop();
  store.record({
    id: 'b',
    title: 'B',
  });

  assert.deepEqual(sizes, [0, 1]);
});
