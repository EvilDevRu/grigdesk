// Архив сообщений: append-only NDJSON помесячно на чат + индекс по смещениям.
//
// Три обещания, каждое из раздела 3.1 плана, и каждое — про то, чтобы горячая
// операция не зависела от размера архива:
//  • приём сообщения ДОПИСЫВАЕТ строку и никогда не переписывает файл месяца;
//  • правка приходит новой строкой, при чтении побеждает последняя версия;
//  • сообщение достаётся по (чат, id) чтением по смещению, а не разбором месяца.
// Плюс живучесть: одна битая строка не должна уносить с собой весь архив.
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TelegramArchiveStore, archiveMonth } from '../../server/src/lib/telegram/archiveStore.ts';

const CHAT = -1001000000042;
const AUG = Date.UTC(2026, 7, 7, 10, 0, 0) / 1000; // секунды, как date у Bot API
const SEP = Date.UTC(2026, 8, 1, 10, 0, 0) / 1000;

/** Лог-заглушка: warn'ы копим — часть из них проверяется как контракт. */
function logStub() {
  const warns = [];
  return { warns, info() {}, warn(a, b) { warns.push(typeof a === 'string' ? a : b || ''); }, error() {} };
}

const msg = (over = {}) => ({
  chatId: CHAT,
  chatTitle: 'Команда Альфа · разработка',
  chatType: 'supergroup',
  isForum: true,
  messageId: 100,
  threadId: null,
  replyToMessageId: null,
  date: AUG,
  editedAt: null,
  from: { id: 7, name: 'Аня', username: 'anya' },
  text: 'кнопка не нажимается',
  media: [],
  ...over,
});

async function store(t, opts = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-archive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = logStub();
  return { dir, log, s: new TelegramArchiveStore({ dir, log, ...opts }) };
}

const fileOf = (dir, chatId, month) => path.join(dir, 'archive', String(chatId), `${month}.ndjson`);

test('месяц берётся из даты сообщения по UTC — файл на чат и месяц', () => {
  assert.equal(archiveMonth(AUG), '2026-08');
  assert.equal(archiveMonth(SEP), '2026-09');
});

test('приём дописывает строку и не переписывает уже записанное', async (t) => {
  const { dir, s } = await store(t);
  const first = await s.append(msg({ messageId: 1, text: 'первое' }));
  const sizeAfterFirst = (await stat(first.file)).size;

  const second = await s.append(msg({ messageId: 2, text: 'второе' }));
  assert.equal(second.file, first.file, 'один месяц — один файл');
  // Вот она, append-only: вторая запись начинается ровно там, где кончился файл.
  assert.equal(second.offset, sizeAfterFirst);
  assert.equal(first.offset, 0);

  const raw = await readFile(first.file, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).text, 'первое', 'первая строка не тронута');
  assert.equal(JSON.parse(lines[1]).text, 'второе');
});

test('разные месяцы — разные файлы, чат один', async (t) => {
  const { dir, s } = await store(t);
  await s.append(msg({ messageId: 1, date: AUG }));
  const sep = await s.append(msg({ messageId: 2, date: SEP }));
  assert.equal(sep.file, fileOf(dir, CHAT, '2026-09'));
  assert.equal(sep.offset, 0, 'новый месяц начинается с нуля');
  assert.equal((await s.read(CHAT, 1)).date, AUG, 'прошлый месяц читается по-прежнему');
});

test('правка дописывается строкой, а при чтении побеждает последняя версия', async (t) => {
  const { s } = await store(t);
  const first = await s.append(msg({ messageId: 5, text: 'кнопка не нажмается' }));
  await s.append(msg({ messageId: 5, text: 'кнопка не нажимается', editedAt: AUG + 60 }));

  const raw = await readFile(first.file, 'utf8');
  assert.equal(raw.split('\n').filter(Boolean).length, 2, 'обе версии на диске');

  const got = await s.read(CHAT, 5);
  assert.equal(got.text, 'кнопка не нажимается');
  assert.equal(got.editedAt, AUG + 60);

  const tail = await s.tail(CHAT, { limit: 10 });
  assert.equal(tail.length, 1, 'в ленте сообщение одно, а не две версии');
  assert.equal(tail[0].text, 'кнопка не нажимается');
});

test('индекс находит сообщение по (чат, id) чтением по смещению, а не разбором месяца', async (t) => {
  const { dir, s } = await store(t);
  for (let i = 1; i <= 200; i += 1) await s.append(msg({ messageId: i, text: `строка ${i}` }));

  // Холодный старт: новое хранилище над тем же каталогом — индекс поднимается сам.
  const { s: cold } = { s: new TelegramArchiveStore({ dir, log: logStub() }) };
  const at = await cold.locate(CHAT, 137);
  assert.ok(at, 'сообщение найдено индексом');

  // Читаем ровно кусок файла по (offset, length) — это и есть обещание раздела 3.1.
  const raw = await readFile(at.file);
  const slice = raw.subarray(at.offset, at.offset + at.length).toString('utf8');
  assert.equal(JSON.parse(slice).text, 'строка 137');
  assert.equal((await cold.read(CHAT, 137)).text, 'строка 137');
  assert.equal(await cold.read(CHAT, 999), null, 'чего нет — то null, а не выдумка');
});

test('битая строка пропускается с warn и не уносит остальные', async (t) => {
  const { dir, s, log } = await store(t);
  await s.append(msg({ messageId: 1, text: 'до' }));
  const file = fileOf(dir, CHAT, '2026-08');
  await appendFile(file, '{ это не json\n', 'utf8');
  await s.append(msg({ messageId: 3, text: 'после' }));

  const cold = new TelegramArchiveStore({ dir, log });
  const tail = await cold.tail(CHAT, { limit: 10 });
  assert.deepEqual(tail.map((m) => m.text), ['до', 'после']);
  assert.equal((await cold.read(CHAT, 3)).text, 'после');
  assert.ok(log.warns.length >= 1, 'про битую строку сказано в лог, а не молча');
});

test('лента отдаёт хвост по возрастанию времени и не длиннее лимита', async (t) => {
  const { s } = await store(t);
  for (let i = 1; i <= 30; i += 1) await s.append(msg({ messageId: i, date: AUG + i, text: `#${i}` }));
  const tail = await s.tail(CHAT, { limit: 5 });
  assert.deepEqual(tail.map((m) => m.text), ['#26', '#27', '#28', '#29', '#30']);
});

test('карта чатов: заголовок, счётчик и время последнего — для привязки к проектам', async (t) => {
  const { dir, s } = await store(t);
  await s.append(msg({ messageId: 1, date: AUG }));
  await s.append(msg({ messageId: 2, date: AUG + 100, chatTitle: 'Команда Альфа · разработка (переименован)' }));
  await s.flush();

  const cold = new TelegramArchiveStore({ dir, log: logStub() });
  const chats = await cold.chats();
  assert.equal(chats.length, 1);
  assert.equal(chats[0].id, CHAT);
  assert.equal(chats[0].title, 'Команда Альфа · разработка (переименован)', 'заголовок берётся свежий');
  assert.equal(chats[0].isForum, true);
  assert.equal(chats[0].messages, 2);
  assert.equal(chats[0].lastAt, AUG + 100);
});

test('темы чата собираются из threadId, а последнее событие хранит понятное название', async (t) => {
  const { dir, s } = await store(t);
  await s.append(msg({
    messageId: 40, date: AUG, threadId: 42, text: '', service: 'forum_topic_created',
    threadTitle: 'Баги', threadTitleSource: 'event',
  }));
  await s.append(msg({
    messageId: 41, date: AUG + 10, threadId: 42,
    threadTitle: 'Баги', threadTitleSource: 'root',
  }));
  await s.append(msg({
    messageId: 43, date: AUG + 20, threadId: 42, text: '', service: 'forum_topic_edited',
    threadTitle: 'Ошибки', threadTitleSource: 'event',
  }));
  // Более позднее обычное сообщение всё ещё может цитировать старый корень темы;
  // оно не должно откатывать название после явного события переименования.
  await s.append(msg({
    messageId: 44, date: AUG + 30, threadId: 42,
    threadTitle: 'Баги', threadTitleSource: 'root',
  }));
  await s.append(msg({ messageId: 77, date: AUG + 40, threadId: 77, text: 'без известного названия' }));

  const cold = new TelegramArchiveStore({ dir, log: logStub() });
  const topics = await cold.topics(CHAT);
  assert.deepEqual(topics, [
    { id: 77, title: '', messages: 1, lastAt: AUG + 40 },
    { id: 42, title: 'Ошибки', messages: 2, lastAt: AUG + 30 },
  ]);
});

test('служебное сообщение хранится помеченным и в ленту обсуждения не лезет', async (t) => {
  const { s } = await store(t);
  await s.append(msg({ messageId: 1, text: '', service: 'new_chat_members' }));
  await s.append(msg({ messageId: 2, text: 'первая жалоба' }));

  assert.equal((await s.read(CHAT, 1)).service, 'new_chat_members', 'запись есть — по ней видно, когда бота позвали');
  const tail = await s.tail(CHAT, { limit: 10 });
  assert.deepEqual(tail.map((m) => m.messageId), [2], 'служебное в ленте не показываем');
  const withService = await s.tail(CHAT, { limit: 10, service: true });
  assert.deepEqual(withService.map((m) => m.messageId), [1, 2]);
});

test('чужой каталог не создаётся раньше времени: без сообщений архива нет', async (t) => {
  const { dir, s } = await store(t);
  assert.deepEqual(await s.chats(), []);
  assert.equal(await s.read(CHAT, 1), null);
  assert.deepEqual(await s.tail(CHAT, { limit: 5 }), []);
  await assert.rejects(() => stat(path.join(dir, 'archive', String(CHAT))), 'пустой чат каталога не заводит');
});
