import assert from 'node:assert/strict';
import test from 'node:test';

import { reactive, toRaw } from '../../web/node_modules/vue/index.mjs';
import {
  createChatPersistenceProjectionCache,
  stringifyChatStoreSnapshot,
} from '../../web/src/shared/chatPersistenceProjection.ts';
import { apiHarness, chatStoreFixture } from './helpers/chat-store.js';
import { lazyWindow } from './helpers/chat-lazy.js';
import { sampleChat } from '../server/helpers/chat-list.js';

test('сохранение незагруженного каталога не делает вложенных обходов по id', async (t) => {
  const count = 512;
  const chats = Array.from({ length: count }, (_, index) => sampleChat(`lookup-${index}`, {
    archived: index >= 12,
  }));
  const { chat, calls } = await lazyWindow(t, { chats });
  let reads = 0;

  for (const source of [...chat.sessions, ...chat.archived]) {
    const id = source.id;

    Object.defineProperty(toRaw(source), 'id', {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;

        return id;
      },
    });
  }

  const before = calls.length;

  for (let pass = 0; pass < 2; pass += 1) {
    reads = 0;
    chat._persist(true, { snapshot: false });
    await new Promise(setImmediate);
    assert.ok(reads < count * 80, `проверка ${count} голов прочитала id ${reads} раз`);
  }

  assert.equal(calls.length, before, 'неизменённые головы не требуют detail, PATCH или PUT');
});

test('поиск чата замечает замену, архив, удаление, смену id и сброс списков', async (t) => {
  const chat = await chatStoreFixture({
    sessions: [{ id: 'active', messages: [] }],
    archived: [{ id: 'archive', messages: [] }],
    activeId: 'active',
  });

  t.after(() => chat.$dispose());

  const find = chat.session;
  const first = chat.active;
  const archived = chat.archived[0];

  assert.equal(find('active'), first);
  assert.equal(chat._find('archive'), archived);
  assert.equal(chat._get('archive'), null);
  assert.equal(chat.isArchived('archive'), true);
  chat.sessions.splice(0, 1, { id: 'active', messages: [] });
  assert.notEqual(find('active'), first, 'прежняя функция поиска видит замену объекта');
  assert.equal(chat.active, chat.sessions[0]);

  const moved = chat.sessions.pop();

  chat.archived.push(moved);
  assert.equal(chat._get('active'), null);
  assert.equal(find('active'), moved);
  assert.equal(chat.active, moved);
  assert.equal(chat.isArchived('active'), true);
  chat.archived.splice(chat.archived.indexOf(moved), 1);
  assert.equal(find('active'), null);
  assert.equal(chat.active, null);
  chat.sessions = [moved];
  assert.equal(chat.isArchived('active'), false);
  assert.equal(chat.active, moved);
  moved.id = 'renamed';
  assert.equal(find('active'), null);
  assert.equal(chat._find('renamed'), moved);
  chat.activeId = 'renamed';
  assert.equal(chat.active, moved);
  chat.sessions.push({ id: 'renamed', messages: [] });
  assert.equal(find('renamed'), moved, 'при повторном id выбирается первый объект');
  chat.archived = [{ id: 'renamed', messages: [] }];
  assert.equal(find('renamed'), moved, 'активный список имеет приоритет перед архивом');
  assert.equal(chat.isArchived('archive'), false);
  chat.$reset();
  assert.equal(find('renamed'), null);
  assert.equal(chat.active, null);
  assert.equal(chat.isArchived('renamed'), false);
});

test('dirty шапки учитывает название, прочтение, закрытие и архив без полной ленты', async (t) => {
  const { chat, calls } = await lazyWindow(t);
  const live = chat.sessions[0];
  const before = calls.length;

  assert.equal(chat.isChatMessagesLoaded(live.id), false);
  assert.equal(chat._dirty(live), false);

  for (const [field, value] of [['title', 'Имя "с кавычками"\n'], ['unread', true], ['closedAt', 7]]) {
    const previous = live[field];

    live[field] = value;
    assert.equal(chat._dirty(live), true, field);
    live[field] = previous;
    assert.equal(chat._dirty(live), false, `${field}: возврат к подтверждённой голове`);
  }

  live.sending = true;
  assert.equal(chat._dirty(live), false, 'runtime не требует PATCH');
  chat.sessions.splice(chat.sessions.indexOf(live), 1);
  chat.archived.push(live);
  assert.equal(chat._dirty(live), true, 'принадлежность определяется списком');
  chat.archived.pop();
  chat.sessions.push(live);
  assert.equal(chat._dirty(live), false);
  assert.equal(calls.length, before, 'проверка метаданных не загружает историю');
});

/**
 * Счётчики фиксируют повторный обход JSON, а Vue остаётся настоящим владельцем зависимостей.
 * Форма проекций сохраняет сообщения и метаданные, исключая только тела исторических шагов.
 */
function projectionFixture() {
  const calls = { fingerprint: 0, snapshot: 0 };
  const cache = createChatPersistenceProjectionCache({
    active: (chat) => ({ ...chat }),
    archived: (chat) => ({ ...chat, archived: true }),
    fingerprint: (chat) => {
      calls.fingerprint += 1;

      const messages = chat.messages.map(({ steps, ...message }) => ({
        ...message,
        stepCount: steps?.length || 0,
      }));

      return JSON.stringify({ ...chat, messages });
    },
    snapshot: (chat) => {
      calls.snapshot += 1;

      return {
        ...chat,
        messages: chat.messages.map(({ steps, ...message }) => message),
      };
    },
  });

  return { cache, calls };
}

test('повторное сохранение обходит только изменённый чат и замечает вложенные поля', () => {
  const { cache, calls } = projectionFixture();
  const chats = reactive(Array.from({ length: 80 }, (_, index) => ({
    id: String(index),
    draft: '',
    messages: [{
      text: 'Ответ',
      receipt: { revision: 1 },
      steps: [],
    }],
  })));

  for (let pass = 0; pass < 2; pass += 1) {
    for (const chat of chats) {
      const projection = cache.get(chat);

      assert.ok(projection.fingerprint.value);
      assert.equal(JSON.parse(projection.snapshot.value).messages[0].text, 'Ответ');
    }
  }

  assert.deepEqual(calls, { fingerprint: 80, snapshot: 80 });

  const target = chats[17];
  const changes = [
    () => {
      target.draft = 'Черновик';
    },
    () => {
      target.messages[0].receipt.revision = 2;
    },
    () => {
      target.messages[0].text = 'Обновлённый ответ';
    },
    () => {
      target.messages[0].attachments = [{ name: 'Файл' }];
    },
    () => {
      target.messages[0].attachments[0].name = 'Другой файл';
    },
    () => {
      delete target.messages[0].receipt;
    },
  ];
  let previous = cache.get(target).fingerprint.value;

  for (const change of changes) {
    change();

    const current = cache.get(target);

    assert.notEqual(current.fingerprint.value, previous);
    assert.equal(JSON.parse(current.snapshot.value).draft, 'Черновик');
    previous = current.fingerprint.value;

    for (const chat of chats) {
      cache.get(chat).fingerprint.value;
      cache.get(chat).snapshot.value;
    }
  }

  assert.deepEqual(calls, { fingerprint: 86, snapshot: 86 });
  assert.equal(cache.size, 80);
});

test('страховочная проекция не читает тела steps, но длина влияет на отпечаток', () => {
  const { cache } = projectionFixture();
  const step = {};

  Object.defineProperty(step, 'text', {
    enumerable: true,
    get() {
      throw new Error('Историческое тело прочитано');
    },
  });

  const chat = reactive({ id: 'steps', messages: [{ text: 'Ответ', steps: [step] }] });
  const projection = cache.get(chat);
  const previous = projection.fingerprint.value;

  assert.equal(JSON.parse(projection.snapshot.value).messages[0].steps, undefined);
  chat.messages[0].steps.push(step);
  assert.notEqual(projection.fingerprint.value, previous);
});

test('владельцы, архив и удаление ограничивают кэш текущими реактивными чатами', () => {
  const { cache } = projectionFixture();
  const raw = {
    id: 'same',
    messages: [],
    draft: '',
  };
  const firstRaw = cache.get(raw).snapshot.value;

  raw.draft = 'Правка вне Vue';
  assert.notEqual(cache.get(raw).snapshot.value, firstRaw);
  assert.equal(cache.size, 0);

  const first = reactive(raw);
  const replacement = reactive({ ...raw, draft: 'Замена объекта' });

  assert.equal(cache.get(first), cache.get(first));
  assert.equal(JSON.parse(cache.get(replacement).snapshot.value).draft, 'Замена объекта');
  assert.equal(JSON.parse(cache.get(replacement, true).snapshot.value).archived, true);
  assert.equal(cache.size, 1);

  cache.get(reactive({ id: 'gone', messages: [] }));
  cache.prune([replacement]);
  assert.equal(cache.size, 1);
  cache.remove('same');
  assert.equal(cache.size, 0);
  cache.get(replacement);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('сборка JSON сохраняет форму снимка и обновляет метаданные окна', () => {
  const sessions = [{ id: 'active', messages: [{ text: 'Строка\n"кавычки"' }] }];
  const archived = [{
    id: 'archive',
    closedAt: 9,
    messages: [],
  }];
  const payload = {
    sessions,
    archived,
    activeId: 'active',
    defWorkdir: { kind: 'grigdesk' },
  };
  const serialize = () => stringifyChatStoreSnapshot(
    payload,
    sessions.map((chat) => JSON.stringify(chat)),
    archived.map((chat) => JSON.stringify(chat)),
  );

  assert.deepEqual(JSON.parse(serialize()), payload);
  payload.activeId = 'archive';
  assert.deepEqual(JSON.parse(serialize()), payload);
  assert.deepEqual(JSON.parse(stringifyChatStoreSnapshot({}, [], [])), { sessions: [], archived: [] });
});

test('прогретый стор сохраняет вложенные правки и дополненные поля сообщения', async () => {
  const saved = new Map();
  const previousStorage = globalThis.localStorage;

  globalThis.localStorage = { setItem: (key, value) => saved.set(key, value) };

  const chat = await chatStoreFixture({
    sessions: [{
      id: 'nested',
      title: 'Тест',
      messages: [{
        text: 'Ответ',
        receipt: { revision: 1 },
        attachments: [{ name: 'Первый' }],
      }],
    }],
  });
  const sent = [];

  apiHarness.put = async (url, body) => {
    if (body.chat) {
      sent.push(JSON.parse(JSON.stringify(body.chat)));
    }

    return {};
  };

  try {
    chat._persist(true);
    assert.equal(sent.length, 0);

    const message = chat.sessions[0].messages[0];
    const changes = [
      () => {
        message.receipt.revision = 2;
      },
      () => {
        message.attachments[0].name = 'Второй';
      },
      () => {
        message.newField = { complete: true };
      },
      () => {
        delete message.receipt;
      },
      () => {
        message.text = 'Новый текст';
      },
    ];

    for (const [index, change] of changes.entries()) {
      change();
      chat._persist(true);
      await new Promise(setImmediate);

      const snapshot = JSON.parse(saved.get('grigdesk-chat-snapshot'));
      const expected = JSON.parse(JSON.stringify(message));

      assert.equal(sent.length, index + 1, 'каждая вложенная правка отправляется');
      assert.deepEqual(sent.at(-1).messages[0], expected);
      assert.deepEqual(snapshot.sessions[0].messages[0], expected);
    }
  } finally {
    chat.$dispose();
    globalThis.localStorage = previousStorage;
  }
});

test('обычный PUT следует за страховкой в новой задаче, flush остаётся немедленным', async () => {
  const previousStorage = globalThis.localStorage;

  try {
    for (const flush of [false, true]) {
      const order = [];
      const chat = await chatStoreFixture({
        sessions: [{ id: 'ordering', messages: [{ text: 'Ответ' }] }],
      });

      globalThis.localStorage = {
        setItem: () => {
          order.push('snapshot');
          setTimeout(() => order.push('next-task'), 0);
        },
      };
      apiHarness.put = async (_url, body) => {
        if (body.chat) {
          order.push('put');
        }

        return {};
      };
      chat.sessions[0].messages[0].text = 'Новый ответ';
      chat._persist(flush);

      if (flush) {
        assert.deepEqual(order, ['snapshot', 'put']);
      } else {
        assert.deepEqual(order, []);
      }

      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.deepEqual(order, flush ? ['snapshot', 'put', 'next-task'] : ['snapshot', 'next-task', 'put']);
      chat.$dispose();
    }
  } finally {
    globalThis.localStorage = previousStorage;
  }
});
