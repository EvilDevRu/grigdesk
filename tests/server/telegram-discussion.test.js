// Блок «Обсуждение в Telegram»: вердикты резолва → то, что видит человек и агент.
//
// Это единственное место, где содержимое чужой переписки превращается в текст
// для показа, поэтому здесь же стоит и последняя граница: у отказа наружу не
// уходит НИЧЕГО кроме причины. Резолв её уже держит, но блок собирается из его
// результата — и повторная проверка тут не дублирование, а страховка от «а тут
// мы на минуточку положили chat, чтобы показать имя».
//
// Второе, ради чего эта функция существует отдельно от резолва: лимит разворота
// нужен ДО сборки тикета (docs/grigdesk/inbox.md, раздел «Telegram»). Секции
// дописываются в хвост описания, а переполнение `fitDescription` режет с конца —
// значит обсуждение обрезалось бы первым и молча.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DISCUSSION_LIMITS, buildDiscussion } from '../../server/src/lib/telegram/discussion.ts';

const T0 = Date.UTC(2026, 7, 7, 9, 0, 0) / 1000;
const CHAT = -1001000000042;

const msg = (over = {}) => ({
  chatId: CHAT,
  chatUsername: '',
  chatTitle: 'Команда Альфа · разработка',
  chatType: 'supergroup',
  isForum: true,
  messageId: 345,
  threadId: 12,
  replyToMessageId: null,
  date: T0,
  editedAt: null,
  from: { id: 424242, name: 'Тестовый пользователь', username: 'test_user' },
  text: 'Касса не открывается после обновления.',
  media: [],
  ...over,
});

/** Удачный вердикт резолва: ветка сообщений и цель, на которую вела ссылка. */
function ok({ url = 'https://t.me/c/1000000042/12/345', messages, target } = {}) {
  const list = messages || [msg()];
  const aim = target || list[list.length - 1];
  return {
    link: { url, key: url, chatId: CHAT, messageId: aim.messageId, threadId: aim.threadId },
    ok: true,
    source: 'archive',
    reason: null,
    message: '',
    rule: { project: 'demo', chatId: CHAT, threadId: 12 },
    chat: { id: CHAT, title: aim.chatTitle, username: '', isForum: true },
    thread: aim.threadId,
    target: aim,
    messages: list,
  };
}

/**
 * Отказ. Поля содержимого заполнены НАРОЧНО: так выглядел бы вердикт, если
 * граница где-то выше подтечёт. Блок обязан выстоять сам.
 */
function denied(over = {}) {
  return {
    link: { url: 'https://t.me/c/777/9', key: 'c777/9', chatId: -100777, messageId: 9 },
    ok: false,
    source: null,
    reason: 'not_allowed',
    message: 'Чат не привязан ни к одному проекту.',
    rule: null,
    chat: { id: -100777, title: 'Секретный чат совета директоров', username: 'boardroom' },
    thread: null,
    target: msg({ chatTitle: 'Секретный чат совета директоров', text: 'Продаём контору в среду.' }),
    messages: [msg({ text: 'Продаём контору в среду.' })],
    ...over,
  };
}

/** Ветка из N сообщений подряд, минута между соседями. */
const branch = (n, from = 340) => Array.from({ length: n }, (_, i) => msg({
  messageId: from + i,
  date: T0 + i * 60,
  text: `Сообщение номер ${i + 1}`,
  from: { id: 1000 + i, name: `Автор ${i + 1}`, username: '' },
}));

test('отказ отдаёт причину и ничего кроме неё', () => {
  const view = buildDiscussion([denied()]);
  const [item] = view.links;

  assert.equal(item.ok, false);
  assert.equal(item.reason, 'not_allowed');
  assert.match(item.message, /не привязан/);
  assert.equal(item.url, 'https://t.me/c/777/9');

  // Ни имени чата, ни текста, ни автора: allowlist защищает данные, а не вид
  // ссылки. Проверяем и по полям, и по сериализации — поле могло приехать
  // вложенным в что-нибудь безобидное.
  assert.equal(item.chat, undefined);
  assert.equal(item.quotes, undefined);
  const json = JSON.stringify(view);
  assert.ok(!json.includes('совета директоров'), 'имя чужого чата уехало наружу');
  assert.ok(!json.includes('Продаём контору'), 'текст чужого сообщения уехал наружу');
  assert.ok(!view.text.includes('совета директоров'));
});

test('нет ссылок — нет секции: пустой текст, а не пустой заголовок', () => {
  const view = buildDiscussion([]);
  assert.deepEqual(view.links, []);
  assert.equal(view.text, '');
  assert.equal(view.quotes, 0);
});

test('цитаты идут по времени, а та, на которую ссылались, помечена', () => {
  const list = branch(3);
  const view = buildDiscussion([ok({ messages: list, target: list[1] })]);
  const [item] = view.links;

  assert.deepEqual(item.quotes.map((q) => q.messageId), [340, 341, 342]);
  assert.deepEqual(item.quotes.map((q) => q.target), [false, true, false]);
  assert.equal(item.chat.title, 'Команда Альфа · разработка');
  assert.equal(item.thread, 12);
  // В тексте видно и автора, и время, и что именно на это была ссылка.
  assert.match(view.text, /Автор 2/);
  assert.match(view.text, /\d\d:\d\d/);
  assert.match(view.text, /ссылка/);
});

test('лимит режет соседей по ветке, а не то, на что ссылались', () => {
  // Иначе получалось бы худшее из возможного: развернули ветку, а само
  // сообщение, ради которого человек дал ссылку, не показали.
  const list = branch(9);
  const view = buildDiscussion([ok({ messages: list, target: list[8] })], { maxQuotes: 3 });
  const [item] = view.links;

  assert.equal(item.quotes.length, 3);
  assert.ok(item.quotes.some((q) => q.target && q.messageId === 348), 'целевое сообщение срезано лимитом');
  assert.equal(item.more, 6);
  assert.equal(view.truncated, true);
  // Соседи берутся ближайшие: предыстория объясняет жалобу лучше, чем начало ветки.
  assert.deepEqual(item.quotes.map((q) => q.messageId), [346, 347, 348]);
  assert.match(view.text, /ещё 6/);
});

test('целевые сообщения всех ссылок влезают даже в тесный лимит', () => {
  const a = branch(4, 100);
  const b = branch(4, 200);
  const view = buildDiscussion(
    [ok({ messages: a, target: a[3] }), ok({ url: 'https://t.me/c/1000000042/12/203', messages: b, target: b[3] })],
    { maxQuotes: 2 },
  );

  assert.deepEqual(view.links.map((i) => i.quotes.map((q) => q.messageId)), [[103], [203]]);
  assert.equal(view.quotes, 2);
  assert.deepEqual(view.links.map((i) => i.more), [3, 3]);
});

test('длинная цитата обрезается, а не выбрасывается', () => {
  const long = msg({ text: 'а'.repeat(3000) });
  const view = buildDiscussion([ok({ messages: [long] })], { maxQuoteChars: 200 });
  const [quote] = view.links[0].quotes;

  assert.equal(quote.trimmed, true);
  assert.ok(quote.text.length <= 220, `цитата не обрезана: ${quote.text.length}`);
  assert.match(quote.text, /…$/);
  assert.ok(view.text.length < 1000, 'обрезка не доехала до текста секции');
});

test('суммарный потолок символов останавливает добор соседей', () => {
  const list = branch(6).map((m) => ({ ...m, text: 'б'.repeat(400) }));
  const view = buildDiscussion([ok({ messages: list, target: list[5] })], { maxChars: 900 });
  const [item] = view.links;

  assert.ok(item.quotes.length < 6, 'потолок символов не сработал');
  assert.ok(item.quotes.some((q) => q.target), 'целевое сообщение выкинуто потолком символов');
  assert.ok(view.text.length <= 1400, `текст секции разросся: ${view.text.length}`);
  assert.equal(view.truncated, true);
});

test('вложения названы словами, идентификаторы файлов наружу не уходят', () => {
  const withMedia = msg({
    text: 'Вот что видно',
    media: [
      { kind: 'photo', fileId: 'AgACAgIAAxkBAAI', uniqueId: 'AQADbc', size: 90210 },
      { kind: 'document', fileId: 'BQACAgIAAxkBAAI', name: 'отчёт.pdf', mime: 'application/pdf' },
      { kind: 'voice', fileId: 'AwACAgIAAxkBAAI', size: 12000 },
    ],
  });
  const view = buildDiscussion([ok({ messages: [withMedia] })]);
  const [quote] = view.links[0].quotes;

  assert.deepEqual(quote.media, ['фото', 'файл отчёт.pdf', 'голосовое']);
  const json = JSON.stringify(view);
  assert.ok(!json.includes('AgACAgIAAxkBAAI'), 'fileId уехал наружу');
  assert.match(view.text, /фото/);
});

test('сообщение без текста показывается вложением, а не пустой строкой', () => {
  const shot = msg({ text: '', media: [{ kind: 'photo', fileId: 'X' }] });
  const view = buildDiscussion([ok({ messages: [shot] })]);
  const [quote] = view.links[0].quotes;

  assert.equal(quote.text, '');
  assert.deepEqual(quote.media, ['фото']);
  assert.match(view.text, /Тестовый пользователь/);
  assert.match(view.text, /фото/);
});

test('умолчания лимитов заданы и применяются, когда их не передали', () => {
  // Лимит по умолчанию — не украшение: разворот идёт в тикет, а там потолок
  // описания режет с конца, и обсуждение исчезло бы первым.
  assert.ok(DISCUSSION_LIMITS.quotes > 0 && DISCUSSION_LIMITS.chars > 0);
  const huge = branch(200).map((m) => ({ ...m, text: 'в'.repeat(500) }));
  const view = buildDiscussion([ok({ messages: huge, target: huge[199] })]);

  assert.ok(view.quotes <= DISCUSSION_LIMITS.quotes);
  assert.ok(view.text.length <= DISCUSSION_LIMITS.chars * 1.5, `текст секции: ${view.text.length}`);
  assert.equal(view.truncated, true);
});

test('нераскрытая ссылка не мешает раскрытой в том же тексте', () => {
  const view = buildDiscussion([ok(), denied()]);

  assert.deepEqual(view.links.map((i) => i.ok), [true, false]);
  assert.match(view.text, /Касса не открывается/);
  assert.match(view.text, /не привязан/);
  assert.equal(view.quotes, 1);
});
