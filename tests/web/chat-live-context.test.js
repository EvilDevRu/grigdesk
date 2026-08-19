// Кольцо контекста показывало цифру С ПРОШЛОГО ХОДА. Пока ходы короткие, разница
// незаметна; но автокомпакт CLI срабатывает НА ГРАНИЦЕ хода, и после него кольцо весь
// оставшийся ход могло гореть красным по контексту, которого уже нет.
//
// Живой размер приезжает рантайм-полем `liveContext` (SSE `chat-progress` + сверка
// `GET /api/chat/active`). Именно рантайм: `contextTokens` уходит в историю, и запись
// на каждое обращение к модели стоила бы PUT чата (см. `slimOf` и дебаунс `_persist`).
import assert from 'node:assert/strict';
import test from 'node:test';

import { apiHarness, chatStoreFixture, sseOf } from './helpers/chat-store.js';

function fixture() {
  return chatStoreFixture({
    sessions: [{
      id: 'c1', taskId: null, title: 'Чат', messages: [], sessionId: 'sess-1',
      contextTokens: 180000, sending: false, compacting: false, steps: [], draft: '',
      contextCache: { scope: 'request', status: 'reported', readTokens: 170000, uncachedTokens: 10000 },
    }],
  });
}

test('CTX-01: chat-progress приносит живой размер контекста и не трогает сохранённый', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  const sess = chat.sessions[0];

  sse('chat-progress', {
    chatKey: 'c1', tokens: 120, contextTokens: 60000,
    contextCache: {
      scope: 'request', status: 'reported', readTokens: 59000, writeTokens: 900, uncachedTokens: 100,
    },
  });

  assert.equal(sess.liveContext, 60000, 'кольцо обязано увидеть падение сразу');
  assert.deepEqual(sess.liveContextCache, {
    scope: 'request', status: 'reported', readTokens: 59000, writeTokens: 900, uncachedTokens: 100,
  });
  assert.equal(sess.contextTokens, 180000, 'сохранённая цифра меняется только ответом хода');
  assert.equal(sess.contextCache.readTokens, 170000, 'live-снимок не переписывает историю на каждом событии');
  assert.equal(sess.sending, true);
});

test('CTX-02: исполнитель без замера контекста ничего не ломает', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  const sess = chat.sessions[0];

  // Codex/kimi/ollama шлют только счётчик потраченного — поля contextTokens в событии нет.
  sse('chat-progress', { chatKey: 'c1', tokens: 42 });

  assert.ok(!sess.liveContext, 'живого замера нет — кольцо остаётся на сохранённой цифре');
  assert.equal(sess.contextTokens, 180000);
});

test('CTX-03: новый ход начинается без чужого замера', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  const sess = chat.sessions[0];

  sse('chat-progress', { chatKey: 'c1', tokens: 10, contextTokens: 60000 });
  sess.liveContextCache = { scope: 'request', status: 'unavailable' };
  sse('chat-turn-start', { chatKey: 'c1', at: 2 });

  assert.equal(sess.liveContext, 0, 'замер прошлого хода к новому отношения не имеет');
  assert.equal(sess.liveContextCache, null, 'кэш прошлого request к новому ходу не относится');
});

test('CTX-04: F5 посреди часового хода возвращает живой размер, а не цифру прошлого хода', async () => {
  const chat = await fixture();
  const sess = chat.sessions[0];
  apiHarness.get = async (url) => {
    assert.equal(url, '/api/chat/active');
    return {
      active: [{
        chatKey: 'c1', startedAt: 1, tokens: 500, steps: [], contextTokens: 137645,
        contextCache: { scope: 'request', status: 'reported', readTokens: 130000, uncachedTokens: 7645 },
      }],
    };
  };

  await chat._loadActive();

  assert.equal(sess.sending, true);
  assert.equal(sess.liveContext, 137645);
  assert.deepEqual(sess.liveContextCache, {
    scope: 'request', status: 'reported', readTokens: 130000, uncachedTokens: 7645,
  });
});

test('CTX-05: закончившийся ход снимает живой замер вместе с «думает…»', async () => {
  const chat = await fixture();
  const sess = chat.sessions[0];
  sess.sending = true;
  sess.liveContext = 137645;
  sess.liveContextCache = { scope: 'request', status: 'unavailable' };
  apiHarness.get = async () => ({ active: [] });

  await chat._loadActive();

  assert.equal(sess.sending, false);
  assert.ok(!sess.liveContext, 'после хода кольцо показывает сохранённую цифру ответа');
  assert.equal(sess.liveContextCache, null);
});
