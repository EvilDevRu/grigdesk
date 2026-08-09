// Разбор апдейта Bot API в наш контракт сообщения.
//
// Зачем отдельный модуль: форма Телеграма и форма, с которой работает весь
// остальной плагин (склейка связок, архив, разбор), — разные вещи, и смешивать
// их в поллере значит хоронить правила разбора внутри сетевого цикла.
//
// Контракт сообщения (он же вход `BundleSet.add` и запись архива):
//   { chatId, chatUsername, chatTitle, chatType, isForum, messageId, threadId|null,
//     threadTitle?, threadTitleSource?,
//     replyToMessageId|null, mediaGroupId|null, date, editedAt|null,
//     from:{id,name,username}, text, media: [], service? }
//
// `chatUsername` — публичная сторона адреса чата. Нужна границе доступа
// (`link-scope.js`): правило можно завести и числовым id, и именем, а ссылка
// приходит то одной формой, то другой. Без имени в самом сообщении сверить
// правило «по имени» с чатом, найденным по id, было бы нечем.
//
// Вложения ОПИСЫВАЮТСЯ, но не скачиваются: в архив идёт ссылка (`fileId`), файл
// тянется отдельно и по требованию — иначе первая же переписка со скриншотами
// раздула бы архив до гигабайтов.

/** Служебные поля сообщения: их наличие и означает «это событие чата, а не текст». */
const SERVICE_FIELDS = [
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo',
  'delete_chat_photo', 'pinned_message', 'group_chat_created',
  'supergroup_chat_created', 'channel_chat_created', 'migrate_to_chat_id',
  'migrate_from_chat_id', 'message_auto_delete_timer_changed',
  'forum_topic_created', 'forum_topic_edited', 'forum_topic_closed',
  'forum_topic_reopened', 'general_forum_topic_hidden',
  'general_forum_topic_unhidden', 'video_chat_started', 'video_chat_ended',
  'video_chat_participants_invited', 'write_access_allowed',
];

/** Одиночные вложения: поле сообщения → как мы его называем. */
const SINGLE_MEDIA = [
  ['document', 'document'], ['video', 'video'], ['animation', 'animation'],
  ['audio', 'audio'], ['voice', 'voice'], ['video_note', 'video_note'],
  ['sticker', 'sticker'],
];

/** Человеческое имя автора: имя с фамилией, иначе ник, иначе просто id. */
export function nameOf(user) {
  if (!user) return 'неизвестно';
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || user.username || `id${user.id}`;
}

function mediaOf(m) {
  const out = [];
  if (Array.isArray(m.photo) && m.photo.length) {
    // Телеграм присылает лесенку размеров одной картинки — берём самый крупный.
    const px = (p) => p.file_size ?? (p.width || 0) * (p.height || 0);
    const best = m.photo.reduce((a, b) => (px(b) > px(a) ? b : a));
    out.push({
      kind: 'photo',
      fileId: best.file_id,
      uniqueId: best.file_unique_id || '',
      size: best.file_size ?? null,
      width: best.width ?? null,
      height: best.height ?? null,
    });
  }
  for (const [field, kind] of SINGLE_MEDIA) {
    const f = m[field];
    if (!f?.file_id) continue;
    out.push({
      kind,
      fileId: f.file_id,
      uniqueId: f.file_unique_id || '',
      size: f.file_size ?? null,
      name: f.file_name || '',
      mime: f.mime_type || '',
    });
  }
  return out;
}

/**
 * Ответ ли это на чьё-то сообщение.
 *
 * Внутри темы форума Телеграм подставляет `reply_to_message` на КОРЕНЬ темы,
 * хотя человек никому не отвечал. Принять это за реплай — значит склеить всю
 * тему в одну цепочку по ложному признаку, поэтому корень темы отсекается.
 */
function replyIdOf(m) {
  const to = m.reply_to_message;
  if (!to?.message_id) return null;
  if (m.is_topic_message && to.message_id === m.message_thread_id) return null;
  if (to.forum_topic_created) return null;
  return to.message_id;
}

/**
 * Название темы, если оно приехало вместе с сообщением.
 *
 * В HTTP Bot API нет метода «перечислить темы форума», поэтому список для формы
 * собирается из того, что бот уже видел. Событие создания/переименования —
 * авторитетный источник; корень темы в `reply_to_message` — запасной вариант,
 * когда бота добавили в уже существующий форум.
 */
function threadTitleOf(m) {
  const edited = String(m.forum_topic_edited?.name || '').trim();
  if (edited) return { title: edited, source: 'event' };
  const created = String(m.forum_topic_created?.name || '').trim();
  if (created) return { title: created, source: 'event' };
  const root = String(m.reply_to_message?.forum_topic_created?.name || '').trim();
  if (root) return { title: root, source: 'root' };
  return null;
}

/** Сообщение Bot API → наш контракт. */
export function normalizeMessage(m) {
  const chat = m.chat || {};
  const service = SERVICE_FIELDS.find((f) => m[f] !== undefined) || undefined;
  const threadTitle = threadTitleOf(m);
  return {
    chatId: chat.id,
    chatUsername: chat.username || '',
    chatTitle: chat.title || nameOf(chat) || '',
    chatType: chat.type || '',
    isForum: !!chat.is_forum,
    messageId: m.message_id,
    threadId: m.message_thread_id ?? null,
    replyToMessageId: replyIdOf(m),
    // Альбом Телеграм разбирает на отдельные сообщения с общим `media_group_id`,
    // а подпись отдаёт только одному из них. Без этого поля четыре скриншота
    // выглядели бы четырьмя сообщениями, три из которых пустые.
    mediaGroupId: m.media_group_id ?? null,
    date: m.date,
    editedAt: m.edit_date ?? null,
    from: m.from
      ? { id: m.from.id, name: nameOf(m.from), username: m.from.username || '' }
      : { id: m.sender_chat?.id ?? null, name: m.sender_chat?.title || 'канал', username: '' },
    text: m.text || m.caption || '',
    media: mediaOf(m),
    ...(threadTitle ? {
      threadTitle: threadTitle.title,
      threadTitleSource: threadTitle.source,
    } : {}),
    ...(service ? { service } : {}),
  };
}

/** Список эмодзи из массива ReactionType (кастомные — своим ключом). */
const emojis = (list) => (Array.isArray(list) ? list : [])
  .map((r) => (r.type === 'emoji' ? r.emoji : `custom:${r.custom_emoji_id}`))
  .filter(Boolean);

/**
 * Апдейт → `{ type, msg, reaction }`.
 *
 * `type`: `message` | `edited_message` | `reaction` | `unknown`. Незнакомый тип
 * не ошибка: он всё равно двигает offset, иначе поллер застрянет на нём навсегда.
 */
export function normalizeUpdate(raw) {
  const empty = { type: 'unknown', msg: null, reaction: null };
  if (!raw || typeof raw !== 'object') return empty;

  if (raw.message) return { type: 'message', msg: normalizeMessage(raw.message), reaction: null };
  if (raw.edited_message) return { type: 'edited_message', msg: normalizeMessage(raw.edited_message), reaction: null };

  const r = raw.message_reaction;
  if (r) {
    const before = emojis(r.old_reaction);
    const after = emojis(r.new_reaction);
    return {
      type: 'reaction',
      msg: null,
      reaction: {
        chatId: r.chat?.id,
        chatTitle: r.chat?.title || '',
        messageId: r.message_id,
        date: r.date,
        from: r.user
          ? { id: r.user.id, name: nameOf(r.user), username: r.user.username || '' }
          : { id: r.actor_chat?.id ?? null, name: r.actor_chat?.title || 'аноним', username: '' },
        added: after.filter((e) => !before.includes(e)),
        removed: before.filter((e) => !after.includes(e)),
      },
    };
  }

  return empty;
}
