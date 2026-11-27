import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatAppFixture,
  controlledExecutor,
  saveChat,
  turnBody,
  waitFor,
} from './helpers/chat-turns.js';

/**
 * Получает снимок непосредственно от владельца очереди, включая queued turnId.
 * Устаревшее действие проверяется в том же admission, в котором принимают новые ходы.
 */
async function snapshot(app, chatKey) {
  const state = (await app.inject('/api/chat/active')).json();

  return {
    runId: state.active.find((run) => run.chatKey === chatKey)?.runId ?? null,
    queued: state.queued
      .filter((entry) => entry.chatKey === chatKey)
      .map((entry) => entry.turnId)
      .sort(),
  };
}

test('MC-05: CAS стопа не затрагивает новый run или изменившуюся очередь', async (t) => {
  const controlled = controlledExecutor();
  const { app } = await chatAppFixture(t, { executor: controlled.executor });

  await saveChat(app, 'mobile-cas');
  await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('mobile-cas', 'mobile-cas-first'),
  });
  await controlled.waitForRuns(1);

  const expected = await snapshot(app, 'mobile-cas');

  await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('mobile-cas', 'mobile-cas-second'),
  });

  const stale = await app.inject({
    method: 'POST',
    url: '/api/chat/stop',
    payload: {
      chatKey: 'mobile-cas',
      expected,
    },
  });

  assert.equal(stale.statusCode, 409);
  assert.equal(controlled.runs[0].options.signal.aborted, false);

  const current = await snapshot(app, 'mobile-cas');
  const stopped = await app.inject({
    method: 'POST',
    url: '/api/chat/stop',
    payload: {
      chatKey: 'mobile-cas',
      expected: current,
    },
  });

  assert.equal(stopped.statusCode, 200);
  await waitFor(async () => (await app.inject('/api/chat/active')).json().active.length === 0);
  assert.equal(controlled.runs.length, 1);
  assert.equal((await app.inject('/api/chat/active')).json().queued.length, 0);
});
