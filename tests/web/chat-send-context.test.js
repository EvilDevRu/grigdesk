// Проверяет передачу захваченного UI-контекста при отправке обычного чата.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apiHarness,
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

test('COMP-ENSURE-06: client newSession/setTask не создают и не перепривязывают companion identity', async () => {
  const companion = session({ id: 'companion', purpose: 'companion', taskId: '8' });
  const chat = await chatStoreFixture({ sessions: [companion] });

  assert.throws(() => chat.newSession({ purpose: 'companion', taskId: '9' }), /только атомарно/i);
  assert.equal(chat.setTask('companion', '9', 'Подмена'), false);
  assert.equal(chat.sessions[0].taskId, '8');
});
