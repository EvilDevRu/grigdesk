import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';

test('chat history moves from active to archive before permanent removal', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-chat-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const store = new ChatHistoryStore({ chatsDir: path.join(root, 'chats') });
  const chat = {
    id: 'chat-1',
    title: 'Важный разговор',
    messages: [{ role: 'user', text: 'Не потеряй меня' }],
    draft: 'черновик',
    unread: true,
    createdAt: Date.UTC(2026, 6, 29),
    updatedAt: Date.UTC(2026, 6, 29, 1),
  };

  await store.saveOne(chat, false);
  let state = await store.read();
  assert.deepEqual(state.sessions.map((item) => item.id), ['chat-1']);
  assert.equal(state.archived.length, 0);

  await store.saveOne({ ...chat, closedAt: Date.UTC(2026, 6, 29, 2) }, true);
  state = await store.read();
  assert.equal(state.sessions.length, 0);
  assert.deepEqual(state.archived.map((item) => item.id), ['chat-1']);
  assert.equal(state.archived[0].draft, 'черновик');
  assert.equal(state.archived[0].unread, true);

  await store.saveOne(chat, false);
  state = await store.read();
  assert.deepEqual(state.sessions.map((item) => item.id), ['chat-1']);
  assert.equal(state.archived.length, 0);
  assert.equal(state.sessions[0].draft, 'черновик');
  assert.equal(state.sessions[0].unread, true);

  await store.saveOne({ ...chat, closedAt: Date.UTC(2026, 6, 29, 3) }, true);
  assert.equal(await store.remove('chat-1'), true);
  state = await store.read();
  assert.equal(state.sessions.length, 0);
  assert.equal(state.archived.length, 0);
});

// Точечное чтение — то, чем окна досинхронизируются по SSE `chat-store`: тянут ровно
// изменившийся чат, а не всю историю.
test('readOne отдаёт один чат и молчит про несуществующий', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-chat-readone-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const store = new ChatHistoryStore({ chatsDir: path.join(root, 'chats') });
  const chat = {
    id: 'chat-2',
    title: 'Начат на планшете',
    messages: [{
      role: 'user', text: 'Привет с планшета', sentAt: Date.UTC(2026, 6, 30, 9, 15),
    }],
    createdAt: Date.UTC(2026, 6, 30),
    updatedAt: Date.UTC(2026, 6, 30),
  };

  assert.equal(await store.readOne('chat-2'), null);
  await store.saveOne(chat, false);

  const found = await store.readOne('chat-2');
  assert.equal(found.title, 'Начат на планшете');
  assert.equal(found.archived, false);
  assert.deepEqual(found.messages, chat.messages);

  await store.saveOne({ ...chat, closedAt: Date.UTC(2026, 6, 30, 1) }, true);
  assert.equal((await store.readOne('chat-2')).archived, true, 'архивность едет вместе с чатом');

  assert.equal(await store.readOne('chat-404'), null);
  assert.equal(await store.readOne(''), null);
});

test('peek читает один чат по id, не поднимая всю историю с диска', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-chat-peek-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ChatHistoryStore({ chatsDir: path.join(root, 'chats') });

  // Месяц в пути задаёт createdAt, поэтому чаты лежат в разных каталогах.
  await store.saveOne({
    id: 'chat-old', title: 'Прошлый месяц', messages: [],
    createdAt: Date.UTC(2026, 5, 1), updatedAt: Date.UTC(2026, 5, 1),
  }, false);
  await store.saveOne({
    id: 'chat-new', title: 'Экспорт CSV', taskId: '4187', messages: [],
    createdAt: Date.UTC(2026, 7, 19), updatedAt: Date.UTC(2026, 7, 19),
  }, false);

  const found = await store.peek('chat-new');
  assert.equal(found.title, 'Экспорт CSV');
  assert.equal(found.taskId, '4187');
  assert.equal((await store.peek('chat-old')).title, 'Прошлый месяц', 'старые месяцы тоже находятся');
  assert.equal(await store.peek('chat-missing'), null);
  assert.equal(await store.peek(''), null);

  // id приходит из чужого канала (chatKey висящего спроса) — в путь его клеить нельзя.
  assert.equal(await store.peek('../../../etc/passwd'), null);
  assert.equal(await store.peek('chat/../../secret'), null);
});

test('точечные операции после миграции не читают файлы остальных чатов', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-chat-targeted-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ChatHistoryStore({ chatsDir: path.join(root, 'chats') });
  const saved = await store.saveOne({
    id: 'target',
    messages: [{ role: 'user', text: 'Сохрани этот разговор' }],
    createdAt: Date.UTC(2026, 5, 1),
  });
  await store.saveOne({
    id: 'unrelated',
    messages: [{ role: 'assistant', text: 'Другая история'.repeat(1000) }],
    createdAt: Date.UTC(2026, 7, 1),
  });

  const readFile = t.mock.method(fs, 'readFile');
  const current = await store.readOne('target');
  assert.deepEqual(current.messages, saved.chat.messages);
  const archived = await store.saveOne({ ...current, draft: 'Новый черновик' }, true);
  assert.equal(archived.chat.archived, true);
  assert.equal((await store.readOne('target')).draft, 'Новый черновик');
  assert.equal(await store.remove('target'), true);
  assert.equal(await store.peek('target'), null);

  const readNames = readFile.mock.calls.map((call) => path.basename(String(call.arguments[0])));
  assert.ok(readNames.length > 0);
  assert.deepEqual([...new Set(readNames)], ['target.json']);
});

test('точечная запись перечитывает свежую серверную копию в старом месяце', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-chat-fresh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ChatHistoryStore({ chatsDir: path.join(root, 'chats') });
  const first = await store.saveOne({
    id: 'target',
    messages: [{ role: 'user', text: 'Вопрос' }],
    createdAt: Date.UTC(2026, 5, 1),
    updatedAt: Date.UTC(2026, 5, 1),
  });
  const fresh = {
    ...first.chat,
    revision: first.chat.revision + 1,
    messages: [...first.chat.messages, { role: 'assistant', text: 'Ответ из другого окна' }],
    updatedAt: Date.UTC(2026, 5, 2),
  };
  await fs.writeFile(store.fileOf(fresh), JSON.stringify(fresh));
  const newerMonth = path.join(store.dir, '2026-08');
  await fs.mkdir(newerMonth);
  await fs.writeFile(path.join(newerMonth, 'target.json'), JSON.stringify({ id: 'different' }));

  const merged = await store.saveOne({ ...first.chat, draft: 'Черновик' });
  assert.equal(merged.stale, true);
  assert.equal(merged.restored, 1);
  assert.deepEqual((await store.readOne('target')).messages, fresh.messages);

  await fs.writeFile(path.join(newerMonth, 'target.json'), '{');
  assert.deepEqual((await store.readOne('target')).messages, fresh.messages);
  assert.equal(await store.readOne('../../outside'), null);
});

// Список чатов телефона перечитывается по каждому событию: полная история весит сотни
// мегабайт, поэтому шапки берутся из кэша и файл читается заново только после изменения.
test('heads отдаёт шапки без сообщений и перечитывает только изменённые файлы', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-chat-heads-'));

  t.after(() => fs.rm(root, {
    recursive: true,
    force: true,
  }));

  const store = new ChatHistoryStore({ chatsDir: path.join(root, 'chats') });
  const created = Date.UTC(2026, 9, 9);

  await store.saveOne({
    id: 'chat-live',
    title: 'Живой',
    model: 'test-model',
    modelRef: { provider: 'test', model: 'test-model' },
    taskId: '42',
    messages: [{ role: 'user', text: 'x'.repeat(4096) }],
    createdAt: created,
    updatedAt: created + 1,
  }, false);
  await store.saveOne({
    id: 'chat-old',
    title: 'Старый',
    messages: [{ role: 'user', text: 'архив' }],
    createdAt: created - 1,
    updatedAt: created,
  }, true);

  const companion = (await store.ensureByPurpose({ purpose: 'companion' })).chat;

  const readFile = fs.readFile;
  const reads = [];

  fs.readFile = async (file, ...rest) => {
    reads.push(path.basename(String(file)));

    return readFile.call(fs, file, ...rest);
  };
  t.after(() => {
    fs.readFile = readFile;
  });

  const first = await store.heads();

  assert.deepEqual(first.map((head) => head.id), ['chat-old', 'chat-live', companion.id]);
  assert.equal(first.every((head) => !('messages' in head)), true);
  assert.equal(first[0].archived, true);
  assert.equal(first[0].preview, 'Ты: архив');
  assert.equal(first[1].preview.length, 300);
  assert.equal(first[2].purpose, 'companion');
  assert.equal(first[2].logicalIdentity, companion.logicalIdentity);
  assert.deepEqual(
    {
      title: first[1].title,
      model: first[1].model,
      modelRef: first[1].modelRef,
      taskId: first[1].taskId,
      updatedAt: first[1].updatedAt,
    },
    {
      title: 'Живой',
      model: 'test-model',
      modelRef: { provider: 'test', model: 'test-model' },
      taskId: '42',
      updatedAt: created + 1,
    },
  );

  reads.length = 0;
  await store.heads();
  assert.deepEqual(reads.filter((name) => name.startsWith('chat-')), []);

  const live = await store.readOne('chat-live');

  await store.saveOne({
    ...live,
    title: 'Переименован',
    updatedAt: created + 5,
  }, false);
  reads.length = 0;

  const renamed = await store.heads();

  assert.deepEqual(reads.filter((name) => name.startsWith('chat-')), ['chat-live.json']);
  assert.equal(renamed.find((head) => head.id === 'chat-live').title, 'Переименован');

  assert.equal(await store.remove('chat-old'), true);
  assert.deepEqual((await store.heads()).map((head) => head.id), ['chat-live', companion.id]);
});
