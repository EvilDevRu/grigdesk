// pult-state.json: «о чём пульт уже сказал» и message_id отправленных сообщений.
//
// Живёт в `telegram/accounts/<accountRef>/` рядом с остальными account-owned
// stores. Смысл файла — пережить рестарт сервера: первый обход после старта
// сверяется с ним и не спамит заново, а карточку ушедшего повода есть чем
// отредактировать (message_id). Потеря файла безопасна: следующий silent-снимок
// восстановит дедуп, лишних отправок не будет — поэтому битый файл читается как
// чистое состояние с warn, а не роняет пульт. Вотчер помечает каждую карточку
// ownerKey: message_id имеет смысл только для той же подтверждённой лички.
//
// Схема v3: { cards, screen, sent, turns }.
//  - cards  — карточки вотчера (поводы и прогоны);
//  - screen — единственный экран навигации пульта (список/задача/узлы/план/help);
//  - sent   — реестр служебных (эфемерных) ответов, которые сносит /clean;
//  - turns  — короткие маркеры принятых ходов ассистента без текста и токенов.
// Запись — merge, не replace: write({...}) принимает любое подмножество полей,
// слияние идёт от СВЕЖЕГО содержимого файла внутри очереди (вотчер пишет cards,
// действия — screen/sent, чужие поля не затираются). read() тоже стоит в той же
// очереди и не обгоняет стоящую запись.
import {
  TelegramAccountBindingsError,
  atomicWriteTelegramJson,
  readTelegramJsonNoFollow,
} from '../account-bindings.js';

/** Потолок карточек в состоянии: страховка от бесконечного роста, не рабочий лимит. */
export const PULT_STATE_MAX_CARDS = 500;

/** Потолок реестра служебных сообщений: старые срезаются по времени отправки. */
export const PULT_STATE_MAX_SENT = 200;

/** Ходов с одного пульта одновременно немного; потолок защищает битый state. */
export const PULT_STATE_MAX_TURNS = 32;

const KEY_MAX_CHARS = 200;
const OWNER_KEY_MAX_CHARS = 300;
const CHAT_KEY_MAX_CHARS = 300;

/** Канонический ключ привязки v3: accountRef:confirmedAtMs:chatId. */
export function encodePultOwnerKey(accountRef, confirmedAtMs, chatId) {
  return `${String(accountRef)}:${Number(confirmedAtMs)}:${Number(chatId)}`;
}

/** При чтении принимаем и прежний порядок вотчера accountRef:chatId:confirmedAtMs. */
export function pultOwnerKeyMatches(value, accountRef, confirmedAtMs, chatId) {
  const key = String(value || '');
  return key === encodePultOwnerKey(accountRef, confirmedAtMs, chatId)
    || key === `${String(accountRef)}:${Number(chatId)}:${Number(confirmedAtMs)}`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Карточка состояния. `messageId: null` законен — это «знали, но не слали»
 * (silent-снимок после старта): при уходе повода такой ключ просто забывается,
 * редактировать нечего.
 */
function cleanCard(value) {
  if (!isPlainObject(value)) return null;
  if (value.messageId !== null
      && (!Number.isSafeInteger(value.messageId) || value.messageId <= 0)) return null;
  if (!Number.isSafeInteger(value.at) || value.at <= 0) return null;
  if (value.ownerKey !== undefined
      && (typeof value.ownerKey !== 'string' || !value.ownerKey
        || value.ownerKey.length > OWNER_KEY_MAX_CHARS)) return null;
  const replyAction = value.replyAction === undefined ? undefined : cleanReplyAction(value.replyAction);
  if (value.replyAction !== undefined && replyAction === null) return null;
  const card = structuredClone(value);
  if (replyAction !== undefined) card.replyAction = replyAction;
  return card;
}

function cleanReplyAction(value) {
  if (!isPlainObject(value)) return null;
  if (value.kind === 'gate-reject') {
    const taskId = String(value.taskId || '');
    const gateKey = String(value.gateKey || '');
    if (!/^\d{1,19}$/u.test(taskId) || !/^[A-Z][A-Z0-9_]{0,48}$/u.test(gateKey)) return null;
    return { kind: value.kind, taskId, gateKey };
  }
  if (value.kind === 'question-text' || value.kind === 'perm-deny') {
    const pid = String(value.pid || '');
    if (!/^[A-Za-z0-9-]{1,40}$/u.test(pid)) return null;
    return { kind: value.kind, pid };
  }
  return null;
}

function cleanCards(raw) {
  if (!isPlainObject(raw)) return null;
  const cards = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key || key.length > KEY_MAX_CHARS) return null;
    const card = cleanCard(value);
    if (!card) return null;
    cards[key] = card;
  }
  return cards;
}

/** Экран навигации: одно сообщение на пульт, привязанное к подтверждённой личке. */
function cleanScreen(value) {
  if (value === null) return null;
  if (!isPlainObject(value)) return undefined;
  if (!Number.isSafeInteger(value.messageId) || value.messageId <= 0) return undefined;
  if (!Number.isSafeInteger(value.at) || value.at <= 0) return undefined;
  if (typeof value.ownerKey !== 'string' || !value.ownerKey
      || value.ownerKey.length > OWNER_KEY_MAX_CHARS) return undefined;
  return { messageId: value.messageId, at: value.at, ownerKey: value.ownerKey };
}

function cleanSentEntry(value) {
  if (!isPlainObject(value)) return null;
  if (!Number.isSafeInteger(value.messageId) || value.messageId <= 0) return null;
  if (!Number.isSafeInteger(value.at) || value.at <= 0) return null;
  return { messageId: value.messageId, at: value.at };
}

function cleanSent(raw) {
  if (!Array.isArray(raw)) return null;
  const sent = [];
  for (const value of raw) {
    const entry = cleanSentEntry(value);
    if (!entry) return null;
    sent.push(entry);
  }
  return sent;
}

function cleanTurn(value) {
  if (!isPlainObject(value)) return null;
  const id = String(value.id || '');
  const ownerKey = String(value.ownerKey || '');
  const chatKey = String(value.chatKey || '');
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(id)) return null;
  if (!ownerKey || ownerKey.length > OWNER_KEY_MAX_CHARS) return null;
  if (!Number.isSafeInteger(value.chatId) || value.chatId <= 0) return null;
  if (!chatKey || chatKey.length > CHAT_KEY_MAX_CHARS) return null;
  if (!Number.isSafeInteger(value.acceptedAt) || value.acceptedAt <= 0) return null;
  if (value.startedAt !== null
      && (!Number.isSafeInteger(value.startedAt) || value.startedAt <= 0)) return null;
  if (!['accepted', 'started', 'observing'].includes(value.phase)) return null;
  if (value.stopMessageId !== null
      && (!Number.isSafeInteger(value.stopMessageId) || value.stopMessageId <= 0)) return null;
  return {
    id,
    ownerKey,
    chatId: value.chatId,
    chatKey,
    acceptedAt: value.acceptedAt,
    startedAt: value.startedAt,
    phase: value.phase,
    stopMessageId: value.stopMessageId,
  };
}

function cleanTurns(raw) {
  if (!Array.isArray(raw)) return null;
  const turns = [];
  for (const value of raw) {
    const turn = cleanTurn(value);
    if (!turn) return null;
    turns.push(turn);
  }
  return turns;
}

function capCards(cards) {
  let entries = Object.entries(cards);
  if (entries.length > PULT_STATE_MAX_CARDS) {
    entries = entries
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, PULT_STATE_MAX_CARDS);
  }
  return Object.fromEntries(entries);
}

function capSent(sent) {
  if (sent.length <= PULT_STATE_MAX_SENT) return sent;
  return [...sent]
    .sort((a, b) => b.at - a.at)
    .slice(0, PULT_STATE_MAX_SENT)
    .sort((a, b) => a.at - b.at);
}

function capTurns(turns) {
  if (turns.length <= PULT_STATE_MAX_TURNS) return turns;
  return [...turns]
    .sort((a, b) => b.acceptedAt - a.acceptedAt)
    .slice(0, PULT_STATE_MAX_TURNS)
    .sort((a, b) => a.acceptedAt - b.acceptedAt);
}

const EMPTY_STATE = () => ({ cards: {}, screen: null, sent: [], turns: [] });

export class TelegramPultStateStore {
  constructor({ file, log = console } = {}) {
    if (typeof file !== 'string' || !file) {
      throw new TypeError('TelegramPultStateStore: file обязателен.');
    }
    this.file = file;
    this.log = log;
    this.queue = Promise.resolve();
  }

  _queued(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  /** Чтение с диска без очереди — внутренний шаг write (иначе дедлок). */
  async _readFromDisk() {
    let raw = null;
    try {
      raw = await readTelegramJsonNoFollow(this.file);
    } catch (err) {
      if (!(err instanceof TelegramAccountBindingsError)) throw err;
      this.log.warn?.({ code: err.code }, `telegram-pult: state нечитаем, начинаю с чистого (${this.file})`);
      return EMPTY_STATE();
    }
    if (raw === null) return EMPTY_STATE();
    // v1 принимается миграцией: экрана и реестра в нём не было.
    if (raw.version === 1) {
      const cards = cleanCards(raw.cards);
      if (cards === null) {
        this.log.warn?.('telegram-pult: state не по схеме, начинаю с чистого');
        return EMPTY_STATE();
      }
      return { cards, screen: null, sent: [], turns: [] };
    }
    if (raw.version === 2) {
      const cards = cleanCards(raw.cards);
      const screen = cleanScreen(raw.screen);
      const sent = cleanSent(raw.sent);
      if (cards === null || screen === undefined || sent === null) {
        this.log.warn?.('telegram-pult: state не по схеме, начинаю с чистого');
        return EMPTY_STATE();
      }
      return { cards, screen, sent, turns: [] };
    }
    if (raw.version === 3) {
      const cards = cleanCards(raw.cards);
      const screen = cleanScreen(raw.screen);
      const sent = cleanSent(raw.sent);
      const turns = cleanTurns(raw.turns);
      if (cards === null || screen === undefined || sent === null || turns === null) {
        this.log.warn?.('telegram-pult: state не по схеме, начинаю с чистого');
        return EMPTY_STATE();
      }
      return { cards, screen, sent, turns };
    }
    this.log.warn?.('telegram-pult: state не по схеме, начинаю с чистого');
    return EMPTY_STATE();
  }

  /** Битый или чужой файл — warn и чистое состояние: теряется дедуп, не пульт. */
  async read() {
    return this._queued(() => this._readFromDisk());
  }

  /**
   * Merge-запись: patch — любое подмножество { cards, screen, sent, turns }.
   * Слияние идёт от свежего содержимого файла внутри очереди, а не от памяти:
   * два актора (вотчер и действия) не затирают поля друг друга.
   */
  async write(patch = {}) {
    const cleanPatch = {};
    if (Object.hasOwn(patch, 'cards')) {
      const cards = cleanCards(patch.cards);
      if (cards === null) throw new TypeError('TelegramPultStateStore.write: cards не по контракту.');
      cleanPatch.cards = cards;
    }
    if (Object.hasOwn(patch, 'screen')) {
      const screen = cleanScreen(patch.screen);
      if (screen === undefined) throw new TypeError('TelegramPultStateStore.write: screen не по контракту.');
      cleanPatch.screen = screen;
    }
    if (Object.hasOwn(patch, 'sent')) {
      const sent = cleanSent(patch.sent);
      if (sent === null) throw new TypeError('TelegramPultStateStore.write: sent не по контракту.');
      cleanPatch.sent = sent;
    }
    if (Object.hasOwn(patch, 'turns')) {
      const turns = cleanTurns(patch.turns);
      if (turns === null) throw new TypeError('TelegramPultStateStore.write: turns не по контракту.');
      cleanPatch.turns = turns;
    }
    return this._queued(async () => {
      const current = await this._readFromDisk();
      const merged = {
        cards: cleanPatch.cards ?? current.cards,
        screen: Object.hasOwn(cleanPatch, 'screen') ? cleanPatch.screen : current.screen,
        sent: cleanPatch.sent ?? current.sent,
        turns: cleanPatch.turns ?? current.turns,
      };
      const persisted = {
        version: 3,
        cards: capCards(merged.cards),
        screen: merged.screen,
        sent: capSent(merged.sent),
        turns: capTurns(merged.turns),
      };
      await atomicWriteTelegramJson(this.file, persisted);
      return structuredClone({
        cards: persisted.cards,
        screen: persisted.screen,
        sent: persisted.sent,
        turns: persisted.turns,
      });
    });
  }
}

export default TelegramPultStateStore;
