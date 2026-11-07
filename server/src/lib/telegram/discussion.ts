// Вердикты разворота → блок «Обсуждение в Telegram».
//
// Один вход (то, что вернул `resolveText`) и два выхода:
//   • `links` — структура для модалки задачи: чат, тема, цитаты, вложения словами;
//   • `text`  — плоский текст для тикета конвейера, чата агента и триажа.
//
// Почему это отдельный модуль, а не кусок роута. Во-первых, потребителей четыре
// и текст у них обязан быть один: расхождение между тем, что видит человек в
// карточке, и тем, что прочитал агент, — худший сорт ошибки, потому что незаметный.
// Во-вторых, ЛИМИТ. Разворот уезжает секцией в описание тикета, а `fitDescription`
// режет описание с КОНЦА — то есть обсуждение обрезалось бы первым и молча
// (docs/grigdesk/inbox.md, раздел «Telegram»). Значит ограничивать надо здесь,
// заранее и осознанно: что именно выкинуть, знаем только мы.
//
// И граница: у отказа наружу уходит ТОЛЬКО причина. Ни текста, ни имени чужого
// чата — иначе allowlist защищал бы вид ссылки, а не содержимое переписки.
// Резолв это уже держит, здесь проверка повторная и намеренная: тут содержимое
// впервые превращается в показываемый текст, и «а давай покажем хотя бы имя
// чата» выглядит безобидно ровно до первой утечки.

/**
 * Умолчания лимитов.
 *
 * `quotes` — общий бюджет цитат на весь блок, а не на ссылку: три ссылки не
 * должны утроить разворот. `chars` — суммарный объём текста цитат (сама секция
 * выходит примерно на четверть длиннее за счёт меток времени и авторов).
 * `quoteChars` — потолок одной цитаты, чтобы простыня из чата не съела бюджет.
 */
type Payload = Record<string, unknown>;

// Сообщение так, как его читает блок обсуждения: fileId, id автора и внутренние
// поля архива сюда не выходят — наружу уезжают только слова.
interface TelegramMedia {
  kind?: string;
  name?: string;
}

interface DiscussionMessage {
  messageId?: number | null;
  date?: number | null;
  text?: string;
  from?: { name?: string };
  media?: TelegramMedia[];
}

interface DiscussionResult {
  ok?: boolean;
  reason?: string | null;
  message?: string;
  link?: { key?: string; url?: string; messageId?: number | null };
  chat?: { title?: string; username?: string } | null;
  thread?: number | null;
  target?: DiscussionMessage | null;
  messages?: DiscussionMessage[];
}

interface DiscussionQuote {
  messageId: number | null;
  at: number | null;
  author: string;
  text: string;
  media: string[];
  target: boolean;
  trimmed: boolean;
}

// Ветка, готовая к раздаче бюджета: сообщения по времени и позиция целевого.
interface PreparedBranch {
  res: DiscussionResult;
  messages: DiscussionMessage[];
  aim: number;
}

export const DISCUSSION_LIMITS = { quotes: 12, chars: 4000, quoteChars: 700 };

/**
 * Заголовок секции обсуждения — общий для всех, кто её вклеивает.
 *
 * Общий он не для красоты: тикет — снимок постановки, он замораживается при
 * запуске и дальше не пересобирается (`reuseTicket`), а разговор в чате идёт
 * своим ходом. Значит чат по задаче обязан развернуть ссылки заново, а старую
 * секцию из описания ВЫРЕЗАТЬ — иначе агент получит две версии одного
 * обсуждения и потратит контекст на выяснение, какая свежая. Вырезать можно
 * только по тому же тексту, которым секцию вклеили, — отсюда одна константа
 * вместо литерала в каждом месте.
 */
export const DISCUSSION_SECTION_TITLE =
  '[Обсуждение в Telegram — переписка по ссылкам из задачи; цитаты «← ссылка» это то, на что показывали пальцем]';

/**
 * Убрать закреплённую секцию обсуждения из текста.
 *
 * Режем от заголовка и до конца: секция по построению стоит последней
 * (`ticketSections` дописывает её после всех остальных). «До следующей секции»
 * не годится — цитаты внутри начинаются со строки вида `[01.08.2026 09:00]`,
 * то есть с той же квадратной скобки, что и заголовки соседних секций.
 */
export function stripDiscussionSection(text: unknown): string {
  const src = String(text ?? '');
  const at = src.indexOf(DISCUSSION_SECTION_TITLE);
  return at < 0 ? src : src.slice(0, at).trimEnd();
}

/** Вид вложения → слово. Наружу уходит слово, `fileId` остаётся внутри. */
const MEDIA_WORDS: Record<string, string> = {
  photo: 'фото',
  document: 'файл',
  video: 'видео',
  animation: 'гифка',
  audio: 'аудио',
  voice: 'голосовое',
  video_note: 'кружок',
  sticker: 'стикер',
};

const two = (n: number) => String(n).padStart(2, '0');

/** Метка времени в локальной зоне мозга: человек сверяет её с Телеграмом. */
function stamp(sec: unknown): string {
  const d = new Date((Number(sec) || 0) * 1000);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()} `
    + `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Вложения сообщения — словами: «фото», «файл отчёт.pdf». */
const describeMedia = (list: unknown): string[] => (
  Array.isArray(list) ? list as TelegramMedia[] : []
).map((m) => {
  const word = MEDIA_WORDS[String(m?.kind)] || 'вложение';
  const name = String(m?.name || '').trim();
  return name ? `${word} ${name}` : word;
});

/** Обрезка цитаты: по границе слова, если она рядом, иначе просто по счёту. */
function trimText(text: unknown, limit: number): { text: string; trimmed: boolean } {
  const src = String(text || '');
  if (src.length <= limit) return { text: src, trimmed: false };
  const cut = src.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return { text: `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`, trimmed: true };
}

/** Сообщение архива → цитата. Всё лишнее (fileId, id автора, чат) остаётся здесь. */
function quoteOf(msg: DiscussionMessage, { target, maxQuoteChars }: {
  target: boolean;
  maxQuoteChars: number;
}): DiscussionQuote {
  const { text, trimmed } = trimText(msg.text, maxQuoteChars);
  return {
    messageId: msg.messageId ?? null,
    at: msg.date ?? null,
    author: msg.from?.name || 'неизвестно',
    text,
    media: describeMedia(msg.media),
    target,
    trimmed,
  };
}

/** Хронологический порядок; при совпадении времени — по номеру сообщения. */
const byTime = (a: DiscussionMessage, b: DiscussionMessage) => (
  (a.date ?? 0) - (b.date ?? 0) || (a.messageId ?? 0) - (b.messageId ?? 0)
);

/**
 * Подготовка одной удачной ссылки: ветка по времени и позиция целевого в ней.
 * Целевое ищем по номеру — именно на него человек дал ссылку.
 */
function prepare(res: DiscussionResult): PreparedBranch {
  const messages = [...(res.messages || [])].sort(byTime);
  const aimId = res.target?.messageId ?? res.link?.messageId ?? null;
  let aim = messages.findIndex((m) => m.messageId === aimId);

  if (aim < 0) aim = messages.length - 1; // ветка без цели — берём последнее

  return { res, messages, aim };
}

/**
 * Соседи по ветке в порядке важности: ближайшие к целевому, при равном
 * расстоянии — те, что раньше. Предыстория объясняет жалобу лучше, чем то,
 * что написали после неё.
 */
function neighbours({ messages, aim }: PreparedBranch) {
  return messages
    .map((msg, i) => ({ msg, i }))
    .filter(({ i }) => i !== aim)
    .sort((a, b) => Math.abs(a.i - aim) - Math.abs(b.i - aim) || a.i - b.i);
}

/**
 * Раздать бюджет цитат.
 *
 * Целевые сообщения занимают места ПЕРВЫМИ и лимитом не срезаются: развернуть
 * ветку и не показать то, ради чего дали ссылку, — худшее из возможного.
 * Дальше соседи добираются по кругу между ссылками, чтобы одна длинная ветка
 * не съела разворот у остальных.
 */
function share(items: PreparedBranch[], { maxQuotes, maxChars, maxQuoteChars }: {
  maxQuotes: number;
  maxChars: number;
  maxQuoteChars: number;
}): Set<number>[] {
  const picked = items.map(() => new Set<number>());
  let count = 0;
  let chars = 0;

  items.forEach((item, n) => {
    if (!item.messages.length) return;
    picked[n]?.add(item.aim);
    count += 1;
    chars += quoteOf(
      item.messages[item.aim] as DiscussionMessage,
      { target: true, maxQuoteChars },
    ).text.length;
  });

  const queues = items.map((item) => neighbours(item));
  let alive = true;
  while (alive && count < maxQuotes) {
    alive = false;
    for (let n = 0; n < queues.length && count < maxQuotes; n += 1) {
      const next = queues[n]?.shift();

      if (!next) continue;
      alive = true;

      const len = quoteOf(next.msg, { target: false, maxQuoteChars }).text.length;

      if (chars + len > maxChars) {
        queues[n] = [];
        continue;
      }
      picked[n]?.add(next.i);
      count += 1;
      chars += len;
    }
  }

  return picked;
}

/** Шапка блока: где это сказано и куда идти читать целиком. */
function heading({ chat, thread, url }: {
  chat: { title?: string; username?: string };
  thread?: number | null;
  url: string;
}): string {
  const name = chat.title ? `«${chat.title}»` : '';
  const at = chat.username ? `@${chat.username}` : '';
  const who = [name, at].filter(Boolean).join(' ');
  const topic = thread ? `, тема ${thread}` : '';
  return `Чат ${who || 'без названия'}${topic} — ${url}`;
}

/** Цитата → строка текста. Переводы строк схлопываем: одно сообщение — одна строка. */
function line(q: DiscussionQuote): string {
  const body = q.text.replace(/\s*\n\s*/g, ' ').trim();
  const media = q.media.length ? `(${q.media.join(', ')})` : '';
  const said = [body, media].filter(Boolean).join(' ');
  return `[${stamp(q.at)}] ${q.author}: ${said}${q.target ? ' ← ссылка' : ''}`;
}

const plural = (n: number, one: string, few: string, many: string) => {
  const t = n % 100;
  if (t > 10 && t < 20) return many;
  if (n % 10 === 1) return one;
  if (n % 10 >= 2 && n % 10 <= 4) return few;
  return many;
};

/**
 * Собрать блок обсуждения.
 *
 * @param {Array} results вердикты `resolveText`
 * @param {{maxQuotes?: number, maxChars?: number, maxQuoteChars?: number}} [opts]
 * @returns {{links: Array, text: string, quotes: number, truncated: boolean}}
 */
export function buildDiscussion(results: unknown, opts: {
  maxQuotes?: number;
  maxChars?: number;
  maxQuoteChars?: number;
} = {}) {
  const maxQuotes = opts.maxQuotes ?? DISCUSSION_LIMITS.quotes;
  const maxChars = opts.maxChars ?? DISCUSSION_LIMITS.chars;
  const maxQuoteChars = opts.maxQuoteChars ?? DISCUSSION_LIMITS.quoteChars;

  // `resolveText` отдаёт по элементу на каждое вхождение ссылки — показывать
  // одну и ту же переписку дважды незачем.
  const seen = new Set<string>();
  const list = (Array.isArray(results) ? results as DiscussionResult[] : []).filter((r) => {
    const key = r?.link?.key || r?.link?.url;

    if (!key || seen.has(key)) return false;
    seen.add(key);

    return true;
  });

  const good = list.filter((r) => r.ok).map(prepare);
  const picked = share(good, { maxQuotes, maxChars, maxQuoteChars });

  const blocks: string[] = [];
  const links: Payload[] = [];
  let quotes = 0;
  let truncated = false;
  let g = 0;

  for (const res of list) {
    const url = res.link?.url || '';

    if (!res.ok) {
      // Только причина: ни chat, ни quotes здесь нет и появиться не должно.
      links.push({ url, ok: false, reason: res.reason || 'unknown', message: res.message || '' });
      blocks.push([`Ссылка не раскрыта — ${url}`, res.message || ''].filter(Boolean).join('\n'));
      continue;
    }

    const item = good[g] as PreparedBranch;
    const take = picked[g] as Set<number>;

    g += 1;

    const shown = item.messages
      .map((msg, i) => (
        take.has(i) ? quoteOf(msg, { target: i === item.aim, maxQuoteChars }) : null
      ))
      .filter((quote): quote is DiscussionQuote => Boolean(quote));
    const more = item.messages.length - shown.length;

    quotes += shown.length;
    if (more > 0 || shown.some((q) => q.trimmed)) truncated = true;

    links.push({
      url,
      ok: true,
      chat: { title: res.chat?.title || '', username: res.chat?.username || '' },
      thread: res.thread ?? null,
      quotes: shown,
      more,
    });

    const tail = more > 0
      ? `…ещё ${more} ${plural(more, 'сообщение', 'сообщения', 'сообщений')} ветки `
        + `${plural(more, 'не показано', 'не показаны', 'не показаны')} (лимит разворота).`
      : '';
    blocks.push([
      heading({ chat: res.chat || {}, thread: res.thread ?? null, url }),
      ...shown.map(line),
      tail,
    ].filter(Boolean).join('\n'));
  }

  return { links, text: blocks.join('\n\n'), quotes, truncated };
}
