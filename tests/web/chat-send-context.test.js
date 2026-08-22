// Проверяет передачу захваченного UI-контекста при отправке обычного чата.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apiHarness,
  chatNotifications,
  chatStoreFixture,
  setChatContextCapture,
} from './helpers/chat-store.js';

function session(extra = {}) {
  return {
    id: 'c1', taskId: null, title: 'Разговор', purpose: '', model: 'test-model',
    modelRef: { provider: 'test-provider', model: 'test-model' }, effort: '',
    mode: 'acceptEdits', messages: [], createdAt: 1, updatedAt: 1, ...extra,
  };
}

test('COMP-CTX-11: send фиксирует UI context один раз и не сериализует routingScope', async () => {
  const chat = await chatStoreFixture({ sessions: [session()] });
  let captures = 0;
  let request = null;
  setChatContextCapture(() => {
    captures += 1;
    return Object.freeze({
      routingScope: Object.freeze({ kind: 'task', taskId: '777' }),
      promptContext: Object.freeze({ page: 'Конвейер', path: '/pipeline', details: { safe: true } }),
    });
  });
  apiHarness.post = async (url, body) => {
    request = { url, body };
    return { reply: 'Готово' };
  };

  assert.equal(await chat.send('c1', 'Проверь здесь'), true);
  assert.equal(captures, 1);
  assert.equal(request.url, '/api/chat', 'routingScope не выбирает task endpoint');
  assert.deepEqual(request.body.context, {
    page: 'Конвейер', path: '/pipeline', details: { safe: true },
  });
  assert.equal(Object.hasOwn(request.body.context, 'routingScope'), false);
});

test('COMP-ROUTE-10/13: sendTurn даёт direct result и request-only plan override', async () => {
  const chat = await chatStoreFixture({ sessions: [session()] });
  let body = null;
  apiHarness.post = async (_url, value) => {
    body = value;
    return { reply: 'Короткий прямой ответ', sessionId: 'provider-session', speechSafe: true };
  };

  const promptContext = Object.freeze({ page: 'Задача', path: '/board' });
  const result = await chat.sendTurn('c1', 'Что дальше?', [], {
    promptContext,
    modeOverride: 'plan',
    companionTurn: true,
  });

  assert.deepEqual(result, {
    accepted: true,
    directReply: 'Короткий прямой ответ',
    messageId: result.messageId,
    offline: false,
    error: '',
    steps: [],
    speechSafe: true,
  });
  assert.match(result.messageId, /^c1:\d+:assistant$/);
  assert.equal(body.mode, 'plan');
  assert.equal(body.companionTurn, true);
  assert.equal(body.context, promptContext);
  assert.equal(chat.sessions[0].mode, 'acceptEdits', 'request override не сохраняется в chat metadata');
});

test('COMP-ROUTE-01/05: ensure companion adopts server record без выбора и старого notification', async () => {
  const normal = session({ id: 'normal', messages: [] });
  const chat = await chatStoreFixture({ sessions: [normal], activeId: 'normal' });
  let request = null;
  apiHarness.post = async (url, body) => {
    request = { url, body };
    return {
      chat: {
        id: 'server-companion-44', purpose: 'companion', taskId: '44', title: 'Помощник',
        messages: [{ role: 'assistant', text: 'Старый ответ' }], createdAt: 2, updatedAt: 3,
      },
    };
  };

  const ensured = await chat.ensureCompanion({ taskId: '44' });

  assert.equal(ensured.id, 'server-companion-44');
  assert.equal(chat.activeId, 'normal');
  assert.equal(chatNotifications().length, 0);
  assert.equal(request.url, '/api/chat/store/ensure');
  assert.deepEqual(Object.keys(request.body).sort(), ['origin', 'purpose', 'taskId']);
});

test('COMP-ENSURE-06: client newSession/setTask не создают и не перепривязывают companion identity', async () => {
  const companion = session({ id: 'companion', purpose: 'companion', taskId: '8' });
  const chat = await chatStoreFixture({ sessions: [companion] });

  assert.throws(() => chat.newSession({ purpose: 'companion', taskId: '9' }), /только атомарно/i);
  assert.equal(chat.setTask('companion', '9', 'Подмена'), false);
  assert.equal(chat.sessions[0].taskId, '8');
});
