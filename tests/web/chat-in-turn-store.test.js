import assert from 'node:assert/strict';
import test from 'node:test';
import { apiHarness, chatStoreFixture, sseOf } from './helpers/chat-store.js';
import { materializeInTurnMessages } from '../../web/src/stores/chatInTurn.ts';

const CHAT = 'in-turn-chat';
const RUN = 'run-12345678';
const TURN = 'turn-12345678';
const base = () => ({
  id: CHAT,
  title: 'Тест',
  taskId: null,
  model: 'test-model',
  messages: [{
    role: 'user',
    text: 'Сделай два шага',
    turnId: TURN,
  }],
  steps: [],
  sending: false,
  draft: '',
});
const availability = {
  runId: RUN,
  available: true,
  revision: 2,
};
const receipt = (sequence, messageId, state = 'forwarded', revision = 2) => ({
  chatKey: CHAT,
  runId: RUN,
  parentTurnId: TURN,
  messageId,
  sequence,
  revision,
  state,
  text: `уточнение ${sequence}`,
  acceptedAt: 100 + sequence,
  updatedAt: 100 + sequence,
});
const block = (sequence, id, complete = true, revision = 1) => ({
  chatKey: CHAT,
  runId: RUN,
  assistantMessageId: id,
  sequence,
  revision,
  text: `ответ ${sequence}`,
  complete,
  startedAt: 100 + sequence,
});
const page = (entries, next = null, through = 4) => ({
  entries,
  nextAfterSequence: next,
  throughSequence: through,
  runRevision: 4,
  truncated: next !== null,
  availability,
});

test('FLOW-11/16: active snapshot and paged GET restore ordered messages once', async () => {
  const chat = await chatStoreFixture({ sessions: [base()] });
  const full = [receipt(1, 'msg-12345678'), block(2, 'answer-12345678'),
    receipt(3, 'msg-87654321'), block(4, 'answer-87654321')];
  const calls = [];

  apiHarness.get = async (url) => {
    calls.push(url);

    if (url === '/api/chat/active') {
      return {
        protocol: 1,
        active: [{
          chatKey: CHAT,
          runId: RUN,
          turnId: TURN,
          inTurn: { ...availability, ...page(full.slice(0, 2), 2) },
        }],
      };
    }
    if (url.includes('afterSequence=0')) {
      return page(full.slice(0, 2), 2);
    }
    if (url.includes('afterSequence=2')) {
      return page(full.slice(2));
    }

    throw new Error(url);
  };
  await chat._loadActive();

  const messages = chat.sessions[0].messages;

  assert.deepEqual(messages.map((m) => m.text), [
    'Сделай два шага', 'уточнение 1', 'ответ 2', 'уточнение 3', 'ответ 4',
  ]);
  assert.equal(chat.inTurnFor(CHAT).completeThrough, 4);
  assert.equal(calls.filter((url) => url.includes('afterSequence=')).length, 2);
  assert.equal(messages.filter((m) => m.assistantMessageId === 'answer-12345678').length, 1);
});

test('FLOW-11: late draft/receipt revisions do not roll back completed answer', async () => {
  const chat = await chatStoreFixture({ sessions: [base()] });

  chat.inTurnProtocol = 1;
  chat._mergeInTurnSnapshot(CHAT, RUN, { ...availability,
    ...page([receipt(1, 'msg-12345678', 'consumed', 5),
      block(2, 'answer-12345678', true, 4)], null, 2) }, TURN);

  const run = chat.inTurnFor(CHAT);
  const { mergeInTurnEntry } = await import('../../web/src/stores/chatInTurn.ts');

  assert.equal(mergeInTurnEntry(run, receipt(1, 'msg-12345678', 'accepted', 2)), false);
  assert.equal(mergeInTurnEntry(run, block(2, 'answer-12345678', false, 5)), false);
  assert.equal(run.entries[0].state, 'consumed');
  assert.equal(run.entries[1].complete, true);
});

test('FLOW-20: seen pid waits for every in-turn page and durable chat write', async () => {
  const s = base();

  s.messages.push({
    role: 'assistant',
    pid: 'pending-1',
    text: 'Итог',
  });

  const chat = await chatStoreFixture({ sessions: [s] });
  const deleted = [];
  let failSecondPage = true;

  apiHarness.get = async (url) => {
    if (url === '/api/chat/pending') {
      return {
        pending: [{
          id: 'pending-1',
          chatKey: CHAT,
          turnId: TURN,
          runId: RUN,
          reply: 'Итог',
          role: 'assistant',
          userText: 'Сделай два шага',
        }],
      };
    }
    if (url.includes('afterSequence=0')) {
      return page([receipt(1, 'msg-12345678')], 1, 2);
    }
    if (url.includes('afterSequence=1')) {
      if (failSecondPage) {
        throw new Error('page unavailable');
      }

      return page([block(2, 'answer-12345678')], null, 2);
    }

    throw new Error(url);
  };
  apiHarness.del = async (url) => {
    deleted.push(url);

    return {};
  };
  chat._writeChat = async () => {};
  await chat._collectPending();
  assert.deepEqual(deleted, []);
  failSecondPage = false;
  await chat._collectPending();
  assert.deepEqual(deleted, ['/api/chat/pending/pending-1']);
  assert.equal(s.messages.filter((m) => m.assistantMessageId === 'answer-12345678').length, 1);
});

test('accepted POST and SSE receipt keep one identity; rejection keeps draft for caller', async () => {
  const chat = await chatStoreFixture({ sessions: [base()] });
  const sse = sseOf(chat);

  chat.inTurnProtocol = 1;
  chat._mergeInTurnSnapshot(CHAT, RUN, { ...availability, ...page([], null, 0) }, TURN);

  let sent;

  apiHarness.post = async (_url, body) => {
    sent = body;

    return { accepted: true, ...receipt(1, body.messageId, 'accepted', 1) };
  };
  assert.equal(await chat.sendInTurn(CHAT, 'уточнение 1'), true);
  assert.equal(sent.targetRunId, RUN);
  apiHarness.get = async () => page([receipt(1, sent.messageId, 'forwarded', 2)], null, 1);
  sse('chat-in-turn', {
    chatKey: CHAT,
    runId: RUN,
    kind: 'receipt',
    messageId: sent.messageId,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(chat.inTurnFor(CHAT).entries[0].state, 'forwarded');
  assert.equal(chat.sessions[0].messages.filter((m) => m.messageId === sent.messageId).length, 1);
  apiHarness.post = async () => {
    throw Object.assign(new Error('Ход завершён'), { status: 409 });
  };
  apiHarness.get = async () => ({ messages: {} });
  assert.equal(await chat.sendInTurn(CHAT, 'другой вопрос'), false);
  assert.match(chat.inTurnError, /Ход завершён/);
});

test('финал из pending дополняет видимый блок и сохраняет метаданные после сверки', async () => {
  const chat = await chatStoreFixture({ sessions: [base()] });
  const answer = block(1, 'answer-12345678');

  chat._mergeInTurnSnapshot(CHAT, RUN, {
    ...availability,
    ...page([answer], null, 1),
  }, TURN);

  const session = chat.sessions[0];
  const steps = [{
    k: 'text',
    id: answer.assistantMessageId,
    text: answer.text,
  }];

  chat._applyPending(session, {
    id: 'pending-final',
    chatKey: CHAT,
    turnId: TURN,
    runId: RUN,
    assistantMessageId: answer.assistantMessageId,
    reply: answer.text,
    userText: 'Сделай два шага',
    cost: 0.1,
    steps,
  });
  chat._materializeInTurn(chat.inTurnFor(CHAT));

  const replies = session.messages.filter((message) => message.role === 'assistant');

  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, answer.text);
  assert.equal(replies[0].pid, 'pending-final');
  assert.equal(replies[0].finalAssistantMessageId, answer.assistantMessageId);
  assert.equal(replies[0].cost, 0.1);
  assert.deepEqual(replies[0].steps, steps);
});

test('потерянный ответ POST восстанавливает ту же попытку по receipt', async () => {
  const chat = await chatStoreFixture({ sessions: [base()] });

  chat.inTurnProtocol = 1;
  chat._mergeInTurnSnapshot(CHAT, RUN, { ...availability, ...page([], null, 0) }, TURN);

  let sent;

  apiHarness.post = async (_url, body) => {
    sent = body;

    throw new Error('Ответ потерялся');
  };
  apiHarness.get = async () => ({ messages: { [sent.messageId]: receipt(1, sent.messageId) } });
  assert.equal(await chat.sendInTurn(CHAT, 'уточнение 1'), true);
  assert.equal(chat.inTurnAttempts[CHAT], undefined);
  assert.equal(chat.sessions[0].messages.filter((message) => message.messageId === sent.messageId).length, 1);
});

test('повтор страницы сохраняет массив и сообщения, не читая тела исторических шагов', () => {
  const steps = [{ get text() { throw new Error('Прочитано тяжёлое тело'); } }];
  const run = {
    runId: RUN,
    parentTurnId: TURN,
    entries: [receipt(1, 'msg-12345678'),
    block(2, 'answer-12345678')]
  };
  const history = materializeInTurnMessages([
    {
      role: 'assistant',
      text: 'Прежний ответ',
      steps
    }, ...base().messages,
  ], run);
  const repeated = materializeInTurnMessages(history, {
    ...run,
    entries: run.entries.map((entry) => ({ ...entry })),
  });

  assert.equal(repeated === history, true);
  assert.equal(repeated[0].steps === steps, true);
});

test('повтор SSE и draft после блока не материализуют историю и не ставят запись', async () => {
  const chat = await chatStoreFixture({ sessions: [base()] });
  const sse = sseOf(chat);
  let writes = 0;

  chat._persist = () => {
     writes += 1;
  };
  chat._ensureInTurn(CHAT, RUN, TURN);

  const completed = block(1, 'answer-12345678');

  sse('chat-assistant-message', {
    chatKey: CHAT,
    runId: RUN,
    block: completed
  });

  const messages = chat.sessions[0].messages;
  const updatedAt = chat.sessions[0].updatedAt;

  assert.equal(writes, 1);
  sse('chat-assistant-message', {
    chatKey: CHAT,
    runId: RUN,
    block: {
    ...completed
  }
  });
  sse('chat-assistant-message', {
    chatKey: CHAT,
    runId: RUN,
    block: block(2, 'answer-draft', false)
  });
  assert.equal(chat.sessions[0].messages === messages, true);
  assert.equal(chat.sessions[0].updatedAt, updatedAt);
  assert.equal(writes, 1);
  assert.equal(chat.inTurnFor(CHAT).entries.at(-1).text, 'ответ 2');

  sse('chat-assistant-message', {
    chatKey: CHAT,
    runId: RUN,
    block: block(2, 'answer-draft', true, 2)
  });
  assert.equal(writes, 2);
  assert.equal(chat.sessions[0].messages.length, 3);
});
