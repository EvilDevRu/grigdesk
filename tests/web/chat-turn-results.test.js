// Итоги принятых ходов приходят через chats/pending. Здесь — правила их раскладки,
// которых раньше не было: итог снимает с реплики «ждёт очереди» и отметку доставки,
// выжимка не донесённого хода возвращается в ожидание, запись pending подтверждается
// только после устойчивой записи истории, а ответ чата, которого в окне ещё нет,
// не выбрасывается.
import assert from 'node:assert/strict';
import test from 'node:test';

import { protocolHead, reconcileWith } from './helpers/chat-protocol.js';

import { apiHarness, chatStoreFixture, sseOf } from './helpers/chat-store.js';

const SEED = 'Сделано: план, тесты. Осталось: сборка.';
const SEED_OPEN = '[Выжимка предыдущего разговора — продолжаем с этого места]';
const withSeed = (seed, text) => `${SEED_OPEN}\n${seed}\n[/Выжимка]\n\n${text}`;

// Реплика человека с id отправки — так её пишет окно по протоколу приёма.
function userTurn(text, turnId, extra = {}) {
  return {
    role: 'user',
    text,
    turnId,
    ...extra,
  };
}

// Ответ сервера на запись чата.
function ack(revision) {
  return {
    ok: true,
    written: true,
    revision,
  };
}

function chatWith(messages, extra = {}) {
  return {
    id: 'res-chat',
    title: 'Итоги',
    messages,
    revision: 3,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

const tick = () => new Promise((resolve) => {
  setImmediate(resolve);
});

test('итог-отказ хода из очереди снимает «ждёт очереди» и возвращает выжимку в ожидание', async () => {
  const chat = await chatStoreFixture({
    sessions: [chatWith([
      userTurn('первое', 'turn-res-000001'),
      userTurn('второе', 'turn-res-000002', { queued: true }),
    ])],
  });
  const deleted = [];

  apiHarness.get = async (url) => {
    assert.equal(url, '/api/chat/pending');

    return {
      pending: [{
        id: 'turn-res-000002',
        turnId: 'turn-res-000002',
        chatKey: 'res-chat',
        role: 'error',
        reply: 'Сервер перезапускается — сообщение не выполнено. Отправь его ещё раз, когда он вернётся.',
        userText: withSeed(SEED, 'второе'),
        at: 5,
      }],
    };
  };
  apiHarness.post = reconcileWith(apiHarness.post, apiHarness.get);
  apiHarness.put = async () => ack(4);
  apiHarness.del = async (url) => {
    deleted.push(url);

    return { ok: true };
  };

  await chat._collectPending();

  const session = chat.sessions[0];
  const second = session.messages.find((m) => m.turnId === 'turn-res-000002' && m.role === 'user');

  assert.equal(second.queued, undefined, 'реплика не висит «в очереди» после итога');
  assert.equal(session.messages.at(-1).role, 'error');
  assert.equal(session.messages.at(-1).pid, 'turn-res-000002');
  assert.equal(session.pendingSeed, SEED, 'выжимка не донесённого хода снова ждёт следующего сообщения');
  assert.equal(session.messages.filter((m) => m.role === 'user').length, 2, 'реплика не задвоилась');
  assert.deepEqual(deleted, ['/api/chat/pending/turn-res-000002']);
});

test('pending подтверждается только после того, как история с ответом записана', async () => {
  const chat = await chatStoreFixture({
    sessions: [chatWith([userTurn('вопрос', 'turn-res-000003')])],
  });
  const order = [];
  let finishPut;

  apiHarness.get = async () => ({
    pending: [{
      id: 'turn-res-000003',
      turnId: 'turn-res-000003',
      chatKey: 'res-chat',
      role: 'assistant',
      reply: 'ответ',
      userText: 'вопрос',
      at: 7,
    }],
  });
  apiHarness.post = reconcileWith(apiHarness.post, apiHarness.get);
  apiHarness.put = (url, body) => {
    order.push(`PUT:${body.chat.messages.at(-1).text}`);

    return new Promise((resolve) => {
      finishPut = () => resolve(ack(4));
    });
  };
  apiHarness.del = async (url) => {
    order.push(`DELETE:${url}`);

    return { ok: true };
  };

  const collecting = chat._collectPending();

  await tick();
  assert.deepEqual(order, ['PUT:ответ'], 'пока история не записана, pending не трогаем');

  finishPut();
  await collecting;
  assert.deepEqual(order, ['PUT:ответ', 'DELETE:/api/chat/pending/turn-res-000003']);
});

test('ответ для чата, которого в окне ещё нет, не выбрасывается: чат подтягивается с сервера', async () => {
  const chat = await chatStoreFixture({ sessions: [chatWith([])] });
  const deleted = [];
  const remote = {
    id: 'from-tablet',
    title: 'С планшета',
    messages: [userTurn('вопрос с планшета', 'turn-res-000004')],
    revision: 2,
    createdAt: 2,
    updatedAt: 2,
  };

  apiHarness.get = async (url) => {
    if (url === '/api/chat/pending') {
      return {
        pending: [{
          id: 'turn-res-000004',
          turnId: 'turn-res-000004',
          chatKey: 'from-tablet',
          role: 'assistant',
          reply: 'ответ с планшета',
          userText: 'вопрос с планшета',
          at: 9,
        }],
      };
    }

    if (url === '/api/chat/store/head/from-tablet') {
      return { head: protocolHead(remote) };
    }

    assert.equal(url, '/api/chat/store/chat/from-tablet');

    return { chat: remote, version: protocolHead(remote).version };
  };
  apiHarness.post = reconcileWith(apiHarness.post, apiHarness.get);
  apiHarness.put = async () => ack(3);
  apiHarness.del = async (url) => {
    deleted.push(url);

    return { ok: true };
  };

  await chat._pullChat('from-tablet', false);
  await chat.ensureChatMessages('from-tablet');
  await chat._collectPending();

  const tablet = chat.session('from-tablet');

  assert.ok(tablet, 'чат появился в окне');
  assert.deepEqual(tablet.messages.map((m) => `${m.role}:${m.text}`), [
    'user:вопрос с планшета',
    'assistant:ответ с планшета',
  ]);
  assert.deepEqual(deleted, ['/api/chat/pending/turn-res-000004']);
});

test('ответ на приём, опоздавший к концу короткого хода, не возвращает «думает…»', async () => {
  const chat = await chatStoreFixture({ sessions: [chatWith([])] });
  const sse = sseOf(chat);

  chat.turnProtocol = 1;

  let finishAccept;
  let turnId = '';

  apiHarness.put = async () => ack(4);
  apiHarness.post = (url, body) => {
    turnId = body.turnId;

    return new Promise((resolve) => {
      finishAccept = () => resolve({
        accepted: true,
        turnId,
        state: 'started',
      });
    });
  };
  apiHarness.get = async (url) => {
    if (url === '/api/chat/pending') {
      return {
        pending: [{
          id: turnId,
          turnId,
          chatKey: 'res-chat',
          role: 'assistant',
          reply: 'мгновенно',
          userText: 'быстро',
          at: 3,
        }],
      };
    }

    return { active: [], queued: [] };
  };
  apiHarness.post = reconcileWith(apiHarness.post, apiHarness.get);
  apiHarness.del = async () => ({ ok: true });

  const sending = chat.send('res-chat', 'быстро');

  while (!finishAccept) {
    await tick();
  }
  // Ход успел начаться и кончиться по SSE раньше, чем пришёл ответ на приём.
  sse('chat-turn-start', {
    chatKey: 'res-chat',
    at: 1,
    turnId,
  });
  sse('chat-done', {
    chatKey: 'res-chat',
    turnId,
    queued: 0,
  });

  for (let index = 0; index < 5; index += 1) {
    await tick();
  }

  const session = chat.sessions[0];

  assert.equal(session.sending, false);
  assert.equal(session.messages.at(-1).text, 'мгновенно');

  finishAccept();
  await sending;
  assert.equal(session.sending, false, 'законченный ход не «думает» снова');
  assert.equal(session.messages.find((m) => m.turnId === turnId && m.role === 'user').delivery, undefined);
});

test('вопрос из pending не задваивается в частичном окне, где уже видны сообщения его запуска', async () => {
  // Длинный ход: вопрос остался в негружнутом префиксе, лента несёт только хвост
  // с финальным блоком. Восстановление push-ом в хвост ставило вопрос после ответа.
  const runId = 'run-partial-0001';
  const chat = await chatStoreFixture({
    sessions: [chatWith([
      {
        role: 'assistant',
        kind: 'assistant-block',
        runId,
        parentTurnId: 'turn-res-000006',
        assistantMessageId: 'msg-final-1',
        text: 'Реализация завершена',
        complete: true,
        serverCanonical: true,
      },
    ])],
  });
  const deleted = [];

  apiHarness.get = async (url) => {
    if (url === '/api/chat/pending') {
      return {
        pending: [{
          id: 'turn-res-000006',
          turnId: 'turn-res-000006',
          chatKey: 'res-chat',
          role: 'assistant',
          reply: 'Реализация завершена',
          userText: 'Реализуй план',
          runId,
          assistantMessageId: 'msg-final-1',
          at: 11,
        }],
      };
    }

    if (String(url).startsWith('/api/chat/in-turn?')) {
      return { entries: [], throughSequence: 0, nextAfterSequence: null };
    }

    throw new Error(`неожиданный запрос: ${url}`);
  };
  apiHarness.post = reconcileWith(apiHarness.post, apiHarness.get);
  apiHarness.put = async () => ack(4);
  apiHarness.del = async (url) => {
    deleted.push(url);

    return { ok: true };
  };

  await chat._collectPending();

  const session = chat.sessions[0];

  assert.equal(
    session.messages.filter((m) => m.role === 'user' && m.text === 'Реализуй план').length,
    0,
    'копия вопроса не появляется после финала',
  );
  assert.equal(session.messages.length, 1, 'лента не получила лишних сообщений');
  assert.equal(session.messages[0].pid, 'turn-res-000006', 'финал слился с видимым блоком хода');
  assert.deepEqual(deleted, ['/api/chat/pending/turn-res-000006']);
});

test('вопрос восстанавливается в конец, когда сообщений его запуска в ленте нет', async () => {
  // Пустая лента: восстанавливать вопрос по-прежнему нужно, финал встанет после него.
  const chat = await chatStoreFixture({ sessions: [chatWith([])] });
  const deleted = [];

  apiHarness.get = async () => ({
    pending: [{
      id: 'turn-res-000007',
      turnId: 'turn-res-000007',
      chatKey: 'res-chat',
      role: 'assistant',
      reply: 'ответ',
      userText: 'вопрос без следа',
      at: 12,
    }],
  });
  apiHarness.post = reconcileWith(apiHarness.post, apiHarness.get);
  apiHarness.put = async () => ack(4);
  apiHarness.del = async (url) => {
    deleted.push(url);

    return { ok: true };
  };

  await chat._collectPending();

  const session = chat.sessions[0];

  assert.deepEqual(session.messages.map((m) => `${m.role}:${m.text}`), [
    'user:вопрос без следа',
    'assistant:ответ',
  ], 'вопрос восстановлен перед своим ответом');
  assert.deepEqual(deleted, ['/api/chat/pending/turn-res-000007']);
});
