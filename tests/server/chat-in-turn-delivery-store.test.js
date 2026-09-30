// Настоящий chat module, HTTP, общий SSE и браузерный store: один активный запуск.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chatStoreFixture, sseOf } from '../web/helpers/chat-store.js';
import { chatAppFixture, saveChat, turnBody, waitFor } from './helpers/chat-turns.js';

function apiOf(app) {
  async function call(method, url, payload) {
    const response = await app.inject({ method, url,
      ...(payload === undefined ? {} : { payload }) });
    const body = response.body ? response.json() : null;
    if (response.statusCode >= 400) {
      throw Object.assign(new Error(body?.message || 'HTTP error'), {
        status: response.statusCode, data: body,
      });
    }
    return body;
  }
  return {
    get: (url) => call('GET', url),
    post: (url, payload) => call('POST', url, payload),
    put: (url, payload) => call('PUT', url, payload),
    del: (url) => call('DELETE', url),
  };
}

test('POST → общий SSE → store: уточнение и ответ видны до финала, финал один', async (t) => {
  const runs = [];
  const steer = [];
  let release;
  let onSse = null;
  const executor = {
    id: 'test-provider',
    inTurnInput: { protocol: 1, text: true, confirmation: 'forwarded' },
    async run(options) {
      runs.push(options);
      options.onInTurnReady({
        async deliver(input) {
          steer.push(input);
          return { ok: true, state: 'forwarded' };
        },
        close() {},
      });
      await new Promise((resolve) => { release = resolve; });
      return {
        reply: 'Итог второго шага', sessionId: 'session-test', steps: [],
        assistantMessageId: 'answer-final-1234',
      };
    },
  };
  const { app, events } = await chatAppFixture(t, {
    executor, withSsePlugin: true,
    onEvent(name, data) { if (onSse) setImmediate(() => onSse(name, structuredClone(data))); },
  });
  t.after(() => release?.());
  await saveChat(app, 'chat-fixture');
  const api = apiOf(app);
  const chat = await chatStoreFixture({}, { api, fromServer: true });
  onSse = sseOf(chat);

  const started = await app.inject({
    method: 'POST', url: '/api/chat',
    payload: turnBody('chat-fixture', 'turn-fixture-0001', 'Выполни два шага'),
  });
  assert.equal(started.statusCode, 202);
  const active = await waitFor(async () => {
    const response = await api.get('/api/chat/active');
    const run = response.active.find((item) => item.chatKey === 'chat-fixture');
    return run?.inTurn?.available ? run : null;
  }, { what: 'активный порт' });
  await chat._loadActive();
  assert.equal(chat.inTurnFor('chat-fixture').runId, active.runId);
  assert.equal(await chat.sendInTurn('chat-fixture', 'Какой шаг сейчас?'), true);
  await waitFor(() => steer.length === 1, { what: 'передачу в порт' });
  assert.equal(runs.length, 1, 'не создан второй ход');

  await runs[0].onAssistantMessage({
    assistantMessageId: 'answer-mid-12345', text: 'Сейчас первый шаг.',
    sourceRevision: 1, complete: true,
  });
  await waitFor(() => chat.session('chat-fixture').messages
    .some((message) => message.assistantMessageId === 'answer-mid-12345'), {
    what: 'промежуточный ответ в store',
  });
  assert.equal(chat.session('chat-fixture').sending, true);

  await runs[0].onAssistantMessage({
    assistantMessageId: 'answer-final-1234', text: 'Итог второго шага',
    sourceRevision: 1, complete: true,
  });
  release();
  await waitFor(() => events.some((event) => event.event === 'chat-done'), {
    what: 'завершение исходного хода',
  });
  await chat._collectPending();
  const messages = chat.session('chat-fixture').messages;
  assert.equal(messages.filter((message) => message.assistantMessageId === 'answer-mid-12345').length, 1);
  assert.equal(messages.filter((message) => message.assistantMessageId === 'answer-final-1234').length, 1);
  assert.equal(messages.filter((message) => message.messageId === steer[0].messageId).length, 1);
  assert.equal(messages.find((message) => message.assistantMessageId === 'answer-final-1234').pid,
    'turn-fixture-0001');
  assert.equal(runs.length, 1);
});
