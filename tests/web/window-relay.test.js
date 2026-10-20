import assert from 'node:assert/strict';
import test from 'node:test';
import { startShellRelay, startBoardRelay } from '../../web/src/shared/windowRelay.ts';

/**
 * Подменный канал хранит отправленное и даёт тесту доставить сообщение.
 * Настоящий BroadcastChannel Node держал бы процесс теста живым.
 */
function fakeChannel() {
  return {
    onmessage: null,
    posted: [],
    closed: false,
    postMessage(value) {
      this.posted.push(value);
    },
    close() {
      this.closed = true;
    },
  };
}

test('WR-01: главный документ сообщает о ревизии, карточка перечитывает состояние', async () => {
  const source = fakeChannel();
  const mirror = fakeChannel();
  let notify = null;
  let refreshes = 0;
  const stopSource = startShellRelay({
    role: 'source',
    channel: source,
    watchRevision(callback) {
      notify = callback;

      return () => {
        notify = null;
      };
    },
    refresh: async () => {
      throw new Error('Источник не перечитывает оболочку');
    },
  });
  const stopMirror = startShellRelay({
    role: 'mirror',
    channel: mirror,
    watchRevision() {
      throw new Error('Карточка не следит за ревизией сама');
    },
    refresh: async () => {
      refreshes += 1;
    },
  });

  notify();
  assert.deepEqual(source.posted, [{ version: 1, type: 'shell-changed' }]);
  mirror.onmessage({ data: source.posted[0] });
  mirror.onmessage({
    data: {
      version: 1,
      type: 'shell-changed',
      state: {},
    },
  });
  mirror.onmessage({ data: { version: 2, type: 'shell-changed' } });
  mirror.onmessage({ data: ['shell-changed'] });
  assert.equal(refreshes, 1);
  assert.deepEqual(mirror.posted, []);
  stopSource();
  stopMirror();
  assert.equal(notify, null);
  assert.equal(source.closed, true);
  assert.equal(mirror.closed, true);
  assert.equal(mirror.onmessage, null);
});
test('WR-02: отказ чтения в карточке не даёт необработанного отказа и не рвёт подписку', async () => {
  const mirror = fakeChannel();
  let attempts = 0;
  const stop = startShellRelay({
    role: 'mirror',
    channel: mirror,
    watchRevision: () => () => {
    },
    refresh: async () => {
      attempts += 1;

      throw new Error('Оболочка недоступна');
    },
  });

  mirror.onmessage({ data: { version: 1, type: 'shell-changed' } });
  await new Promise((resolve) => setImmediate(resolve));
  mirror.onmessage({ data: { version: 1, type: 'shell-changed' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  stop();
});

test('WR-03: доской делится тот, кто её прочитал; карточка просит снимок при старте', () => {
  const source = fakeChannel();
  const mirror = fakeChannel();
  const sourceApplied = [];
  const mirrorApplied = [];
  const fresh = {
    data: { tasks: [{ id: 42, timerRunning: true }] },
    readAt: 2000,
  };
  let snapshot = null;
  let sourceLoaded = null;
  let mirrorLoaded = null;
  let mirrorRequest;
  const stopSource = startBoardRelay({
    role: 'source',
    channel: source,
    snapshot: () => snapshot,
    watchLoads(callback) {
      sourceLoaded = callback;

      return () => {
        sourceLoaded = null;
      };
    },
    apply: (data, readAt) => sourceApplied.push({ data, readAt }),
    mirror() {
      throw new Error('Главное окно не зеркалит доску');
    },
  });
  const stopMirror = startBoardRelay({
    role: 'mirror',
    channel: mirror,
    snapshot: () => fresh,
    watchLoads(callback) {
      mirrorLoaded = callback;

      return () => {
        mirrorLoaded = null;
      };
    },
    apply: (data, readAt) => mirrorApplied.push({ data, readAt }),
    mirror(request) {
      mirrorRequest = request;
    },
  });

  assert.deepEqual(mirror.posted, [{ version: 1, type: 'board-request' }]);
  source.onmessage({ data: mirror.posted[0] });
  assert.deepEqual(source.posted, []);
  snapshot = {
    data: { tasks: [{ id: 42, timerRunning: false }] },
    readAt: 1000,
  };
  sourceLoaded();
  assert.deepEqual(source.posted, [{
    version: 1,
    type: 'board-snapshot',
    data: snapshot.data,
    readAt: 1000,
  }]);
  mirror.onmessage({ data: source.posted[0] });
  mirror.onmessage({
    data: {
      ...source.posted[0],
      extra: true,
    },
  });
  mirror.onmessage({
    data: {
      ...source.posted[0],
      readAt: 'вчера',
    },
  });
  mirror.onmessage({ data: { version: 1, type: 'board-request' } });
  mirror.onmessage({ data: { ...source.posted[0], readAt: Number.POSITIVE_INFINITY } });
  mirror.onmessage({ data: { ...source.posted[0], data: [] } });
  assert.deepEqual(mirrorApplied, [{ data: snapshot.data, readAt: 1000 }]);
  assert.equal(mirror.posted.length, 1);
  mirrorLoaded();
  assert.deepEqual(mirror.posted[1], {
    version: 1,
    type: 'board-snapshot',
    data: fresh.data,
    readAt: 2000,
  });
  source.onmessage({ data: mirror.posted[1] });
  assert.deepEqual(sourceApplied, [{ data: fresh.data, readAt: 2000 }]);
  assert.equal(source.posted.length, 1);
  mirrorRequest();
  assert.equal(mirror.posted.length, 3);
  stopSource();
  stopMirror();
  assert.equal(mirrorRequest, null);
  assert.equal(sourceLoaded, null);
  assert.equal(mirrorLoaded, null);
  assert.equal(source.closed, true);
  assert.equal(mirror.closed, true);
});
