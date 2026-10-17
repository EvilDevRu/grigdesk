import assert from 'node:assert/strict';
import test from 'node:test';

import { createJobDownloadQueue } from '../../server/src/lib/studio3d/jobDownloadQueue.ts';

/**
 * Управляемое обещание позволяет отдельно завершить или отвергнуть работу.
 * Все удержания освобождаются в finally, тесты имеют конечный deadline.
 */
function barrier() {
  let release;
  let reject;
  const promise = new Promise((resolve, fail) => {
    release = resolve;
    reject = fail;
  });

  return {
    promise,
    release,
    reject,
  };
}

/**
 * Три заранее известные работы имеют независимые сигналы входа и завершения.
 * Остановка остаётся внешним состоянием, как в настоящем Jobs.
 */
function fixture() {
  const keys = ['i:a', 'i:b', 'i:c'];
  const h = {
    stopped: false,
    calls: [],
    gates: new Map(keys.map((key) => [key, barrier()])),
    entered: new Map(keys.map((key) => [key, barrier()])),
  };
  const queue = createJobDownloadQueue({
    isStopped: () => h.stopped,
    run: (intentId, childId) => {
      const key = `${intentId}:${childId}`;

      h.calls.push(key);
      h.entered.get(key).release();

      return h.gates.get(key).promise;
    },
  });

  return { h, queue };
}

/**
 * Cleanup снимает ожидающих и завершает только работы собственной фикстуры.
 * Settle для остановленной очереди с ожиданием намеренно не вызывается.
 */
async function releaseAll(h, queue) {
  queue.clearWaiting();

  for (const gate of h.gates.values()) {
    gate.release();
  }

  await queue.waitActive();
}

test('DQ-01: три child занимают два слота, освобождённый слот запускает третьего',
  { timeout: 60_000 }, async () => {
    const { h, queue } = fixture();

    try {
      for (const child of ['a', 'b', 'c']) {
        queue.enqueue('i', child);
      }

      queue.pump();
      assert.equal(queue.activeCount(), 2);
      assert.deepEqual(h.calls, ['i:a', 'i:b']);
      h.gates.get('i:a').release();
      await h.entered.get('i:c').promise;
      assert.equal(queue.activeCount(), 2);
      assert.deepEqual(h.calls, ['i:a', 'i:b', 'i:c']);
    } finally {
      await releaseAll(h, queue);
    }
  });

test('DQ-02: повтор ключа не дублирует ожидающую и активную работу',
  { timeout: 60_000 }, async () => {
    const { h, queue } = fixture();

    try {
      queue.enqueue('i', 'a');
      queue.enqueue('i', 'a');
      queue.enqueue('i', 'b');
      queue.pump();
      queue.enqueue('i', 'a');
      queue.enqueue('i', 'b');
      queue.enqueue('i', 'c');
      queue.enqueue('i', 'c');
      queue.pump();
      assert.deepEqual(h.calls, ['i:a', 'i:b']);
      h.gates.get('i:a').release();
      await h.entered.get('i:c').promise;
      h.gates.get('i:b').release();
      h.gates.get('i:c').release();
      await queue.settle();
      assert.deepEqual(h.calls, ['i:a', 'i:b', 'i:c']);
      assert.equal(queue.activeCount(), 0);
    } finally {
      await releaseAll(h, queue);
    }
  });

test('DQ-03: отказ освобождает слот для следующего child',
  { timeout: 60_000 }, async () => {
    const { h, queue } = fixture();

    try {
      for (const child of ['a', 'b', 'c']) {
        queue.enqueue('i', child);
      }

      queue.pump();
      h.gates.get('i:a').reject(new Error('Отказ первой работы.'));
      await h.entered.get('i:c').promise;
      assert.equal(queue.activeCount(), 2);
      assert.deepEqual(h.calls, ['i:a', 'i:b', 'i:c']);
    } finally {
      await releaseAll(h, queue);
    }
  });

test('DQ-04: остановка не запускает ожидающие, clearWaiting и waitActive закрывают очередь',
  { timeout: 60_000 }, async () => {
    const { h, queue } = fixture();

    try {
      for (const child of ['a', 'b', 'c']) {
        queue.enqueue('i', child);
      }

      queue.pump();
      h.stopped = true;
      h.gates.get('i:a').release();
      await new Promise(setImmediate);
      queue.pump();
      assert.deepEqual(h.calls, ['i:a', 'i:b']);
      queue.clearWaiting();
      h.gates.get('i:b').release();
      await queue.waitActive();
      assert.equal(queue.activeCount(), 0);
      assert.deepEqual(h.calls, ['i:a', 'i:b']);
    } finally {
      await releaseAll(h, queue);
    }
  });

test('DQ-05: settle ждёт и работу, начавшуюся после освобождения слота',
  { timeout: 60_000 }, async () => {
    const { h, queue } = fixture();
    let finished = false;

    try {
      for (const child of ['a', 'b', 'c']) {
        queue.enqueue('i', child);
      }

      queue.pump();

      const settled = queue.settle().then(() => {
        finished = true;
      });

      h.gates.get('i:a').release();
      await h.entered.get('i:c').promise;
      h.gates.get('i:b').release();
      await new Promise(setImmediate);
      assert.equal(finished, false);
      h.gates.get('i:c').release();
      await settled;
      assert.equal(finished, true);
      assert.equal(queue.activeCount(), 0);
    } finally {
      await releaseAll(h, queue);
    }
  });

test('DQ-06: settle распространяет отказ, waitActive дожидается allSettled',
  { timeout: 60_000 }, async () => {
    const { h, queue } = fixture();
    const failure = new Error('Отказ активной работы.');

    try {
      queue.enqueue('i', 'a');
      queue.pump();

      const rejected = assert.rejects(queue.settle(), (cause) => cause === failure);
      const waited = queue.waitActive();

      h.gates.get('i:a').reject(failure);
      await rejected;
      await waited;
      assert.equal(queue.activeCount(), 0);
    } finally {
      await releaseAll(h, queue);
    }
  });

test('DQ-07: enqueue сам не запускает работу, clearWaiting синхронно снимает ожидающих',
  { timeout: 60_000 }, async () => {
    const { h, queue } = fixture();

    try {
      queue.enqueue('i', 'a');
      assert.equal(queue.activeCount(), 0);
      assert.deepEqual(h.calls, []);
      queue.clearWaiting();
      queue.pump();
      assert.equal(queue.activeCount(), 0);
      assert.deepEqual(h.calls, []);
    } finally {
      await releaseAll(h, queue);
    }
  });

test('DQ-08: отказ без settle не создаёт unhandledRejection',
  { timeout: 60_000 }, async () => {
    const { h, queue } = fixture();
    const unhandled = [];
    const observe = (cause) => unhandled.push(cause);

    process.on('unhandledRejection', observe);

    try {
      queue.enqueue('i', 'a');
      queue.pump();
      h.gates.get('i:a').reject(new Error('Отказ без наблюдателя.'));
      await new Promise(setImmediate);
      await new Promise(setImmediate);
      assert.equal(unhandled.length, 0);
      assert.equal(queue.activeCount(), 0);
    } finally {
      process.off('unhandledRejection', observe);
      await releaseAll(h, queue);
    }
  });
