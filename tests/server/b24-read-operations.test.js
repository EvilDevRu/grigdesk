import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { B24ReadOperations } from '../../server/src/lib/b24/readOperations.ts';

/**
 * Управляемый барьер освобождается самим тестом, без сетевых запросов.
 * Он позволяет проверить порядок до завершения удержанной операции.
 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/**
 * Повторяет реальную promise-цепочку адаптера, общую для чтений и мутаций.
 * Ошибка одного элемента не останавливает следующие элементы.
 */
function fixture(options = {}) {
  let tail = Promise.resolve();
  const enqueue = (fn) => {
    const work = tail.then(fn);

    tail = work.then(() => undefined, () => undefined);

    return work;
  };

  return { enqueue, reads: new B24ReadOperations(enqueue, options) };
}

test('READ-01: один уход не отменяет общую работу, последний уход отменяет', async () => {
  const { reads } = fixture();
  const held = deferred();
  const first = new AbortController();
  const second = new AbortController();
  let starts = 0;
  let signal;
  const work = (current) => {
    starts += 1;
    signal = current;

    return held.promise;
  };
  const a = reads.read('dashboard', 'dashboard', work, first.signal).catch((error) => error);
  const b = reads.read('dashboard', 'dashboard', work, second.signal).catch((error) => error);

  try {
    await setImmediate();
    assert.equal(starts, 1);
    first.abort();

    let cancelled = false;

    a.then(() => {
      cancelled = true;
    });
    await setImmediate();
    assert.equal(cancelled, true, 'Уход подписчика завершает его ожидание');
    assert.equal((await a).name, 'AbortError');
    assert.equal(signal.aborted, false);
    second.abort();
    assert.equal((await b).name, 'AbortError');
    assert.equal(signal.aborted, true);
  } finally {
    held.resolve({});
  }
});

test('READ-02: истёкшее в очереди чтение не вызывает операцию', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { enqueue, reads } = fixture({ timeoutMs: 25_000 });
  const held = deferred();
  const busy = enqueue(() => held.promise);
  let starts = 0;
  const read = reads.read('task:42', 'task', async () => {
    starts += 1;

    return {};
  }).catch((error) => error);

  try {
    t.mock.timers.tick(25_000);
    assert.equal((await read).name, 'TimeoutError');
    assert.equal(starts, 0);
  } finally {
    held.resolve();
    await busy;
    await setImmediate();
  }

  assert.equal(starts, 0);
});

test('READ-03: публичный таймаут не запускает следующую мутацию поверх работы', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { enqueue, reads } = fixture({ timeoutMs: 25_000 });
  const held = deferred();
  let mutated = false;
  const read = reads.read('dashboard', 'dashboard', () => held.promise).catch((error) => error);

  await setImmediate();

  const mutation = enqueue(() => {
    mutated = true;
  });

  try {
    t.mock.timers.tick(25_000);
    assert.equal((await read).name, 'TimeoutError');
    assert.equal(mutated, false);
  } finally {
    held.resolve({});
    await mutation;
  }

  assert.equal(mutated, true);
});

test('READ-04: отмена поколения и диагностика не раскрывают ключ чтения', async () => {
  const events = [];
  const { reads } = fixture({ trace: (event) => events.push(event) });
  const held = deferred();
  const read = reads.read('task:private-id', 'task', () => held.promise).catch((error) => error);

  try {
    await setImmediate();
    reads.invalidate();
    assert.equal((await read).name, 'AbortError');
    assert.doesNotMatch(JSON.stringify(events), /private-id|cookie|password|https:/u);
    assert.ok(events.some((event) => event.phase === 'settled'));
  } finally {
    held.resolve({});
  }
});
