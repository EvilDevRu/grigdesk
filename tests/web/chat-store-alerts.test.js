import assert from 'node:assert/strict';
import test from 'node:test';
import {
  apiHarness,
  chatDismissed,
  chatNotifications,
  chatStoreFixture,
  setChatVisible,
  sseOf,
} from './helpers/chat-store.js';

const BASH = {
  pid: 'p1',
  kind: 'perm',
  chatKey: 'c1',
  tool: 'Bash',
  input: {
    description: 'Список файлов',
    command: 'ls -la',
  },
};
/**
 * Начальная сверка waiting завершается до нового события SSE.
 * Иначе её пустой ответ мог бы стереть запрос, который тест только что добавил.
 */
async function fixture() {
  const chat = await chatStoreFixture({
    sessions: [{
      id: 'c1',
      title: 'Чат',
      messages: [],
      steps: [],
      createdAt: 100,
      updatedAt: 200,
    }]
  });
  const sse = sseOf(chat);

  await new Promise(setImmediate);

  return {
    chat,
    sse
  };
}

test('C3: ответ сообщает область и цель чата', async () => {
  const {
    chat
  } = await fixture();

  chat._notifyReply(chat.sessions[0], 'Готово', 'k1');

  const notice = chatNotifications()[0][3];

  assert.equal(notice?.id, 'chat-c1');
  assert.equal(notice.scope, 'chat:c1');
  assert.equal(notice.tone, 'accent');
  assert.deepEqual(notice.target, {
    kind: 'chat',
    chatId: 'c1'
  });
  assert.equal(Boolean(notice.sticky), false);
});
test('C4: простое разрешение показывает полный текст и быстрые кнопки', async () => {
  const {
    sse
  } = await fixture();

  sse('chat-permission', BASH);

  const notice = chatNotifications()[0][3];

  assert.equal(notice?.id, 'chat-ask-p1');
  assert.equal(notice.scope, 'chat:c1');
  assert.equal(notice.tone, 'warning');
  assert.equal(notice.sticky, true);
  assert.equal(notice.detail, 'Список файлов\nls -la');
  assert.deepEqual(notice.actions.map((action) => action.label), ['Разрешить', 'Отклонить']);
});
test('C4: allow отвечает агенту без перехода', async () => {
  const {
    sse
  } = await fixture();
  const posted = [];

  apiHarness.post = async (url, body) => {
    posted.push({
      url,
      body
    });

    return {};
  };
  sse('chat-permission', BASH);
  await chatNotifications()[0][3].actions[0].run();
  assert.deepEqual(posted, [{
    url: '/api/chat/permission/p1',
    body: {
      allow: true
    }
  }]);
});
test('C4: deny отвечает агенту без перехода', async () => {
  const {
    sse
  } = await fixture();
  const posted = [];

  apiHarness.post = async (url, body) => {
    posted.push({
      url,
      body
    });

    return {};
  };
  sse('chat-permission', BASH);
  await chatNotifications()[0][3].actions[1].run();
  assert.deepEqual(posted, [{
    url: '/api/chat/permission/p1',
    body: {
      allow: false
    }
  }]);
});
test('C4: план оставляет только цель чата', async () => {
  const {
    sse
  } = await fixture();

  sse('chat-permission', {
    ...BASH,
    input: {
      ...BASH.input,
      plan: 'План действий'
    }
  });

  const notice = chatNotifications()[0][3];

  assert.deepEqual(notice.actions, []);
  assert.deepEqual(notice.target, {
    kind: 'chat',
    chatId: 'c1'
  });
});
test('C4: вопрос проверяется отдельно от разрешения', async () => {
  const {
    sse
  } = await fixture();

  sse('chat-question', {
    pid: 'q1',
    chatKey: 'c1',
    questions: [{
      question: 'Продолжить?'
    }]
  });
  assert.deepEqual(chatNotifications()[0][3].actions, []);
});
test('C4: видимый чат не оповещает о своём вопросе', async () => {
  const {
    sse
  } = await fixture();

  setChatVisible('c1');
  sse('chat-permission', BASH);
  assert.equal(chatNotifications().length, 0);
});
test('C5: ответ из другого окна гасит запрос', async () => {
  const {
    sse
  } = await fixture();

  sse('chat-permission', BASH);
  sse('chat-permission-done', {
    pid: 'p1'
  });
  assert.equal(chatDismissed().includes('chat-ask-p1'), true);
});
test('C5: свой ответ тоже гасит запрос', async () => {
  const {
    chat,
    sse
  } = await fixture();

  sse('chat-permission', BASH);
  await chat.answerPerm('p1', true);
  assert.equal(chatDismissed().includes('chat-ask-p1'), true);
});
test('C6: полная сверка гасит исчезнувший запрос и сохраняет живой', async () => {
  const {
    chat,
    sse
  } = await fixture();

  sse('chat-permission', BASH);
  sse('chat-permission', {
    ...BASH,
    pid: 'p2'
  });
  apiHarness.get = async () => ({
    waiting: [{
      ...BASH,
      pid: 'p2'
    }]
  });
  await chat._loadWaiting();
  assert.deepEqual(chatDismissed(), ['chat-ask-p1']);
  assert.deepEqual(Object.keys(chat.pending), ['p2']);
});
test('C7: видимый чат гасит scope даже без unread', async () => {
  const {
    chat
  } = await fixture();

  chat.markRead('c1');
  assert.deepEqual(chatDismissed(), []);
  setChatVisible('c1');
  chat.markRead('c1');
  assert.equal(chatDismissed().includes('scope:chat:c1'), true);
});
test('C8: ошибка истории срочная, один раз до восстановления', async () => {
  const {
    chat
  } = await fixture();

  chat._saveFailed(true, 'диск полон');

  const notice = chatNotifications()[0][3];

  assert.equal(notice?.id, 'chat-save-error');
  assert.equal(notice.tone, 'danger');
  assert.equal(notice.sticky, true);
  chat._saveFailed(true, 'другая ошибка');
  assert.equal(chatNotifications().length, 1);
  chat._saveFailed(false);
  assert.equal(chatDismissed().includes('chat-save-error'), true);
});
