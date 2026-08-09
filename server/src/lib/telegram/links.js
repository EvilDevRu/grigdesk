// Разбор ссылок t.me в тексте задачи Битрикса.
//
// Парсер отвечает только на вопрос «какой адрес написан»: чат, тема, сообщение.
// Существует ли этот чат, пустят ли туда бота и что там лежит — дело резолва:
// за формой `t.me/<username>/<N>` стоит и пост канала, и сообщение группы, а бот
// может состоять в группе обсуждения и не состоять в самом канале. Поэтому
// такая ссылка помечается `ambiguous`, а не угадывается здесь.
//
// Формы (см. docs/cockpit/inbox.md, раздел «Telegram»):
//   t.me/<username>/<msg>                 публичный чат
//   t.me/<username>/<thread>/<msg>        публичный форум
//   t.me/c/<internal>/<msg>               приватная группа, chat_id = -100 + internal
//   t.me/c/<internal>/<thread>/<msg>      приватный форум
//   t.me/<username>/<post>?comment=<id>   комментарий к посту канала

// Домен считаем адресом Telegram только на границе слова: `example.com/t.me/…`
// и `nott.me/…` — чужие адреса, а не наши со срезанным началом.
const LINK_RE = /(?<![\w.@/-])(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([^\s<>"'`«»]+)/gi;

// Пунктуация, которой заканчивают предложение вокруг ссылки: «(…/42).» — не часть адреса.
const TRAILING_RE = /[.,;:!?)\]}]+$/;

// Имя чата: 5–32 символа, начинается с буквы (правило Telegram).
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;

// Служебные разделы t.me, которые именем чата не являются. Числового сообщения
// за ними не бывает, но проверять форму надёжнее, чем полагаться на это.
const RESERVED = new Set([
  'joinchat', 'addstickers', 'addemoji', 'addtheme', 'setlanguage',
  'proxy', 'socks', 'share', 'iv', 'login', 'bg', 'contact', 'invoice',
]);

const isDigits = (s) => typeof s === 'string' && /^\d+$/.test(s);
const num = (s) => (isDigits(s) ? Number(s) : null);

/**
 * Каноническая ссылка на уже проверенное native Telegram message.
 * Личка и старая группа без public username/supergroup id ссылки не имеют.
 */
export function telegramMessageLink({ chatId, chatUsername, threadId, messageId } = {}) {
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
  const parts = [];
  const name = String(chatUsername || '').trim().replace(/^@/u, '');
  if (name) {
    if (!USERNAME_RE.test(name)) return null;
    parts.push(name);
  } else {
    const id = String(chatId ?? '');
    if (!/^-100\d+$/u.test(id)) return null;
    parts.push('c', id.slice(4));
  }
  if (threadId !== null && threadId !== undefined) {
    if (!Number.isSafeInteger(threadId) || threadId <= 0) return null;
    parts.push(String(threadId));
  }
  parts.push(String(messageId));
  return `https://t.me/${parts.join('/')}`;
}

/**
 * Вырезает блоки кода: тройные бэктики и `inline`. Ссылка в примере команды —
 * это пример, а не обсуждение, и раскрывать её не нужно. Заменяем пробелами,
 * чтобы не склеить соседний текст в одну строку.
 */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

/** Ключ дедупа: один и тот же адрес с разными косметическими хвостами — одна ссылка. */
function linkKey({ chatId, username, threadId, messageId, commentId }) {
  return [chatId ?? username, threadId ?? '', messageId, commentId ?? ''].join(':');
}

/** Разбор одного адреса. Ничего не понял — null, а не догадка. */
function parseOne(rest) {
  const clean = rest.replace(TRAILING_RE, '');
  const [rawPath, rawQuery = ''] = clean.split('?');
  const segs = rawPath.split('/').filter(Boolean);
  if (segs.length < 2) return null; // чат без сообщения — раскрывать нечего

  const query = new URLSearchParams(rawQuery);
  const commentId = num(query.get('comment'));
  const queryThread = num(query.get('thread'));

  let chatId = null;
  let username = null;
  let threadId = null;
  let messageId = null;

  if (segs[0] === 'c') {
    // Приватная группа: в ссылке внутренний id, у Bot API он с приставкой -100.
    if (!isDigits(segs[1])) return null;
    chatId = Number(`-100${segs[1]}`);
    if (segs.length === 3) messageId = num(segs[2]);
    else if (segs.length === 4) { threadId = num(segs[2]); messageId = num(segs[3]); }
    else return null;
  } else {
    if (RESERVED.has(segs[0].toLowerCase()) || !USERNAME_RE.test(segs[0])) return null;
    username = segs[0];
    if (segs.length === 2) messageId = num(segs[1]);
    else if (segs.length === 3) { threadId = num(segs[1]); messageId = num(segs[2]); }
    else return null;
  }
  if (!messageId || (segs.length === 4 && !threadId)) return null;
  if (threadId === null && queryThread) threadId = queryThread;

  return {
    chatId,
    username,
    threadId,
    messageId,
    commentId,
    // Двусмысленна ровно одна форма: публичный чат без темы и без комментария.
    ambiguous: Boolean(username) && !threadId && !commentId,
    url: `https://t.me/${rawPath.replace(/\/+$/, '')}${commentId ? `?comment=${commentId}` : ''}`,
  };
}

/**
 * Все ссылки t.me из текста, в порядке появления и без дублей.
 * @param {string} text текст задачи или комментария
 * @returns {Array<{raw: string, url: string, chatId: number|null, username: string|null,
 *   threadId: number|null, messageId: number, commentId: number|null,
 *   ambiguous: boolean, key: string}>}
 */
export function parseTelegramLinks(text) {
  if (typeof text !== 'string' || !text) return [];
  const body = stripCode(text);
  const out = [];
  const seen = new Set();
  for (const m of body.matchAll(LINK_RE)) {
    const parsed = parseOne(m[1]);
    if (!parsed) continue;
    const key = linkKey(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...parsed, key, raw: m[0].replace(TRAILING_RE, '') });
  }
  return out;
}
