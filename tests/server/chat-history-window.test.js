import path from 'node:path';
import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { AuthStore } from '../../server/src/lib/authStore.ts';
import authPlugin from '../../server/src/plugins/auth.ts';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  jsonRequest, listFixture, readChat, sampleChat, writeChat,
} from './helpers/chat-list.js';

// У каждой записи свой текст и steps: проверка сравнивает всю ленту.
// Одинаковое число записей не скроет потерю порядка или содержимого.
function longChat() {
  return sampleChat('long-window', {
    messages: Array.from({ length: 101 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      text: `Сообщение ${index}`,
      pid: `message-${index}`,
      steps: [{ k: 'text', text: `Шаг ${index}` }],
    })),
  });
}

test('PAGE-HISTORY: первая порция содержит конец, older восстанавливает 101 запись', async (t) => {
  const original = longChat();
  const fixture = await listFixture(t, [original]);
  const url = `/api/chat/store/chat/${original.id}?window=1`;
  let data = await jsonRequest(fixture.app, 'GET', url);

  assert.equal(data.chat.messages.length, 40);
  assert.equal(data.chat.messages[0].text, 'Сообщение 61');

  const all = [...data.chat.messages];

  for (let attempt = 0; data.window.before && attempt < 3; attempt += 1) {
    data = await jsonRequest(fixture.app, 'GET',
      `${url}&before=${encodeURIComponent(data.window.before)}`);
    assert.ok(data.chat.messages.length <= 40);
    all.unshift(...data.chat.messages);
  }

  assert.equal(data.window.before, null);
  assert.deepEqual(all, original.messages);

  const full = await jsonRequest(fixture.app, 'GET', `/api/chat/store/chat/${original.id}`);

  assert.deepEqual(full.chat.messages, original.messages);
});

test('PAGE-HISTORY-APPEND: добавление в конец не инвалидирует older cursor', async (t) => {
  const original = longChat();
  const fixture = await listFixture(t, [original]);
  const url = `/api/chat/store/chat/${original.id}?window=1`;
  const first = await jsonRequest(fixture.app, 'GET', url);
  const current = await readChat(fixture, original);

  current.messages.push({
    role: 'assistant',
    text: 'Новый ответ',
    pid: 'new-reply'
  });
  await writeChat(fixture, current);

  const older = await jsonRequest(fixture.app, 'GET',
    `${url}&before=${encodeURIComponent(first.window.before)}`);

  assert.equal(older.chat.messages.at(-1).text, 'Сообщение 60');
  assert.equal(older.chat.messages.some((message) => message.pid === 'new-reply'), false);
});

test('PAGE-SAVE: suffix PUT сохраняет все 61 невидимые записи и их steps', async (t) => {
  const original = longChat();
  const fixture = await listFixture(t, [original]);
  const url = `/api/chat/store/chat/${original.id}?window=1`;
  const view = await jsonRequest(fixture.app, 'GET', url);
  const before = await readChat(fixture, original);

  view.chat.messages.push({
    role: 'user',
    text: 'Новая реплика',
    turnId: 'page-turn-new'
  });
  view.chat.draft = 'Черновик';
  await jsonRequest(fixture.app, 'PUT', '/api/chat/store/chat/window', {
    chat: view.chat,
    window: { offset: view.window.offset, prefixHash: view.window.prefixHash },
    archived: false,
  });

  const saved = await readChat(fixture, original);

  assert.deepEqual(saved.messages.slice(0, 101), before.messages);
  assert.equal(saved.messages.at(-1).text, 'Новая реплика');
  assert.equal(saved.draft, 'Черновик');
  assert.equal('historyWindow' in saved, false);
});

test('PAGE-SAVE-CONFLICT: изменённый prefix даёт 409 без записи', async (t) => {
  const original = longChat();
  const fixture = await listFixture(t, [original]);
  const view = await jsonRequest(fixture.app, 'GET', `/api/chat/store/chat/${original.id}?window=1`);
  const current = await readChat(fixture, original);

  current.messages[0].text = 'Правка другого окна';
  await writeChat(fixture, current);

  const response = await fixture.app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat/window',
    payload: {
      chat: { ...view.chat, draft: 'Не записывать по старой базе' },
      window: { offset: view.window.offset, prefixHash: view.window.prefixHash },
      archived: false,
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'chat_window_changed');
  assert.deepEqual(await readChat(fixture, original), current);
});

test('PAGE-CLEAR: явная очистка окна удаляет весь prefix, stale очистка запрещена', async (t) => {
  const original = longChat();
  const fixture = await listFixture(t, [original]);
  const view = await jsonRequest(fixture.app, 'GET', `/api/chat/store/chat/${original.id}?window=1`);
  const current = await readChat(fixture, original);

  await jsonRequest(fixture.app, 'PATCH', `/api/chat/store/chat/${original.id}`, {
    patch: { title: 'Свежая версия' },
  });

  const before = await readChat(fixture, original);
  const stale = await fixture.app.inject({

    method: 'PUT',
    url: '/api/chat/store/chat/window',
    payload: {

      chat: {
        ...view.chat,
        messages: [],
        revision: current.revision
      },

      window: { offset: view.window.offset, prefixHash: view.window.prefixHash },

      clearHistory: true,
      archived: false,

    },

  });

  assert.equal(stale.statusCode, 409);
  assert.deepEqual(await readChat(fixture, original), before);

  const fresh = await jsonRequest(fixture.app, 'GET', `/api/chat/store/chat/${original.id}?window=1`);

  await jsonRequest(fixture.app, 'PUT', '/api/chat/store/chat/window', {

    chat: { ...fresh.chat, messages: [] },

    window: { offset: fresh.window.offset, prefixHash: fresh.window.prefixHash },

    clearHistory: true,
    archived: false,

  });
  assert.deepEqual((await readChat(fixture, original)).messages, []);
});

test('PAGE-SAVE-FAIL: отказ атомарной записи сохраняет файл до успешного повтора', async (t) => {
  const original = longChat();
  const fixture = await listFixture(t, [original]);
  const view = await jsonRequest(fixture.app, 'GET', `/api/chat/store/chat/${original.id}?window=1`);
  const before = await readChat(fixture, original);
  const originalWrite = ChatHistoryStore.prototype.writeAtomic;
  let broken = true;

  t.mock.method(ChatHistoryStore.prototype, 'writeAtomic', async function (file, ...rest) {
    if (broken && String(file).endsWith(`/${original.id}.json`)) {
      throw new Error('Синтетический отказ атомарной записи');
    }

    return originalWrite.call(this, file, ...rest);
  });

  const body = {
    chat: {
      ...view.chat,
      messages: [...view.chat.messages, {

      role: 'user',
      text: 'После отказа',
      turnId: 'atomic-page-turn',

    }]
    },
    window: { offset: view.window.offset, prefixHash: view.window.prefixHash },
    archived: false,
  };
  const fail = await fixture.app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat/window',
    payload: body
  });

  assert.ok(fail.statusCode >= 500);
  assert.deepEqual(await readChat(fixture, original), before);
  broken = false;
  await jsonRequest(fixture.app, 'PUT', '/api/chat/store/chat/window', body);
  await jsonRequest(fixture.app, 'PUT', '/api/chat/store/chat/window', body);

  const saved = await readChat(fixture, original);

  assert.equal(saved.messages.filter((message) => message.turnId === 'atomic-page-turn').length, 1);
  assert.deepEqual(saved.messages.slice(0, 101), before.messages);
});

test('PAGE-ACCESS: guard закрывает page/window и ошибочные DTO не меняют файл', async (t) => {
  const original = longChat();
  const token = 'pagination-cli-token';
  const fixture = await listFixture(t, [original], {
    beforeChat: async (app, { root }) => {
      await app.register(authPlugin, {
        authStore: new AuthStore({
          legacyAccountPath: path.join(root, 'auth-account.json'),
          sessionsPath: path.join(root, 'auth-sessions.json'),
        }),
        cliToken: token,
      });
    },
  });
  const prepared = await fixture.app.inject({

    method: 'GET',
    url: `/api/chat/store/chat/${original.id}?window=1`,

    headers: { 'x-grigdesk-token': token },

  });

  assert.equal(prepared.statusCode, 200);

  const before = await readChat(fixture, original);

  for (const url of [
    '/api/chat/store/list?page=1&archived=0',
    `/api/chat/store/chat/${original.id}?window=1`,
  ]) {
    const denied = await fixture.app.inject({ method: 'GET', url });

    assert.equal(denied.statusCode, 401);
  }

  const noWrite = await fixture.app.inject({

    method: 'PUT',
    url: '/api/chat/store/chat/window',
    payload: { chat: original },

  });

  assert.equal(noWrite.statusCode, 401);
  assert.deepEqual(await readChat(fixture, original), before);

  const view = await fixture.app.inject({

    method: 'GET',
    url: `/api/chat/store/chat/${original.id}?window=1`,

    headers: { 'x-grigdesk-token': token },

  });

  assert.equal(view.statusCode, 200);

  const data = view.json();
  const malformed = await fixture.app.inject({

    method: 'PUT',
    url: '/api/chat/store/chat/window',

    headers: {
      'x-grigdesk-token': token
    },
    payload: {

      chat: data.chat,
      window: { offset: -1, prefixHash: data.window.prefixHash },
      archived: false,

    },

  });

  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(await readChat(fixture, original), before);

  const conflict = await fixture.app.inject({

    method: 'PUT',
    url: '/api/chat/store/chat/window',

    headers: {
      'x-grigdesk-token': token
    },
    payload: {

      chat: data.chat,
      window: { offset: data.window.offset, prefixHash: '0'.repeat(64) },
      archived: false,

    },

  });

  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(await readChat(fixture, original), before);
});
