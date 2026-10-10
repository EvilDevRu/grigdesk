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

test('MC-05/MC-38: CAS стопа не затрагивает новый run или изменившуюся очередь', async (t) => {
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

test('MC-38: I/O failure done сохраняет pending stopped очереди для последующей сверки', async (t) => {
  const { ChatTurnLedger } = await import('../../server/src/lib/chat/turnLedger.ts');
  const { MobileChatTurns } = await import('../../server/src/lib/mobile/chatTurns.ts');
  const { promises: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  const controlled = controlledExecutor();
  const { app, config } = await chatAppFixture(t, { executor: controlled.executor });
  const turns = new MobileChatTurns(app.mobileChat);
  const deviceId = 'd12345678';

  await saveChat(app, 'stop-io');
  await turns.send({
    deviceId,
    chatId: 'stop-io',
    clientId: 'stop-first-001',
    text: 'Первый',
  });
  await controlled.waitForRuns(1);

  const second = await turns.send({
    deviceId,
    chatId: 'stop-io',
    clientId: 'stop-second-001',
    text: 'Второй',
  });
  const expected = await snapshot(app, 'stop-io');
  const original = ChatTurnLedger.prototype.persist;
  let broken = true;

  ChatTurnLedger.prototype.persist = function (id) {
    if (broken && id === second.body.turnId && this.get(id)?.state === 'done') {
      return Promise.reject(new Error('synthetic ledger failure'));
    }

    return original.call(this, id);
  };
  t.after(() => {
    ChatTurnLedger.prototype.persist = original;
  });

  const stopped = await app.inject({
    method: 'POST',
    url: '/api/chat/stop',
    payload: {
      chatKey: 'stop-io',
      expected,
    },
  });

  assert.ok(stopped.statusCode >= 500);
  assert.ok(
    (await fs.readdir(path.join(config.chatsDir, 'pending'))).some((file) =>
      file.startsWith(second.body.turnId),
    ),
  );
  broken = false;
  await app.mobileChat.reconcile('stop-io');

  const chat = await app.mobileChat.read('stop-io');

  assert.ok(
    chat.messages.some(
      (message) =>
        message.turnId === second.body.turnId &&
        message.role === 'error' &&
        message.stopped === true,
    ),
  );
  assert.equal(controlled.runs.length, 1);
});
