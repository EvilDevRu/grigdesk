import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserBroker } from '../../server/src/lib/browser/browserBroker.ts';

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
