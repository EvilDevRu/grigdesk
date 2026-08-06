import assert from 'node:assert/strict';
import test from 'node:test';

import { apiHarness, chatStoreFixture } from './helpers/chat-store.js';

test('выбор модели сохраняет provider/model, legacy model и durable revision до запуска', async () => {
  const chat = await chatStoreFixture({
    sessions: [{
      id: 'model-chat',
      model: '',
      modelRef: null,
      revision: 0,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  const session = chat.sessions[0];
  chat.setModel('model-chat', 'chosen-model');
  assert.equal(session.model, 'chosen-model');
  assert.deepEqual(session.modelRef, { provider: 'test-provider', model: 'chosen-model' });
  assert.deepEqual(chat.defModelRef, { provider: 'test-provider', model: 'chosen-model' });

  let payload;
  apiHarness.put = async (url, body) => {
    assert.equal(url, '/api/chat/store/chat');
    payload = body;
    return {
      revision: 1,
      schema: 2,
      surface: 'chats',
      modelRef: { provider: 'test-provider', model: 'chosen-model' },
      modelRefState: { state: 'resolved' },
    };
  };
  await chat._saveChatNow(session);
  assert.deepEqual(payload.chat.modelRef, { provider: 'test-provider', model: 'chosen-model' });
  assert.equal(payload.chat.revision, 0);
  assert.equal(session.revision, 1);
  assert.equal(session.surface, 'chats');
});

test('stale durable save повторяет CAS и запускает ход ровно один раз с выбранной моделью', async () => {
  const chat = await chatStoreFixture({
    sessions: [{
      id: 'stale-chat',
      model: 'chosen-model',
      modelRef: { provider: 'test-provider', model: 'chosen-model' },
      revision: 2,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  const puts = [];
  apiHarness.put = async (_url, body) => {
    puts.push(JSON.parse(JSON.stringify(body.chat)));
    if (puts.length === 1) {
      return {
        stale: true,
        revision: 3,
        schema: 2,
        surface: 'chats',
        modelRef: { provider: 'test-provider', model: 'other-model' },
      };
    }
    return {
      stale: false,
      revision: 4,
      schema: 2,
      surface: 'chats',
      modelRef: { provider: 'test-provider', model: 'chosen-model' },
    };
  };
  let posts = 0;
  let requestSentAt = 0;
  apiHarness.post = async (url, body) => {
    posts += 1;
    assert.equal(url, '/api/chat');
    assert.deepEqual(body.modelRef, { provider: 'test-provider', model: 'chosen-model' });
    requestSentAt = body.sentAt;
    return { reply: 'План готов', model: 'chosen-model' };
  };

  const beforeSend = Date.now();
  await chat.send('stale-chat', 'Составь план в md');

  assert.equal(puts.length, 2);
  assert.equal(puts[0].revision, 2);
  assert.equal(puts[1].revision, 3, 'повтор использует revision из stale-ack');
  assert.deepEqual(puts[1].modelRef, { provider: 'test-provider', model: 'chosen-model' });
  assert.equal(posts, 1, 'CAS можно повторять, model POST — нельзя');
  assert.equal(chat.sessions[0].revision, 4);
  assert.equal(chat.sessions[0].offline, false);
  assert.equal(chat.sessions[0].sending, false);
  assert.equal(chat.sessions[0].messages.at(-1).text, 'План готов');
  const userMessage = chat.sessions[0].messages.find((message) => message.role === 'user');
  assert.ok(userMessage.sentAt >= beforeSend && userMessage.sentAt <= Date.now());
  assert.equal(requestSentAt, userMessage.sentAt, 'сервер получает исходное время запроса для pending-восстановления');
  assert.equal(puts[0].messages[0].sentAt, userMessage.sentAt, 'время попадает в durable историю до model POST');
});

test('неисчерпаемый stale не маскируется под обрыв и не запускает агента', async () => {
  const chat = await chatStoreFixture({
    sessions: [{
      id: 'busy-chat',
      model: 'chosen-model',
      modelRef: { provider: 'test-provider', model: 'chosen-model' },
      revision: 5,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  let puts = 0;
  let posts = 0;
  apiHarness.put = async () => ({
    stale: true,
    revision: 6 + puts++,
    schema: 2,
    surface: 'chats',
    modelRef: { provider: 'test-provider', model: 'other-model' },
  });
  apiHarness.post = async () => { posts += 1; return {}; };

  await chat.send('busy-chat', 'Не потеряй это сообщение');

  assert.equal(puts, 3, 'конфликт повторяется ограниченно');
  assert.equal(posts, 0, 'до снятия конфликта executor не запускается');
  assert.equal(chat.sessions[0].offline, false);
  assert.equal(chat.sessions[0].sending, false);
  assert.equal(chat.sessions[0].messages.at(-1).role, 'error');
  assert.match(chat.sessions[0].messages.at(-1).text, /одновременно меняется/);
});

test('сеть на durable save означает «не отправлено», а не «ход продолжается»', async () => {
  const chat = await chatStoreFixture({
    sessions: [{
      id: 'save-offline-chat',
      model: 'chosen-model',
      modelRef: { provider: 'test-provider', model: 'chosen-model' },
      revision: 1,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  let posts = 0;
  apiHarness.put = async () => { throw new TypeError('Failed to fetch'); };
  apiHarness.post = async () => { posts += 1; return {}; };

  await chat.send('save-offline-chat', 'Сообщение');

  assert.equal(posts, 0);
  assert.equal(chat.sessions[0].offline, false);
  assert.equal(chat.sessions[0].sending, false);
  assert.equal(chat.sessions[0].messages.at(-1).role, 'error');
  assert.equal(chat.sessions[0].messages.at(-1).text, 'Failed to fetch');
  // `send()` ставит обычный persist истории; после проверенного разового сбоя даём
  // ему успешный ответ, чтобы тест не держал вечную цепочку retry-таймеров.
  apiHarness.put = async () => ({ revision: 2, schema: 2, surface: 'chats' });
});

test('reset Kimi подтверждается сервером, очищает binding-метрики и задерживает send', async () => {
  const chat = await chatStoreFixture({
    sessions: [{
      id: 'kimi-reset-chat',
      model: 'kimi-test',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
      revision: 3,
      messages: [],
      sessionId: 'old-kimi-session',
      contextTokens: 123,
      contextWindow: 456,
      contextMetric: 'exact',
      contextIsEstimate: true,
      totalInputTokens: 789,
      cachedInputTokens: 12,
      pendingSeed: 'не переносить после явного reset',
      compactedAt: 44,
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  let finishReset;
  const resetGate = new Promise((resolve) => { finishReset = resolve; });
  const order = [];
  apiHarness.post = async (url, body) => {
    order.push(url);
    if (url === '/api/chat/session/reset') {
      assert.deepEqual(body, {
        chatKey: 'kimi-reset-chat',
        modelRef: { provider: 'kimi', model: 'kimi-test' },
      });
      await resetGate;
      return { ok: true, reset: true };
    }
    assert.equal(url, '/api/chat');
    return { reply: 'Новая сессия', sessionId: 'new-kimi-session' };
  };
  apiHarness.put = async () => {
    order.push('durable-save');
    return {
      revision: 4,
      schema: 2,
      surface: 'chats',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
    };
  };

  const reset = chat.resetContext('kimi-reset-chat', { note: false });
  const send = chat.send('kimi-reset-chat', 'Первый вопрос чистой сессии');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['/api/chat/session/reset'], 'model POST ждёт подтверждения reset');
  finishReset();
  assert.equal(await reset, true);
  assert.equal(await send, true);

  const session = chat.sessions[0];
  assert.deepEqual(order, ['/api/chat/session/reset', 'durable-save', '/api/chat']);
  assert.equal(session.sessionId, 'new-kimi-session');
  assert.equal(session.contextTokens, 0);
  assert.equal(session.contextWindow, 0);
  assert.equal(session.contextMetric, '');
  assert.equal(session.contextIsEstimate, false);
  assert.equal(session.totalInputTokens, 0);
  assert.equal(session.cachedInputTokens, 0);
  assert.equal(session.pendingSeed, '');
  assert.equal(session.compactedAt, 0);
  assert.equal(session.sessionResetting, false);
  assert.equal(session.sessionResetFailed, false);
});

test('ошибка server-owned reset не обнуляет локальную session и блокирует следующий ход', async () => {
  const chat = await chatStoreFixture({
    sessions: [{
      id: 'kimi-reset-failed',
      model: 'kimi-test',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
      revision: 2,
      messages: [],
      sessionId: 'still-live-session',
      contextTokens: 99,
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  let posts = 0;
  apiHarness.post = async (url) => {
    posts += 1;
    assert.equal(url, '/api/chat/session/reset');
    throw new Error('сервер недоступен');
  };

  assert.equal(await chat.resetContext('kimi-reset-failed'), false);
  assert.equal(await chat.send('kimi-reset-failed', 'не отправлять в старую session'), false);

  const session = chat.sessions[0];
  assert.equal(posts, 1);
  assert.equal(session.sessionId, 'still-live-session');
  assert.equal(session.contextTokens, 99);
  assert.equal(session.sessionResetFailed, true);
  assert.equal(session.messages.at(-1).role, 'error');
  assert.match(session.messages.at(-1).text, /Повтори сброс/);
});

test('sessionReset в ответе и ошибке сервера очищает устаревший Kimi resume id', async () => {
  for (const variant of ['stopped', 'error']) {
    const chat = await chatStoreFixture({
      sessions: [{
        id: `kimi-${variant}`,
        model: 'kimi-test',
        modelRef: { provider: 'kimi', model: 'kimi-test' },
        revision: 1,
        messages: [],
        sessionId: 'cancelled-session',
        contextTokens: 77,
        contextWindow: 100,
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    apiHarness.put = async () => ({
      revision: 2,
      schema: 2,
      surface: 'chats',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
    });
    apiHarness.post = async () => {
      if (variant === 'stopped') {
        return { reply: '⏹ Ход остановлен.', stopped: true, sessionReset: true, sessionId: null };
      }
      const error = new Error('Kimi завершил ход без ответа');
      error.data = { error: 'kimi_empty_response', sessionReset: true };
      throw error;
    };

    assert.equal(await chat.send(`kimi-${variant}`, 'тестовая реплика'), true);
    const session = chat.sessions[0];
    assert.equal(session.sessionId, null);
    assert.equal(session.contextTokens, 0);
    assert.equal(session.contextWindow, 0);
    assert.equal(session.sessionResetFailed, false);
    assert.notEqual(session.messages.at(-1).text, '(пусто)');
  }
});

test('sessionResetFailed от сервера сохраняет id и блокирует resume до явного reset', async () => {
  const chat = await chatStoreFixture({
    sessions: [{
      id: 'kimi-reset-contract-failed',
      model: 'kimi-test',
      modelRef: { provider: 'kimi', model: 'kimi-test' },
      revision: 1,
      messages: [],
      sessionId: 'do-not-resume-automatically',
      contextTokens: 77,
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  apiHarness.put = async () => ({
    revision: 2,
    schema: 2,
    surface: 'chats',
    modelRef: { provider: 'kimi', model: 'kimi-test' },
  });
  let modelPosts = 0;
  apiHarness.post = async () => {
    modelPosts += 1;
    const error = new Error('сессию сбросить не удалось');
    error.data = { error: 'kimi_session_reset_failed', sessionResetFailed: true };
    throw error;
  };

  assert.equal(await chat.send('kimi-reset-contract-failed', 'первый ход'), true);
  assert.equal(await chat.send('kimi-reset-contract-failed', 'не возобновлять'), false);
  const session = chat.sessions[0];
  assert.equal(modelPosts, 1);
  assert.equal(session.sessionId, 'do-not-resume-automatically');
  assert.equal(session.contextTokens, 77);
  assert.equal(session.sessionResetFailed, true);
});
