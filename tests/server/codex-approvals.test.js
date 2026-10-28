import assert from 'node:assert/strict';
import test from 'node:test';

import { codexApprovalPresentation, codexApprovalResponse, createCodexInteractionWaiters }
  from '../../server/src/lib/executors/_codexApprovals.ts';
import { PERMISSION_WAIT_MS } from '../../server/src/lib/chat/permissionQueue.ts';

test('native approval показывает команду и допускает только одноразовый accept', () => {
  const method = 'item/commandExecution/requestApproval';
  const params = {
    itemId: 'item',
    command: 'printf fixture',
    cwd: '/fixture',
    approvalId: null,
    availableDecisions: ['accept', 'acceptForSession', 'cancel']
  };
  const presentation = codexApprovalPresentation(method, params);

  assert.equal(presentation.requiresExplicitUser, true);
  assert.equal(presentation.canRemember, false);
  assert.equal(presentation.input.command, params.command);
  assert.deepEqual(codexApprovalResponse(method, { allow: true }), { decision: 'accept' });
  assert.deepEqual(codexApprovalResponse(method, { allow: true, remember: true }), { decision: 'decline' });
  assert.equal(codexApprovalPresentation(method, { ...params, availableDecisions: ['acceptForSession'] }),
    null);
  assert.equal(codexApprovalPresentation('item/fileChange/requestApproval',
    { itemId: 'item', grantRoot: '/fixture' }, { type: 'fileChange', changes: [{}] }), null);
});

test('суточный deadline отменяет callback; поздний allow и повторный ID не отвечают дважды', async () => {
  const replies = [];
  let timeout;
  let allow;
  let signal;
  const waiter = createCodexInteractionWaiters({
    send: (id, result) => replies.push({ id, result }),
    setTimer: (callback, ms) => {
      assert.equal(ms, PERMISSION_WAIT_MS);
      timeout = callback;

      return { unref() {} };
    },
    clearTimer() {}
  });
  const owner = {};

  waiter.ask(1, owner, {}, (presentation) => {
    signal = presentation.signal;

    return new Promise((resolve) => {
      allow = resolve;
    });
  }, (value) => value, { decision: 'decline' });
  await Promise.resolve();
  assert.equal(waiter.size, 1);
  assert.equal(replies.length, 0);
  timeout();
  assert.equal(signal.aborted, true);
  allow({ decision: 'accept' });
  await new Promise((resolve) => setImmediate(resolve));
  waiter.ask(1, owner, {}, () => assert.fail('повторный callback'), (value) => value, {});
  assert.deepEqual(replies, [{ id: 1, result: { decision: 'decline' } }]);
  assert.equal(waiter.size, 0);
});

test('числовой и строковый request ID независимы; resolved снимает только свой waiter', async () => {
  const replies = [];
  const waiter = createCodexInteractionWaiters({ send: (id) => replies.push(id) });
  const owner = {};

  for (const id of [1, '1']) {
    waiter.ask(id, owner, {}, () => new Promise(() => {}), (value) => value, {});
  }

  waiter.resolved(1);
  assert.equal(waiter.size, 1);
  waiter.cancel(owner);
  assert.equal(waiter.size, 0);
  assert.deepEqual(replies, []);
});
