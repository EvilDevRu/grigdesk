// Разбор апдейта Bot API в наш контракт сообщения.
//
// Зачем отдельный модуль: форма Телеграма и форма, с которой работает весь
// остальной плагин (склейка связок, архив, разбор), — разные вещи, и смешивать
// их в поллере значит хоронить правила разбора внутри сетевого цикла.
//
// Контракт сообщения (он же вход `BundleSet.add` и запись архива):
//   { chatId, chatUsername, chatTitle, chatType, isForum, messageId, threadId|null,
//     threadTitle?, threadTitleSource?,
//     replyToMessageId|null, replyToFromId|null, mediaGroupId|null, date, editedAt|null,
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

type Payload = Record<string, unknown>;

// Автор со стороны Bot API. Читаем ровно то, из чего складывается имя: остальное
// провайдерское поле GrigDesk не нужно и наружу не выходит.
export interface TelegramUser {
  id?: number | null;
  first_name?: string;
  last_name?: string;
  username?: string;
  title?: string;
}

interface TelegramFile {
  file_id?: string;
  file_unique_id?: string;
  file_size?: number | null;
  file_name?: string;
  mime_type?: string;
  width?: number | null;
  height?: number | null;
}

// Вложение ОПИСЫВАЕТСЯ, но не скачивается: в архив едет ссылка, а файл тянется
// отдельно и по требованию.
export interface TelegramMedia {
  kind: string;
  fileId?: string;
  uniqueId: string;
  size: number | null;
  width?: number | null;
  height?: number | null;
  name?: string;
  mime?: string;
}

// Контракт сообщения плагина: он же вход склейки связок и запись архива.
export interface TelegramMessage {
  chatId: number;
  chatUsername: string;
  chatTitle: string;
  chatType: string;
  isForum: boolean;
  messageId: number;
  threadId: number | null;
  threadTitle?: string;
  threadTitleSource?: string;
  replyToMessageId: number | null;
  replyToFromId: number | null;
  mediaGroupId: string | null;
  date: number;
  editedAt: number | null;
  from: { id: number | null; name: string; username: string };
  text: string;
  media: TelegramMedia[];
  service?: string;
}

export interface TelegramCallback {
  id: string;
  data: string;
  from: { id: number | null; name: string; username: string };
  chatId: number | null;
  chatType: string;
  messageId: number | null;
}

export interface TelegramReaction {
  chatId: number | null;
  chatTitle: string;
  messageId: number;
  date: number;
  from: { id: number | null; name: string; username: string };
  added: string[];
  removed: string[];
}

export interface TelegramUpdate {
  type: string;
  msg: TelegramMessage | null;
  reaction: TelegramReaction | null;
  callback?: TelegramCallback;
}

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
const SINGLE_MEDIA: [string, string][] = [
  ['document', 'document'], ['video', 'video'], ['animation', 'animation'],
  ['audio', 'audio'], ['voice', 'voice'], ['video_note', 'video_note'],
  ['sticker', 'sticker'],
];

/** Файловые поля блока rich-сообщения: как их зовёт Телеграм → как зовём мы. */
const RICH_MEDIA: [string, string][] = [
  ['photo', 'photo'], ['video', 'video'], ['animation', 'animation'],
  ['audio', 'audio'], ['voice_note', 'voice'], ['video_note', 'video_note'],
  ['document', 'document'], ['sticker', 'sticker'],
];

// Пределы разбора недоверенного дерева: и глубина, и ширина ограничены, иначе
// одно сообщение способно занять поллер на весь свой размер.
const RICH_LIMITS = { blocks: 500, depth: 8, parts: 500 };

/** Человеческое имя автора: имя с фамилией, иначе ник, иначе просто id. */
export function nameOf(user: TelegramUser | null | undefined): string {
  if (!user) return 'неизвестно';
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || user.username || `id${user.id}`;
}

/** Телеграм присылает лесенку размеров одной картинки — берём самый крупный. */
function largestPhoto(sizes: TelegramFile[]): TelegramFile | null {
  if (!sizes.length) return null;

  const px = (p: TelegramFile) => p.file_size ?? (p.width || 0) * (p.height || 0);

  return sizes.reduce((a, b) => (px(b) > px(a) ? b : a));
}

const photoMedia = (best: TelegramFile): TelegramMedia => ({
  kind: 'photo',
  fileId: best.file_id,
  uniqueId: best.file_unique_id || '',
  size: best.file_size ?? null,
  width: best.width ?? null,
  height: best.height ?? null,
});

const fileMedia = (kind: string, f: TelegramFile): TelegramMedia => ({
  kind,
  fileId: f.file_id,
  uniqueId: f.file_unique_id || '',
  size: f.file_size ?? null,
  name: f.file_name || '',
  mime: f.mime_type || '',
});

function mediaOf(m: Payload): TelegramMedia[] {
  const out: TelegramMedia[] = [];
  const best = Array.isArray(m.photo) ? largestPhoto(m.photo as TelegramFile[]) : null;

  if (best) out.push(photoMedia(best));
  for (const [field, kind] of SINGLE_MEDIA) {
    const f = m[field] as TelegramFile | undefined;

    if (!f?.file_id) continue;
    out.push(fileMedia(kind, f));
  }
  return out;
}

/**
 * Содержимое rich-сообщения (Bot API 10.1).
 *
 * Такое сообщение приезжает не плоскими полями, а деревом блоков: абзацы несут
 * текст, медиа-блок — файл и свою подпись. Старые `text`/`caption`/`video` при
 * этом ПУСТЫ, поэтому без разбора блоков в GrigDesk приходит пустая карточка: ни
 * текста, ни вложения, и разбирать её нечем.
 *
 * Разбор намеренно идёт по форме блока, а не по списку его имён: набор типов
 * Телеграм расширяет, а поле файла и поле текста у них общие.
 */
function richContentOf(source: unknown): { text: string; media: TelegramMedia[] } {
  const blocks = flattenRichBlocks(source, 0);
  const parts: string[] = [];
  const media: TelegramMedia[] = [];

  for (const block of blocks) {
    for (const field of ['text', 'caption']) {
      const part = richTextOf(block[field], 0).trim();

      if (part) parts.push(part);
    }
    media.push(...richMediaOf(block));
  }
  return { text: parts.join('\n'), media };
}

/** Дерево блоков в плоский список: контейнеры вкладывают свои блоки тем же полем. */
function flattenRichBlocks(source: unknown, depth: number): Payload[] {
  if (depth >= RICH_LIMITS.depth || !source || typeof source !== 'object') return [];

  const raw = (source as Payload).blocks;

  if (!Array.isArray(raw)) return [];

  const out: Payload[] = [];

  for (const item of raw.slice(0, RICH_LIMITS.blocks)) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Payload;

    out.push(block, ...flattenRichBlocks(block, depth + 1));
  }
  return out;
}

/**
 * Текст блока: строкой, объектом `{text}` или списком оформленных кусков.
 *
 * Жирный, ссылка и курсив — это вложенные фрагменты со своим `text`, поэтому
 * склейка идёт вглубь: иначе от абзаца остались бы только неформатированные
 * куски, а ссылка из подписи потерялась бы вовсе.
 */
function richTextOf(value: unknown, depth: number): string {
  if (typeof value === 'string') return value;
  if (depth >= RICH_LIMITS.depth || !value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    return value
      .slice(0, RICH_LIMITS.parts)
      .map((part) => richTextOf(part, depth + 1))
      .join('');
  }
  return richTextOf((value as Payload).text, depth + 1);
}

/** Вложения блока: фото приходит лесенкой размеров, остальное — одним файлом. */
function richMediaOf(block: Payload): TelegramMedia[] {
  const out: TelegramMedia[] = [];

  for (const [field, kind] of RICH_MEDIA) {
    const value = block[field];

    if (!value || typeof value !== 'object') continue;
    if (kind === 'photo') {
      const best = Array.isArray(value)
        ? largestPhoto(value as TelegramFile[])
        : value as TelegramFile;

      if (best?.file_id) out.push(photoMedia(best));
      continue;
    }

    const file = value as TelegramFile;

    if (file.file_id) out.push(fileMedia(kind, file));
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
function replyIdOf(m: Payload): number | null {
  const to = m.reply_to_message as Payload | undefined;

  if (!to?.message_id) return null;
  if (m.is_topic_message && to.message_id === m.message_thread_id) return null;
  if (to.forum_topic_created) return null;

  return to.message_id as number;
}

/**
 * Название темы, если оно приехало вместе с сообщением.
 *
 * В HTTP Bot API нет метода «перечислить темы форума», поэтому список для формы
 * собирается из того, что бот уже видел. Событие создания/переименования —
 * авторитетный источник; корень темы в `reply_to_message` — запасной вариант,
 * когда бота добавили в уже существующий форум.
 */
function threadTitleOf(m: Payload): { title: string; source: string } | null {
  const named = (value: unknown) => String((value as Payload | undefined)?.name || '').trim();
  const edited = named(m.forum_topic_edited);

  if (edited) return { title: edited, source: 'event' };

  const created = named(m.forum_topic_created);

  if (created) return { title: created, source: 'event' };

  const root = named((m.reply_to_message as Payload | undefined)?.forum_topic_created);

  if (root) return { title: root, source: 'root' };

  return null;
}

/** Сообщение Bot API → наш контракт. */
export function normalizeMessage(m: Payload): TelegramMessage {
  const chat = (m.chat || {}) as Payload;
  const service = SERVICE_FIELDS.find((f) => m[f] !== undefined) || undefined;
  const threadTitle = threadTitleOf(m);
  const replyTo = m.reply_to_message as Payload | undefined;
  const author = m.from as TelegramUser | undefined;
  const senderChat = m.sender_chat as Payload | undefined;
  const rich = richContentOf(m.rich_message);

  return {
    chatId: chat.id as number,
    chatUsername: (chat.username as string) || '',
    chatTitle: (chat.title as string) || nameOf(chat as TelegramUser) || '',
    chatType: (chat.type as string) || '',
    isForum: !!chat.is_forum,
    messageId: m.message_id as number,
    threadId: (m.message_thread_id as number) ?? null,
    replyToMessageId: replyIdOf(m),
    replyToFromId: replyIdOf(m)
      ? ((replyTo?.from as Payload | undefined)?.id as number ?? null)
      : null,
    // Альбом Телеграм разбирает на отдельные сообщения с общим `media_group_id`,
    // а подпись отдаёт только одному из них. Без этого поля четыре скриншота
    // выглядели бы четырьмя сообщениями, три из которых пустые.
    mediaGroupId: (m.media_group_id as string) ?? null,
    date: m.date as number,
    editedAt: (m.edit_date as number) ?? null,
    from: author
      ? { id: author.id ?? null, name: nameOf(author), username: author.username || '' }
      : {
        id: (senderChat?.id as number) ?? null,
        name: (senderChat?.title as string) || 'канал',
        username: '',
      },
    text: (m.text as string) || (m.caption as string) || rich.text,
    media: [...mediaOf(m), ...rich.media],
    ...(threadTitle ? {
      threadTitle: threadTitle.title,
      threadTitleSource: threadTitle.source,
    } : {}),
    ...(service ? { service } : {}),
  };
}

/** Список эмодзи из массива ReactionType (кастомные — своим ключом). */
const emojis = (list: unknown): string[] => (Array.isArray(list) ? list as Payload[] : [])
  .map((r) => (r.type === 'emoji' ? String(r.emoji) : `custom:${String(r.custom_emoji_id)}`))
  .filter(Boolean);

/**
 * Апдейт → `{ type, msg, reaction, callback? }`.
 *
 * `type`: `message` | `edited_message` | `reaction` | `callback` | `unknown`.
 * Незнакомый тип не ошибка: он всё равно двигает offset, иначе поллер застрянет
 * на нём навсегда.
 */
export function normalizeUpdate(source: unknown): TelegramUpdate {
  const empty: TelegramUpdate = { type: 'unknown', msg: null, reaction: null };

  if (!source || typeof source !== 'object') return empty;

  const raw = source as Payload;

  if (raw.message) {
    return { type: 'message', msg: normalizeMessage(raw.message as Payload), reaction: null };
  }
  if (raw.edited_message) {
    return {
      type: 'edited_message',
      msg: normalizeMessage(raw.edited_message as Payload),
      reaction: null,
    };
  }

  // Нажатие inline-кнопки (телеграм-пульт). Разбирается в плоский контракт:
  // owner-гейту нужны from и чат, роутеру действий — data и message_id карточки.
  const cq = raw.callback_query as Payload | undefined;

  if (cq) {
    const from = cq.from as TelegramUser | undefined;
    const message = cq.message as Payload | undefined;
    const chat = message?.chat as Payload | undefined;

    return {
      type: 'callback',
      msg: null,
      reaction: null,
      callback: {
        id: String(cq.id ?? ''),
        data: typeof cq.data === 'string' ? cq.data : '',
        from: from
          ? { id: from.id ?? null, name: nameOf(from), username: from.username || '' }
          : { id: null, name: 'неизвестно', username: '' },
        chatId: (chat?.id as number) ?? null,
        chatType: (chat?.type as string) || '',
        messageId: (message?.message_id as number) ?? null,
      },
    };
  }

  const r = raw.message_reaction as Payload | undefined;

  if (r) {
    const before = emojis(r.old_reaction);
    const after = emojis(r.new_reaction);
    const chat = r.chat as Payload | undefined;
    const user = r.user as TelegramUser | undefined;
    const actor = r.actor_chat as Payload | undefined;

    return {
      type: 'reaction',
      msg: null,
      reaction: {
        chatId: (chat?.id as number) ?? null,
        chatTitle: (chat?.title as string) || '',
        messageId: r.message_id as number,
        date: r.date as number,
        from: user
          ? { id: user.id ?? null, name: nameOf(user), username: user.username || '' }
          : {
            id: (actor?.id as number) ?? null,
            name: (actor?.title as string) || 'аноним',
            username: '',
          },
        added: after.filter((e) => !before.includes(e)),
        removed: before.filter((e) => !after.includes(e)),
      },
    };
  }

  return empty;
}
