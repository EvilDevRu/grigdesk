import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountRuntimeManager } from '../../server/src/lib/accountRuntime.ts';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('switch отзывает generation до ожидания leases и публикует новый context после drain', async () => {
  const drains = [];
  const runtime = new AccountRuntimeManager({
    channel: 'github',
    onDrain: async (entry) => drains.push([entry.accountRef, entry.generation]),
  });
  await runtime.install({ accountRef: 'acc_old', context: { token: 'old' } });
  const old = runtime.acquire();
  assert.equal(old.isCurrent(), true);

  const switched = runtime.install({ accountRef: 'acc_new', context: { token: 'new' } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(old.isCurrent(), false, 'draining generation не может опубликовать поздний результат');
  assert.throws(() => runtime.acquire(), /переключается/);
  assert.deepEqual(drains, [['acc_old', 1]]);

  let settled = false;
  switched.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'switch обязан дождаться lease');
  old.release();
  const current = await switched;
  assert.equal(current.accountRef, 'acc_new');
  assert.equal(current.generation, 2);
  assert.equal(runtime.acquire().context.token, 'new');
});

test('drain идемпотентно ждёт lease, release идемпотентен', async () => {
  const runtime = new AccountRuntimeManager({ channel: 'telegram' });
  await runtime.install({ accountRef: 'acc_bot', context: { botId: '42' } });
  const gate = deferred();
  const operation = runtime.withLease(async (lease) => {
    await gate.promise;
    return lease.isCurrent();
  });
  const draining = runtime.drain({ reason: 'disconnect' });
  await Promise.resolve();
  assert.equal(runtime.status().connection, 'disconnecting');
  gate.resolve();
  assert.equal(await operation, false);
  const old = await draining;
  assert.equal(old.accountRef, 'acc_bot');
  assert.equal(runtime.status().connection, 'disconnected');
  assert.equal(await runtime.drain(), null);
});

test('одновременные lifecycle операции сериализованы, поколения не повторяются', async () => {
  const runtime = new AccountRuntimeManager({ channel: 'github' });
  const first = runtime.install({ accountRef: 'acc_1', context: { value: 1 } });
  const second = runtime.install({ accountRef: 'acc_2', context: { value: 2 } });
  const third = runtime.install({ accountRef: 'acc_3', context: { value: 3 } });
  assert.equal((await first).generation, 1);
  assert.equal((await second).generation, 2);
  assert.equal((await third).generation, 3);
  assert.equal(runtime.snapshot().accountRef, 'acc_3');
});
