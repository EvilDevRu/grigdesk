import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatListPreviewCache } from '../../web/src/shared/chatListPreview.ts';
import { chatStoreFixture } from './helpers/chat-store.js';

test('80 неизменённых превью разбираются один раз, фрагменты и память ограничены', () => {
  let calls = 0;
  const cache = createChatListPreviewCache((source) => {
    calls += 1;
    assert.ok(source.length <= 1024);

    return source;
  });

  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < 80; index += 1) {
      assert.equal(cache.get(String(index), 'текст'.repeat(1000)).length, 240);
    }
  }

  assert.equal(calls, 80);
  cache.get('0', 'другой текст');
  assert.equal(calls, 81);

  for (let index = 0; index < 350; index += 1) {
    cache.get(String(index), `Текст ${index}`);
  }

  assert.equal(cache.size, 256);
  cache.remove('349');
  assert.equal(cache.size, 255);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('кэш не обещает попадания при последовательном обходе 300 чатов', () => {
  let calls = 0;
  const cache = createChatListPreviewCache((source) => {
    calls += 1;

    return source;
  });

  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < 300; index += 1) {
      cache.get(String(index), 'текст');
    }
  }

  assert.equal(calls, 600);
  assert.equal(cache.size, 256);
});

test('реальный Markdown остаётся читаемым на обрезанном источнике', () => {
  const cache = createChatListPreviewCache();

  for (const source of ['**текст**', '```js\nconst value = 1;', '[ссылка](https://example.test)',
      '# Заголовок\n\n' + 'текст '.repeat(500)
    ]) {
    const preview = cache.get('chat', source);

    assert.ok(preview.length > 0 && preview.length <= 240);
  }
});

test('поиск читает весь текст; порядок, ожидание, архив и черновик остаются актуальными', async () => {
  const chat = await chatStoreFixture({
    sessions: [{
        id: 'a',
        title: 'Первый',
        model: 'm',
        updatedAt: 2,
        messages: [{
          role: 'assistant',
          text: 'начало '.repeat(2000) + 'редкая строка'
        }]
      },
      {
        id: 'b',
        title: 'Второй',
        updatedAt: 1,
        messages: [],
        draft: '**черновик**'
      },
    ],
    archived: [{
      id: 'c',
      messages: [],
      draft: 'архив',
      closedAt: 3
    }]
  });

  assert.deepEqual(chat.list('редкая строка').map((row) => row.id), ['a']);
  assert.deepEqual(chat.list('').map((row) => row.id), ['a', 'b']);
  chat.pending = {
    question: {
      chatKey: 'b'
    }
  };
  chat.sessions[1].title = 'Новое название';
  assert.deepEqual(chat.list('').map((row) => row.id), ['b', 'a']);
  assert.equal(chat.list('')[0].title, 'Новое название');
  assert.equal(chat.list('')[0].draft, true);
  assert.deepEqual(chat.list('', true).map((row) => row.id), ['c']);
});
