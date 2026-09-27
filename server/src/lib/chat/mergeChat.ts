// Слияние двух копий одного чата: той, что лежит на диске, и той, что прислало окно.
//
// Зачем. Историю пишет КЛИЕНТ и присылает чат целиком (`PUT /api/chat/store/chat`), а окон
// у одного человека несколько (компьютер + планшет). Расходятся они по SSE `chat-store`,
// но окно может отстать — потерять SSE, уснуть, оказаться на адресе, с которого события
// больше не идут. Отставшее окно при ближайшем сохранении клало свою устаревшую копию
// поверх свежей, и ответы агента, уже дошедшие до другого устройства, исчезали насовсем.
//
// Правило. Сервер — владелец истории и НЕ ТЕРЯЕТ СООБЩЕНИЙ. Присланная лента может только
// дополнять серверную; всё, чего в ней нет, остаётся на месте. Единственное исключение —
// осознанная очистка чата человеком (пустая лента), см. mergeChat.
//
// Почему не «кто свежее по updatedAt, тот и прав»: у отставшего окна время как раз может
// быть свежее (человек продолжает печатать в него), а ленты при этом расходятся хвостами.
// Сравниваем сами сообщения, а не отметки времени.

/**
 * Опознание сообщения. Ни у одного сообщения нет собственного id (`pid` есть только у тех,
 * что приехали через chats/pending), поэтому сличаем по роли и тексту — этого достаточно:
 * ленту мы сравниваем позиционно, а не как множество.
 */
// Сообщение ленты: у него нет собственного id, поэтому сравниваем роль и текст.
export interface ChatMessage {
  role?: string;
  text?: unknown;
  [field: string]: unknown;
}

// Чат целиком: серверные поля состояния агента перечислены в AGENT_KEYS ниже.
export interface ChatRecord {
  messages?: ChatMessage[];
  updatedAt?: number;
  createdAt?: number;
  title?: string;
  [field: string]: unknown;
}

function keyOf(m: ChatMessage | undefined): string {
  return `${m?.role || ''}\0${m?.text || ''}`;
}

/**
 * Пришёл ли после позиции `i` ответ агента — раньше, чем человек задал следующий вопрос.
 *
 * Служебные пометки («контекст сжат») и другие метки обрыва прозрачны: они не отвечают
 * на вопрос и не задают новый.
 */
function answeredAfter(msgs: ChatMessage[], i: number): boolean {
  for (let j = i + 1; j < msgs.length; j += 1) {
    const r = msgs[j]?.role;
    if (r === 'user') return false;                       // человек переспросил — ход правда падал
    if (r && r !== 'error' && r !== 'note') return true;  // агент ответил
  }
  return false;                                           // ход ещё идёт — метку пока не трогаем
}

/**
 * Метка «⚠ Failed to fetch», за которой стоит ответ агента, — это не провал хода, а обрыв
 * связи ОДНОГО окна: ход шёл на сервере дальше и ответ доехал (через chats/pending). После
 * настоящего провала агент не заговорил бы сам — человеку пришлось бы переспросить, и между
 * меткой и ответом стоял бы `user`. Поэтому чистим по позиции в ленте, а не по тексту
 * ошибки: гадать по сообщениям браузеров («Failed to fetch», «Load failed», «NetworkError»)
 * ненадёжно. Последовательность `user → ⚠ ошибка → ответ` означает успешный ход с локальным
 * обрывом связи, поэтому промежуточную ошибку убираем.
 */
function dropStaleErrors(list: unknown): { messages: ChatMessage[]; dropped: number } {
  const msgs: ChatMessage[] = Array.isArray(list) ? list : [];
  const out: ChatMessage[] = [];
  let dropped = 0;
  for (let i = 0; i < msgs.length; i += 1) {
    const message = msgs[i];
    if (!message) continue;
    if (message.role === 'error' && answeredAfter(msgs, i)) { dropped += 1; continue; }
    out.push(message);
  }
  return dropped ? { messages: out, dropped } : { messages: msgs, dropped: 0 };
}

/** Длина совпадающего начала двух лент. */
function commonPrefix(a: ChatMessage[], b: ChatMessage[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && keyOf(a[i]) === keyOf(b[i])) i += 1;
  return i;
}

/**
 * Слияние лент сообщений.
 *
 * Совпадающее начало общее, дальше ленты разошлись: серверный хвост сохраняем целиком,
 * из клиентского добавляем только то, чего в серверном нет. Кратность учитываем (человек
 * мог дважды отправить одно и то же слово), поэтому вычитаем по счётчику, а не по Set.
 *
 * `restored` — сколько серверных сообщений уцелело бы иначе стёртыми,
 * `dropped` — сколько клиентских меток об обрыве связи выброшено (см. ниже).
 */
export function mergeMessages(base: unknown = [], incoming: unknown = []): {
  messages: ChatMessage[];
  restored: number;
  dropped: number;
} {
  const left: ChatMessage[] = Array.isArray(base) ? base : [];
  const right: ChatMessage[] = Array.isArray(incoming) ? incoming : [];
  const p = commonPrefix(left, right);
  const tailBase = left.slice(p);
  const tailIncoming = right.slice(p);

  // Ничего не разошлось — обычное дополнение ленты, отдаём присланное как есть.
  if (!tailBase.length) return { messages: right, restored: 0, dropped: 0 };

  // Ход дошёл до сервера и ответ уже в серверном хвосте — значит «⚠ Failed to fetch»
  // в клиентском хвосте не про разговор, а про сеть того окна: ответ ему просто не
  // доехал. В общей истории такой метке не место, иначе на всех устройствах ход
  // выглядит проваленным при живом ответе.
  const answered = tailBase.some((m) => m?.role && m.role !== 'error' && m.role !== 'user');

  const counts = new Map<string, number>();
  for (const m of tailBase) {
    const k = keyOf(m);
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  const extra: ChatMessage[] = [];
  let dropped = 0;
  for (const m of tailIncoming) {
    if (answered && m?.role === 'error') { dropped += 1; continue; }
    const k = keyOf(m);
    const n = counts.get(k) || 0;
    if (n > 0) { counts.set(k, n - 1); continue; } // это же сообщение уже есть в серверном хвосте
    extra.push(m);
  }

  return {
    messages: [...confirmedDeliveries(left, right, p), ...extra],
    restored: tailBase.length,
    dropped,
  };
}

/**
 * В совпавшем начале лент остаются серверные копии сообщений. Отметка «приём хода не
 * подтверждён» (`delivery`) при этом монотонна: если окно уже сняло её со своей копии
 * той же реплики (тот же turnId), отставшая серверная не имеет права её вернуть —
 * иначе у отвеченного сообщения снова висело бы «отправляется».
 */
function confirmedDeliveries(left: ChatMessage[], right: ChatMessage[], prefix: number): ChatMessage[] {
  let changed = false;
  const out = left.map((message, index) => {
    const incoming = right[index];

    if (index >= prefix || !message?.delivery || incoming?.delivery) {
      return message;
    }
    if (!message.turnId || incoming?.turnId !== message.turnId) {
      return message;
    }

    const { delivery: _delivery, outbox: _outbox, ...confirmed } = message;

    changed = true;

    return confirmed;
  });

  return changed ? out : left;
}

// Поля, которые описывают состояние агента, а не окно: отставшая копия ломает ими живой
// разговор (старый sessionId уводит агента в забытую сессию, старый счётчик контекста
// врёт про кольцо, потерянный pendingSeed — это потерянная память после сжатия).
const AGENT_KEYS = [
  'sessionId',
  'contextTokens',
  'contextWindow',
  'contextMetric',
  'contextIsEstimate',
  'totalInputTokens',
  'cachedInputTokens',
  'contextCache',
  'pendingSeed',
  'compactedAt',
];

/**
 * Слияние чата целиком: `base` — копия с диска (null, если чат сохраняется впервые),
 * `incoming` — то, что прислало окно. Пустая лента сокращает историю только после
 * совпавшей revision: stale окно не является подтверждением очистки.
 */
export function mergeChat(
  base: ChatRecord | null | undefined,
  incoming: ChatRecord | null | undefined,
  { allowClear = true } = {},
): { chat: ChatRecord | null | undefined; restored: number; dropped: number } {
  if (!incoming) return { chat: incoming, restored: 0, dropped: 0 };
  // Сливать не с чем (чат сохраняется впервые), но метки обрыва снять всё равно надо:
  // первый ход нового чата обрывается ровно так же, как любой другой.
  if (!base) {
    const clean = dropStaleErrors(incoming.messages);
    return {
      chat: clean.dropped ? { ...incoming, messages: clean.messages } : incoming,
      restored: 0,
      dropped: clean.dropped,
    };
  }

  // Пустая лента — это «Очистить чат» из меню, единственное осознанное сокращение
  // истории в интерфейсе (отдельные сообщения удалять нельзя). Но пустой снимок
  // другого окна может предшествовать уже записанному ходу: без совпавшей revision
  // он только восстанавливает серверную ленту, а не выдаёт себя за явную очистку.
  if (!Array.isArray(incoming.messages) || !incoming.messages.length) {
    if (allowClear) return { chat: incoming, restored: 0, dropped: 0 };
    const messages = Array.isArray(base.messages) ? base.messages : [];
    const chat: ChatRecord = { ...incoming, messages };
    // Это не пользовательский reset, а stale CAS: вместе с историей сохраняем
    // server-fresher session/context state независимо от client updatedAt.
    for (const key of AGENT_KEYS) if (base[key] !== undefined) chat[key] = base[key];
    chat.updatedAt = Math.max(base.updatedAt || 0, incoming.updatedAt || 0) || incoming.updatedAt;
    if (base.createdAt) chat.createdAt = Math.min(base.createdAt, incoming.createdAt || base.createdAt);
    if (!chat.title && base.title) chat.title = base.title;
    return {
      chat,
      restored: messages.length,
      dropped: 0,
    };
  }

  // Метки обрыва снимаем ДО сравнения лент: иначе почищенная серверная копия и присланная
  // клиентом (старое окно шлёт метки до сих пор — фронт у него из кэша PWA) разойдутся на
  // первой же метке, и весь хвост уехал бы в «добавить», вернув метку обратно.
  const cleanBase = dropStaleErrors(base.messages);
  const cleanIncoming = dropStaleErrors(incoming.messages);
  const { messages: joined, restored, dropped } = mergeMessages(cleanBase.messages, cleanIncoming.messages);
  // И ещё раз по итогу: метка могла ждать в конце серверной ленты, пока ход шёл, — вот
  // сейчас с этим сохранением и приехал ответ на неё.
  const final = dropStaleErrors(joined);
  const chat: ChatRecord = { ...incoming, messages: final.messages };

  // Состояние агента берём у той копии, что новее: см. AGENT_KEYS.
  const fresher = (base.updatedAt || 0) > (incoming.updatedAt || 0) ? base : incoming;
  for (const k of AGENT_KEYS) if (fresher[k] !== undefined) chat[k] = fresher[k];

  chat.updatedAt = Math.max(base.updatedAt || 0, incoming.updatedAt || 0) || incoming.updatedAt;
  if (base.createdAt) chat.createdAt = Math.min(base.createdAt, incoming.createdAt || base.createdAt);
  // Заголовок чату даёт хук по первому ходу; пустой строкой его не затираем.
  if (!chat.title && base.title) chat.title = base.title;

  return {
    chat,
    restored,
    dropped: dropped + cleanBase.dropped + cleanIncoming.dropped + final.dropped,
  };
}
