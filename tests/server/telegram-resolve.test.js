// Резолв ссылки: три источника по порядку (раздел 5 плана).
//
//   1. архив     — единственный, кто отдаёт ветку целиком, а не одно сообщение;
//   2. пересылка — `forwardMessage` в служебный чат, копия сразу удаляется;
//   3. отказ     — с причиной из закрытого набора и текстом для человека.
//
// Сети в тесте нет: Bot API подменён заглушкой, и она же протоколирует вызовы —
// половина проверок здесь именно про то, что лишнего вызова НЕ было.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TelegramArchiveStore } from '../../server/src/lib/telegram/archive-store.js';
import { parseTelegramLinks } from '../../server/src/lib/telegram/links.js';
import { normalizeRules } from '../../server/src/lib/telegram/rules-store.js';
import { messageOfForward, resolveLink, resolveText } from '../../server/src/lib/telegram/resolve.js';

const BUGS = -1001234567890; // приватная группа, привязана к проекту alpha
const SERVICE = 555000111; // служебный чат, куда бот пересылает сам себе
const T0 = Date.UTC(2026, 7, 1, 9, 0, 0) / 1000;

const rules = (...list) => normalizeRules(list);
const linkOf = (text) => {
  const links = parseTelegramLinks(text);
  assert.equal(links.length, 1, `ожидалась одна ссылка в «${text}»`);
  return links[0];
};

const msg = (over = {}) => ({
  chatId: BUGS,
  chatUsername: '',
  chatTitle: 'Кокпит · баги',
  chatType: 'supergroup',
  isForum: false,
  messageId: 100,
  threadId: null,
  replyToMessageId: null,
  date: T0,
  editedAt: null,
  from: { id: 7, name: 'Аня', username: 'anya' },
  text: 'кнопка «сохранить» не жмётся',
  media: [],
  ...over,
});

const logStub = () => ({ info() {}, warn() {}, error() {}, debug() {} });

async function archiveWith(t, messages = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-resolve-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TelegramArchiveStore({ dir, log: logStub() });
  for (const m of messages) await store.append(m);
  return store;
}

/** Bot API-заглушка: значение либо функция на метод, плюс протокол вызовов. */
function botApi(handlers = {}) {
  const calls = [];
  const call = async (method, body) => {
    calls.push({ method, body });
    const h = handlers[method];
    if (h === undefined) throw new Error(`в тесте не задан ответ на ${method}`);
    if (h instanceof Error) throw h;
    return typeof h === 'function' ? h(body) : h;
  };
  return { calls, call, methods: () => calls.map((c) => c.method) };
}

/** Отказ Телеграма в том виде, в каком его выбрасывает lib/telegram/api.js. */
const tgError = (description) => Object.assign(new Error(description), { kind: 'telegram', status: 400 });

/** Копия, которую возвращает forwardMessage: она лежит в СЛУЖЕБНОМ чате. */
const forwardCopy = (over = {}) => ({
  message_id: 9001,
  chat: { id: SERVICE, type: 'private' },
  date: T0 + 86400,
  forward_origin: { type: 'user', sender_user: { id: 7, first_name: 'Аня', username: 'anya' }, date: T0 },
  text: 'кнопка «сохранить» не жмётся',
  ...over,
});

const deps = (over = {}) => ({
  rules: rules({ project: 'alpha', chatId: BUGS }),
  project: 'alpha',
  serviceChatId: SERVICE,
  ...over,
});

test('нашлось в архиве — отдаётся ветка, в сеть не ходим вовсе', async (t) => {
  const archive = await archiveWith(t, [
    msg({ messageId: 1, text: 'первое' }),
    msg({ messageId: 2, date: T0 + 60, text: 'второе' }),
    msg({ messageId: 3, date: T0 + 120, text: 'третье' }),
    msg({ messageId: 4, date: T0 + 180, text: 'кнопка не жмётся' }),
    msg({ messageId: 5, date: T0 + 240, text: 'у меня тоже' }),
    msg({ messageId: 6, date: T0 + 300, text: 'починили' }),
  ]);
  const api = botApi();

  const res = await resolveLink(linkOf('https://t.me/c/1234567890/4'), deps({
    archive, call: api.call, window: { before: 2, after: 2 },
  }));

  assert.equal(res.ok, true);
  assert.equal(res.source, 'archive');
  assert.equal(res.target.messageId, 4);
  // Окно вокруг цитируемого — это и есть «ветка целиком», а не одно сообщение.
  assert.deepEqual(res.messages.map((m) => m.messageId), [2, 3, 4, 5, 6]);
  assert.equal(res.chat.id, BUGS);
  assert.equal(res.chat.title, 'Кокпит · баги');
  assert.equal(res.rule.project, 'alpha');
  // Ни одного обращения к Телеграму: архив на то и первый источник.
  assert.deepEqual(api.methods(), []);
});

test('родитель по reply попадает в ветку, даже если окно до него не достаёт', async (t) => {
  const archive = await archiveWith(t, [
    msg({ messageId: 1, text: 'исходная жалоба' }),
    msg({ messageId: 2, date: T0 + 60 }),
    msg({ messageId: 3, date: T0 + 120 }),
    msg({ messageId: 4, date: T0 + 180 }),
    msg({ messageId: 5, date: T0 + 240, text: 'вот ошибка', replyToMessageId: 1 }),
  ]);

  const res = await resolveLink(linkOf('https://t.me/c/1234567890/5'), deps({
    archive, call: botApi().call, window: { before: 1, after: 0 },
  }));

  assert.equal(res.ok, true);
  // Окно дало бы только 4 и 5; без первого сообщения ответ повисает в воздухе.
  assert.deepEqual(res.messages.map((m) => m.messageId), [1, 4, 5]);
});

test('ветка не вылезает за свою тему форума', async (t) => {
  const archive = await archiveWith(t, [
    msg({ messageId: 10, threadId: 7, text: 'в теме про баги' }),
    msg({ messageId: 11, date: T0 + 60, threadId: 9, text: 'в соседней теме' }),
    msg({ messageId: 12, date: T0 + 120, threadId: 7, text: 'тут не жмётся' }),
  ]);

  const res = await resolveLink(linkOf('https://t.me/c/1234567890/7/12'), deps({
    archive, call: botApi().call, window: { before: 5, after: 5 },
  }));

  assert.equal(res.ok, true);
  assert.deepEqual(res.messages.map((m) => m.messageId), [10, 12]);
  assert.equal(res.thread, 7);
});

test('в архиве нет — пересылаем себе, а копию за собой убираем', async (t) => {
  const archive = await archiveWith(t, []);
  const api = botApi({ forwardMessage: forwardCopy(), deleteMessage: true });

  const res = await resolveLink(linkOf('https://t.me/c/1234567890/42'), deps({ archive, call: api.call }));

  assert.equal(res.ok, true);
  assert.equal(res.source, 'forward');
  assert.equal(res.target.text, 'кнопка «сохранить» не жмётся');
  // Дата берётся у оригинала, а не у копии: копия сделана сегодня, а спрашивали про август.
  assert.equal(res.target.date, T0);
  assert.equal(res.target.chatId, BUGS);
  assert.equal(res.target.messageId, 42);

  assert.deepEqual(api.methods(), ['forwardMessage', 'deleteMessage']);
  assert.equal(api.calls[0].body.from_chat_id, BUGS);
  assert.equal(api.calls[0].body.chat_id, SERVICE);
  assert.equal(api.calls[0].body.message_id, 42);
  // Копия удаляется ИМЕННО из служебного чата и именно та, что мы сделали.
  assert.deepEqual(api.calls[1].body, { chat_id: SERVICE, message_id: 9001 });
});

test('пересланное ложится в архив, поэтому второй разворот уже без сети', async (t) => {
  const archive = await archiveWith(t, []);
  const api = botApi({ forwardMessage: forwardCopy(), deleteMessage: true });
  const link = linkOf('https://t.me/c/1234567890/42');

  await resolveLink(link, deps({ archive, call: api.call }));
  const again = await resolveLink(link, deps({ archive, call: api.call }));

  assert.equal(again.ok, true);
  assert.equal(again.source, 'archive');
  // Кэш «навсегда» — это и есть архив: второго хранилища с своими правилами нет.
  assert.deepEqual(api.methods(), ['forwardMessage', 'deleteMessage']);
});

test('бот не в чате и запрет пересылки — разные причины, а не общая пустота', async (t) => {
  const notMember = await resolveLink(linkOf('https://t.me/c/1234567890/42'), deps({
    archive: await archiveWith(t, []),
    call: botApi({ forwardMessage: tgError('Bad Request: chat not found') }).call,
  }));
  assert.equal(notMember.ok, false);
  assert.equal(notMember.reason, 'not_a_member');
  assert.match(notMember.message, /бот/i);

  const restricted = await resolveLink(linkOf('https://t.me/c/1234567890/42'), deps({
    archive: await archiveWith(t, []),
    call: botApi({ forwardMessage: tgError("Bad Request: message can't be forwarded") }).call,
  }));
  assert.equal(restricted.ok, false);
  assert.equal(restricted.reason, 'forward_restricted');
  assert.notEqual(restricted.message, notMember.message);

  const older = await resolveLink(linkOf('https://t.me/c/1234567890/42'), deps({
    archive: await archiveWith(t, []),
    call: botApi({ forwardMessage: tgError('Bad Request: message to forward not found') }).call,
  }));
  assert.equal(older.ok, false);
  assert.equal(older.reason, 'older_than_bot');
  assert.notEqual(older.message, restricted.message);
});

test('связь оборвалась — это не отказ доступа и не «сообщения нет»', async (t) => {
  const transport = Object.assign(new Error('нет ответа за 15 с'), { kind: 'transport' });
  const res = await resolveLink(linkOf('https://t.me/c/1234567890/42'), deps({
    archive: await archiveWith(t, []),
    call: botApi({ forwardMessage: transport }).call,
  }));

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unreachable');
  // Причина временная: человеку надо предложить повтор, а не поход в настройки бота.
  assert.match(res.message, /связ|сет/i);
});

test('служебного чата нет — пересылать некуда, и это сказано прямо', async (t) => {
  const api = botApi();
  const res = await resolveLink(linkOf('https://t.me/c/1234567890/42'), deps({
    archive: await archiveWith(t, []), call: api.call, serviceChatId: null,
  }));

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_service_chat');
  assert.match(res.message, /служебн/i);
  assert.deepEqual(api.methods(), []);
});

test('чат без правила: ни архива, ни сети — отказ до всего', async () => {
  const archive = {
    async branch() { throw new Error('архив читать не должны были'); },
    async chatIdOf() { throw new Error('архив читать не должны были'); },
    async append() { throw new Error('архив писать не должны были'); },
  };
  const api = botApi();

  const res = await resolveLink(linkOf('https://t.me/c/9876543210/42'), deps({ archive, call: api.call }));

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_allowed');
  assert.deepEqual(api.methods(), []);
});

test('тема, отданная другому проекту, не раскрывается найденным сообщением', async (t) => {
  // Ссылка темы не называет, предпроверка по чату проходит — а сообщение
  // оказывается в теме, которая принадлежит другому проекту.
  const archive = await archiveWith(t, [msg({ messageId: 42, threadId: 7 })]);
  const api = botApi();

  const res = await resolveLink(linkOf('https://t.me/c/1234567890/42'), deps({
    archive,
    call: api.call,
    rules: rules({ project: 'alpha', chatId: BUGS }, { project: 'beta', chatId: BUGS, threadId: 7 }),
  }));

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_allowed');
  assert.equal(res.messages.length, 0, 'ни строчки переписки наружу не ушло');
  assert.deepEqual(api.methods(), []);
});

test('публичная ссылка: чат находится по имени, пересылка идёт по нему же', async (t) => {
  const archive = await archiveWith(t, [
    msg({ chatId: BUGS, chatUsername: 'example_team', messageId: 77, text: 'из архива' }),
  ]);
  const known = await resolveLink(linkOf('https://t.me/Example_Team/77'), deps({
    archive, call: botApi().call, rules: rules({ project: 'alpha', username: 'example_team' }),
  }));
  assert.equal(known.ok, true);
  assert.equal(known.source, 'archive');
  assert.equal(known.chat.id, BUGS);

  // Чата в архиве нет вовсе — id неизвестен, и Bot API принимает имя как адрес.
  const api = botApi({ forwardMessage: forwardCopy(), deleteMessage: true });
  const unknown = await resolveLink(linkOf('https://t.me/example_other/77'), deps({
    archive: await archiveWith(t, []),
    call: api.call,
    rules: rules({ project: 'alpha', username: 'example_other' }),
  }));
  assert.equal(unknown.ok, true);
  assert.equal(api.calls[0].body.from_chat_id, '@example_other');
  // Числового id мы так и не узнали — в архив такое не кладём, иначе завели бы
  // второй «чат» с выдуманным адресом.
  assert.equal(unknown.target.chatId, null);
});

test('ссылка на комментарий к посту канала: честный отказ, а не догадка', async (t) => {
  // Комментарий живёт в группе обсуждения — это ДРУГОЙ чат с другим id, и по
  // ссылке его не вычислить. Разворачивать наугад нельзя: правило проверяется
  // по фактическому чату (раздел 2 плана).
  const api = botApi();
  const res = await resolveLink(linkOf('https://t.me/example_news/900?comment=15'), deps({
    archive: await archiveWith(t, []),
    call: api.call,
    rules: rules({ project: 'alpha', username: 'example_news' }),
  }));

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'comment_link');
  assert.match(res.message, /обсужден/i);
  assert.deepEqual(api.methods(), []);
});

test('messageOfForward: копия описывает оригинал, а не служебный чат', () => {
  const fromChannel = messageOfForward(forwardCopy({
    forward_origin: { type: 'channel', chat: { id: -100777, title: 'Кокпит · новости' }, message_id: 900, date: T0 },
    text: '',
    caption: 'релиз выложен',
    photo: [{ file_id: 'AgAC', file_unique_id: 'u1', width: 90, height: 60, file_size: 900 }],
  }), { chatId: BUGS, chatUsername: 'example_team', messageId: 42, threadId: 7 });

  assert.equal(fromChannel.chatId, BUGS, 'чат — тот, из которого пересылали, а не служебный');
  assert.equal(fromChannel.chatUsername, 'example_team');
  assert.equal(fromChannel.messageId, 42);
  assert.equal(fromChannel.threadId, 7);
  assert.equal(fromChannel.date, T0);
  assert.equal(fromChannel.text, 'релиз выложен');
  assert.equal(fromChannel.media[0].kind, 'photo');
  assert.equal(fromChannel.from.name, 'Кокпит · новости');

  // Автор скрыл себя настройками пересылки — имя всё равно должно быть человеческим.
  const hidden = messageOfForward(forwardCopy({
    forward_origin: { type: 'hidden_user', sender_user_name: 'Анна К.', date: T0 },
  }), { chatId: BUGS, messageId: 42 });
  assert.equal(hidden.from.name, 'Анна К.');
  assert.equal(hidden.from.id, null);
});

test('resolveText: каждая ссылка со своим вердиктом, в порядке появления', async (t) => {
  const archive = await archiveWith(t, [msg({ messageId: 42, text: 'вот тут не жмётся' })]);
  const api = botApi();
  const text = [
    'Повтор описан тут https://t.me/c/1234567890/42',
    'а это из чужого чата https://t.me/c/9876543210/7 — трогать нельзя',
  ].join('\n');

  const out = await resolveText(text, deps({ archive, call: api.call }));

  assert.equal(out.length, 2);
  assert.equal(out[0].ok, true);
  assert.equal(out[0].target.text, 'вот тут не жмётся');
  assert.equal(out[1].ok, false);
  assert.equal(out[1].reason, 'not_allowed');
  // Ссылка остаётся при своём отказе: человеку показывают её вместе с причиной.
  assert.equal(out[1].link.url, 'https://t.me/c/9876543210/7');
  assert.deepEqual(api.methods(), []);
});
