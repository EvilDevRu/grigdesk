import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, webFile } from './helpers/compile-vue.js';

test('TS-01: успешные действия публикуют инвалидацию; приём не отсылает её обратно', async () => {
  const { startTaskWindowSync } = await compileModule(webFile('src/shared/taskWindowSync.ts'));
  const listeners = [];
  const posted = [];
  let invalidations = 0;
  let stopped = 0;
  let closed = 0;
  const channel = {
    onmessage: null,
    postMessage(value) {
      posted.push(value);
    },
    close() {
      closed += 1;
    },
  };
  const store = {
    $onAction(listener) {
      listeners.push(listener);

      return () => stopped += 1;
    },
  };
  const dispose = startTaskWindowSync({
    channel,
    stores: [{ store, actions: ['setFavorite', 'markSeen'] }],
    invalidate: () => {
      invalidations += 1;
    },
  });
  let after;

  listeners[0]({ name: 'setFavorite', after: (callback) => after = callback });
  assert.equal(posted.length, 0);
  after({ ok: true });
  assert.deepEqual(posted, [{ version: 1, type: 'task-data-changed' }]);
  listeners[0]({ name: 'markSeen', after: (callback) => after = callback });
  after(false);
  assert.equal(posted.length, 1);
  listeners[0]({ name: 'markSeen', after: (callback) => after = callback });
  after(true);
  assert.equal(posted.length, 2);
  listeners[0]({ name: 'load', after() {
      throw new Error('Чтение не должно публиковаться');
    } });
  channel.onmessage({ data: { version: 1, type: 'task-data-changed' } });
  channel.onmessage({ data: { version: 2, type: 'task-data-changed' } });
  channel.onmessage({ data: {
    version: 1,
    type: 'task-data-changed',
    extra: true,
  } });
  channel.onmessage({ data: {
      version: 1, 
    type: 'execute', 
    script: 'bad'
    } });
  assert.equal(invalidations, 1);
  assert.equal(posted.length, 2);
  dispose();
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
  assert.equal(channel.onmessage, null);
});

test('TS-02: старый запрос не поглощает инвалидацию, а dispose снимает ожидание', async () => {
  const { createQueuedReload } = await compileModule(webFile('src/shared/taskWindowSync.ts'));
  const first = Promise.withResolvers();
  let busy = true;
  let idle;
  let calls = 0;
  let removed = 0;
  const queue = createQueuedReload({
    busy: () => busy,
    subscribe(callback) {
      idle = callback;

      return () => {
        removed += 1;
      };
    },
    reload() {
      calls += 1;

      return calls === 1 ? first.promise : Promise.resolve();
    },
  });

  queue.request();
  queue.request();
  await Promise.resolve();
  assert.equal(calls, 0);
  busy = false;
  idle();
  await Promise.resolve();
  assert.equal(calls, 1);
  queue.request();
  queue.request();
  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  queue.dispose();
  queue.request();
  idle();
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(removed, 1);
});
test('TS-03: dispose в том же tick не запускает уже запланированное чтение', async () => {
  const { createQueuedReload } = await compileModule(webFile('src/shared/taskWindowSync.ts'));
  let calls = 0;
  const queue = createQueuedReload({
    busy: () => false,
    subscribe: () => () => {
    },
    async reload() {
      calls += 1;
    },
  });

  queue.request();
  queue.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});
