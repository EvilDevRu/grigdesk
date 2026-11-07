// Id сессии приходит с первого события хода (SSE `chat-session`), а не только с ответом:
// перезапуск сервера посреди первого хода раньше оставлял чат без сессии, и следующее
// сообщение начинало разговор с нуля. Здесь же — метка «прерван перезапуском» из pending.
import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileWith } from './helpers/chat-protocol.js';

import { apiHarness, chatStoreFixture, sseOf } from './helpers/chat-store.js';

function fixture(session = {}) {
  return chatStoreFixture({
    sessions: [{
      id: 'c1', taskId: null, title: 'Чат', messages: [], sessionId: null,
      contextTokens: 0, sending: false, compacting: false, steps: [], draft: '',
      ...session,
    }],
  });
}

test('WEB: id сессии идущего хода сохраняется сразу по chat-session', async () => {
  const chat = await fixture({ sending: true });
  const sse = sseOf(chat);
  const sess = chat.sessions[0];

  sse('chat-session', { chatKey: 'c1', sessionId: 'sess-early', at: 1 });
  assert.equal(sess.sessionId, 'sess-early');
});

test('WEB: поздний chat-session завершённого хода сессию не трогает', async () => {
  const chat = await fixture({ sending: false, sessionId: null });
  const sse = sseOf(chat);
  const sess = chat.sessions[0];

  sse('chat-session', { chatKey: 'c1', sessionId: 'sess-late', at: 1 });
  assert.equal(sess.sessionId, null, 'сброшенную после сжатия сессию поздний id не воскрешает');
});

test('WEB: pending-ответ прерванного перезапуском хода несёт метку и сессию', async () => {
  const chat = await fixture({ sending: true, sessionId: null });
  const sess = chat.sessions[0];
  const deleted = [];
  apiHarness.get = async (url) => (url === '/api/chat/pending'
    ? {
      pending: [{
        id: 'o1', chatKey: 'c1', role: 'assistant', reply: '⏹ Ход прерван перезапуском сервера.',
        stopped: true, interruptedBy: 'server_shutdown', sessionId: 'sess-early',
        steps: [{ k: 'text', text: 'работаю', at: 1 }], userText: 'привет', at: 2,
      }],
    }
    : { active: [] });
  apiHarness.post = reconcileWith(apiHarness.post, apiHarness.get);
  apiHarness.del = async (url) => { deleted.push(url); return {}; };

  await chat._collectPending();

  const last = sess.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.stopped, true);
  assert.equal(last.interruptedBy, 'server_shutdown');
  assert.equal(sess.sessionId, 'sess-early', 'сессия для продолжения восстановлена из pending');
  assert.equal(sess.sending, false);
  assert.deepEqual(deleted, ['/api/chat/pending/o1']);
});
