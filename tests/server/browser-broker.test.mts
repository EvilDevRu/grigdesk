import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserBroker } from '../../server/src/lib/browser/browserBroker.ts';

test('BR13-poll-deadline: результат команды не продлевает общий срок ожидающего poll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });

  const broker = createBrowserBroker({ validateOwner: async () => true });

  t.after(() => broker.close());

  const host = broker.register();
  const pending = broker.invoke('chat:a', { action: 'screenshot', tabId: 'one' });
  const command = await broker.poll(host.id, host.token);
  const outcomes: unknown[] = [];
  const poll = broker.poll(host.id, host.token);

  void poll.then((value) => outcomes.push(value), (error) => outcomes.push(error.message));
  assert.ok(command);
  t.mock.timers.tick(6000);
  broker.heartbeat(host.id, host.token);
  await broker.result(host.id, host.token, command.requestId, { ok: false });
  await pending;
  t.mock.timers.tick(8000);
  broker.heartbeat(host.id, host.token);
  t.mock.timers.tick(6000);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual([...outcomes], [null], 'poll возвращается через 20 s от начала, а не от последнего ACK');
  assert.equal(broker.available(), true);
  assert.equal(broker.generation(), host.hostEpoch);
});

test('BR13: правильный host обслуживает владельца, поздний result после lease запрещён', async () => {
  let now = 100;
  let counter = 0;
  const broker = createBrowserBroker({
    now: () => now,
    id: () => String(++counter),
    validateOwner: async () => true,
  });
  const host = broker.register();
  const pending = broker.invoke('chat:a', { action: 'open', url: 'http://fixture.test/' });
  const command = await broker.poll(host.id, host.token);

  assert.ok(command);
  assert.equal(command.owner, 'chat:a');
  assert.throws(() => broker.register(), /browser_host_conflict/u);
  await assert.rejects(async () => broker.result(host.id, 'forged', command.requestId, {}),
    /host_forbidden/u);
  await broker.result(host.id, host.token, command.requestId, { ok: true, tabId: 'one' });
  assert.deepEqual(await pending, { ok: true, tabId: 'one' });

  const second = broker.invoke('chat:a', { action: 'snapshot', tabId: 'one' });
  const late = await broker.poll(host.id, host.token);

  assert.ok(late);
  now += 16000;
  await assert.rejects(async () => broker.result(host.id, host.token, late.requestId, {}), /host_expired/u);
  await assert.rejects(second, /browser_unavailable|outcome_unknown/u);
  broker.close();
});
