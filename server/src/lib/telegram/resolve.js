// Разворот ссылки на Телеграм: что за ней стоит и можно ли это показывать.
//
// Три источника по порядку (docs/cockpit/inbox.md, раздел «Telegram»):
//
//   1. архив     — единственный, кто отдаёт ВЕТКУ целиком, а не одно сообщение;
//   2. пересылка — `forwardMessage` из исходного чата в служебный, копия сразу
//      удаляется. Работает, только если бот состоит в чате и пересылка разрешена.
//      Именно `forwardMessage`, а не `copyMessage`: второй возвращает лишь
//      идентификатор копии, то есть текста мы так и не увидим;
//   3. отказ     — с причиной из закрытого набора и текстом для человека.
//      Пустой блок «не раскрылось» без причины хуже, чем его отсутствие.
//
// Кэш разворота — сам архив: удачно пересланное сообщение дописывается туда же,
// куда поллер кладёт живые. Отсюда «кэш навсегда» и обновление по правке даром,
// без второго хранилища со своими правилами протухания. Отказы НЕ кэшируются:
// бота могли добавить в чат, а ограничение снять.
//
// Граница доступа проверяется дважды и это не дублирование (см. link-scope.js):
// по форме ссылки — фильтр до сети, по найденному сообщению — решение.
import { checkScope, targetOfLink, targetOfMessage } from './link-scope.js';
import { parseTelegramLinks } from './links.js';
import { nameOf, normalizeMessage } from './updates.js';

/** Закрытый набор причин отказа: каждая со своим текстом и своим выходом. */
export const REASONS = {
  not_allowed: '', // текст даёт граница доступа: он зависит от правила
  comment_link: 'Это ссылка на комментарий к посту канала. Комментарии живут в отдельной '
    + 'группе обсуждения, и по такой ссылке её не вычислить. Дайте ссылку на само сообщение '
    + 'в группе обсуждения — она открывается из комментария пунктом «Скопировать ссылку».',
  older_than_bot: 'Сообщение старше бота: всё, что было до его вступления в чат, Bot API не '
    + 'отдаёт вовсе. Перешлите сообщение боту вручную — тогда оно попадёт в архив.',
  not_a_member: 'Бота нет в этом чате — добавьте его, и разворот заработает. Если бот в чате, '
    + 'проверьте, не выключен ли у него режим приватности (@BotFather → Group Privacy).',
  forward_restricted: 'В чате запрещена пересылка сообщений, поэтому достать текст нечем. '
    + 'Пока сообщение не попало в архив, показать его не получится.',
  no_service_chat: 'Не задан служебный чат, куда бот пересылает сообщения сам себе. Без него '
    + 'достать сообщение, которого нет в архиве, нечем — задайте чат в разделе «Телеграм».',
  not_connected: 'Бот не подключён — подключите его в разделе «Телеграм».',
  unreachable: 'Телеграм не ответил: связь до api.telegram.org не установилась. Это временно — '
    + 'попробуйте ещё раз.',
  unknown: 'Телеграм отказал.',
};

const fail = (link, reason, message = '', rule = null) => ({
  link, ok: false, source: null, reason, rule,
  message: message || REASONS[reason] || REASONS.unknown,
  chat: null, thread: null, target: null, messages: [],
});

const chatOf = (msg) => ({
  id: msg.chatId ?? null,
  title: msg.chatTitle || '',
  username: msg.chatUsername || '',
  isForum: !!msg.isForum,
});

/**
 * Отказ Bot API → наша причина.
 *
 * Кодов у Телеграма нет — есть текст `description`, и разбирать приходится его.
 * Незнакомый текст остаётся `unknown` и показывается как есть: выдумывать причину
 * хуже, чем признаться, что мы её не поняли.
 */
export function reasonOfError(err) {
  if (err?.kind === 'transport') return 'unreachable';
  const d = String(err?.message || '').toLowerCase();
  if (d.includes('message to forward not found') || d.includes('message not found')) return 'older_than_bot';
  if (d.includes("can't be forwarded") || d.includes('cannot be forwarded')
    || d.includes('restricted') || d.includes('protected content')) return 'forward_restricted';
  if (d.includes('chat not found') || d.includes('not a member') || d.includes('bot was kicked')
    || d.includes('bot is not a member') || d.includes('forbidden')) return 'not_a_member';
  return 'unknown';
}

/** Автор оригинала: у пересылки он лежит отдельно от автора самой копии. */
function authorOfOrigin(origin, copy) {
  const senderChat = origin.chat || origin.sender_chat || copy?.forward_from_chat;
  if (senderChat) {
    return { id: senderChat.id ?? null, name: senderChat.title || 'канал', username: senderChat.username || '' };
  }
  if (origin.type === 'hidden_user') {
    // Человек закрыл ссылку на себя настройками приватности — имя всё же есть.
    return { id: null, name: origin.sender_user_name || 'скрытый автор', username: '' };
  }
  const user = origin.sender_user || copy?.forward_from;
  if (user) return { id: user.id ?? null, name: nameOf(user), username: user.username || '' };
  return { id: null, name: 'неизвестно', username: '' };
}

/**
 * Копия из служебного чата → сообщение исходного чата.
 *
 * Копия описывает СЕБЯ: её `chat` — служебный чат, `message_id` — id копии,
 * `date` — время пересылки. Всё это к оригиналу отношения не имеет, поэтому
 * адрес берётся из ссылки (мы сами передали его в `from_chat_id`), а время и
 * автор — из `forward_origin`.
 */
export function messageOfForward(copy, {
  chatId = null, chatUsername = '', chatTitle = '', chatType = '', isForum = false,
  messageId = null, threadId = null,
} = {}) {
  const base = normalizeMessage(copy || {});
  const origin = copy?.forward_origin || {};
  return {
    ...base,
    chatId,
    chatUsername: String(chatUsername || '').replace(/^@/, ''),
    chatTitle,
    chatType,
    isForum,
    messageId: messageId ?? base.messageId,
    threadId,
    replyToMessageId: null, // у копии реплая нет: пересылается одно сообщение
    date: origin.date ?? copy?.forward_date ?? base.date,
    from: authorOfOrigin(origin, copy),
    forwarded: true,
  };
}

/** Достать сообщение пересылкой себе; копию за собой убираем всегда. */
async function viaForward(link, { call, serviceChatId, log }) {
  if (typeof call !== 'function') return { err: 'not_connected' };
  if (!serviceChatId) return { err: 'no_service_chat' };

  // Bot API принимает и числовой id, и `@имя` — числовой id знать не обязательно.
  const from = link.chatId ?? (link.username ? `@${String(link.username).replace(/^@/, '')}` : null);
  if (from == null) return { err: 'unknown' };

  let copy;
  try {
    copy = await call('forwardMessage', {
      chat_id: serviceChatId, from_chat_id: from, message_id: link.messageId,
    });
  } catch (err) {
    return { err: reasonOfError(err), detail: err?.message || '' };
  }

  try {
    await call('deleteMessage', { chat_id: serviceChatId, message_id: copy.message_id });
  } catch (err) {
    // Неубранная копия — мусор в служебном чате, а не провал разворота: текст
    // мы уже получили, и терять его из-за этого нельзя.
    log?.warn?.({ err: err.message }, 'телеграм: служебная копия не удалилась');
  }

  return {
    msg: messageOfForward(copy, {
      chatId: link.chatId ?? null,
      chatUsername: link.username || '',
      // Номер — из ССЫЛКИ: у копии он свой, служебного чата. Возьми его — и в
      // архив ляжет сообщение под чужим номером, то есть второй разворот той же
      // ссылки снова полез бы в сеть.
      messageId: link.messageId,
      threadId: link.threadId ?? null,
    }),
  };
}

/**
 * Развернуть одну ссылку.
 *
 * @param {object} link результат `parseTelegramLinks`
 * @param {{archive: object, rules?: Array, project?: string|null,
 *          call?: Function, serviceChatId?: number|string|null,
 *          window?: {before?: number, after?: number}, log?: object}} deps
 */
export async function resolveLink(link, {
  archive, rules = [], project = null, call = null, serviceChatId = null,
  window = {}, log = console,
} = {}) {
  // 1. Фильтр по форме ссылки — ДО чтения архива и до сети. Пересылать себе
  // сообщение из чужого чата нельзя даже ради того, чтобы узнать, чей он.
  const pre = checkScope(rules, targetOfLink(link), { project });
  if (!pre.allowed) return fail(link, pre.reason, pre.message, pre.rule);

  if (link.commentId) return fail(link, 'comment_link');

  const decide = (found, source) => {
    // 2. Решение — по ФАКТИЧЕСКОМУ чату сообщения: за `t.me/<имя>/<N>` стоит и
    // пост канала, и сообщение группы обсуждения, а тема могла уйти проекту,
    // о котором ссылка молчит.
    const verdict = checkScope(rules, targetOfMessage(found.target), { project });
    if (!verdict.allowed) return fail(link, verdict.reason, verdict.message, verdict.rule);
    return {
      link,
      ok: true,
      source,
      reason: null,
      message: '',
      rule: verdict.rule,
      chat: chatOf(found.target),
      thread: found.thread ?? found.target.threadId ?? null,
      target: found.target,
      messages: found.messages,
    };
  };

  // 3. Архив. Чат в нём лежит под числовым id — публичное имя переводим сами.
  const chatId = link.chatId ?? await archive.chatIdOf(link.username);
  if (chatId != null) {
    const found = await archive.branch(chatId, link.messageId, window);
    if (found) return decide(found, 'archive');
  }

  // 4. Пересылка себе.
  const { msg, err, detail } = await viaForward(link, { call, serviceChatId, log });
  if (err) {
    const text = err === 'unknown' && detail ? `${REASONS.unknown} ${detail}` : '';
    return fail(link, err, text);
  }

  const result = decide({ target: msg, messages: [msg], thread: msg.threadId }, 'forward');
  // В архив кладём только то, у чего есть настоящий адрес: чат, известный лишь
  // по имени, завёл бы вторую папку с выдуманным id.
  if (result.ok && msg.chatId != null) await archive.append(msg);
  return result;
}

/**
 * Развернуть все ссылки текста, каждую со своим вердиктом и в порядке появления.
 * Одинаковые ссылки разворачиваются один раз.
 *
 * Последовательно, а не пачкой: пересылки идут в один служебный чат, и разгонять
 * их параллельно значит ловить лимиты Телеграма на ровном месте.
 */
export async function resolveText(text, deps) {
  const out = [];
  const seen = new Map();
  for (const link of parseTelegramLinks(text)) {
    if (!seen.has(link.key)) seen.set(link.key, await resolveLink(link, deps));
    out.push({ ...seen.get(link.key), link });
  }
  return out;
}
