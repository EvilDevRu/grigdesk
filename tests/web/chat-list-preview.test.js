import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatListPreviewCache } from '../../web/src/shared/chatListPreview.ts';
import { apiHarness, chatStoreFixture } from './helpers/chat-store.js';

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

test('текущий каталог больше 256 чатов не вытесняет собственные превью по кругу', () => {
  let calls = 0;
  const cache = createChatListPreviewCache((source) => {
    calls += 1;

    return source;
  });
  const ids = Array.from({ length: 310 }, (_, index) => String(index));

  cache.retain(ids);

  for (let pass = 0; pass < 2; pass += 1) {
    for (const id of ids) {
      cache.get(id, 'текст');
    }
  }

  assert.equal(calls, 310);
  assert.equal(cache.size, 310);
  cache.get('0', 'правка');
  assert.equal(calls, 311);
  cache.retain(['0', '1']);
  assert.equal(cache.size, 2, 'смена списка освобождает прежний каталог');
  cache.clear();

  for (const id of ids) {
    cache.get(id, 'текст');
  }

  assert.equal(cache.size, 256, 'без владельца остаётся прежний предел LRU');
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

test('серверный поиск по всему тексту; порядок, ожидание, архив и черновик актуальны', async (t) => {
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

  t.after(() => chat.$dispose());
  apiHarness.get = async (url) => {
    assert.equal(url, '/api/chat/store/search?q=' + encodeURIComponent('редкая строка') + '&archived=0');

    return { matches: [{ id: 'a', snippetSource: '…начало начало начало редкая строка' }] };
  };
  // Старый стор уже имеет текст для поиска, новый получает управляемый серверный ответ.
  await chat.searchChats?.('редкая строка');
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
