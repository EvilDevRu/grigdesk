// pult-state.json: «о чём пульт уже сказал» и message_id отправленных карточек.
//
// Живёт в `telegram/accounts/<accountRef>/` рядом с остальными account-owned
// stores. Смысл файла — пережить рестарт сервера: первый обход после старта
// сверяется с ним и не спамит заново, а карточку ушедшего повода есть чем
// отредактировать (message_id). Потеря файла безопасна: следующий silent-снимок
// восстановит дедуп, лишних отправок не будет — поэтому битый файл читается как
// чистое состояние с warn, а не роняет пульт. Вотчер помечает каждую карточку
// ownerKey: message_id имеет смысл только для той же подтверждённой лички.
import {
  TelegramAccountBindingsError,
  atomicWriteTelegramJson,
  readTelegramJsonNoFollow,
} from '../account-bindings.js';

/** Потолок карточек в состоянии: страховка от бесконечного роста, не рабочий лимит. */
export const PULT_STATE_MAX_CARDS = 500;

const KEY_MAX_CHARS = 200;

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
  return structuredClone(value);
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

  /** Битый или чужой файл — warn и чистое состояние: теряется дедуп, не пульт. */
  async read() {
    let raw = null;
    try {
      raw = await readTelegramJsonNoFollow(this.file);
    } catch (err) {
      if (!(err instanceof TelegramAccountBindingsError)) throw err;
      this.log.warn?.({ code: err.code }, `telegram-pult: state нечитаем, начинаю с чистого (${this.file})`);
      return { cards: {} };
    }
    if (raw === null) return { cards: {} };
    const cards = raw.version === 1 ? cleanCards(raw.cards) : null;
    if (cards === null) {
      this.log.warn?.('telegram-pult: state не по схеме, начинаю с чистого');
      return { cards: {} };
    }
    return { cards };
  }

  async write({ cards } = {}) {
    const clean = cleanCards(cards);
    if (clean === null) throw new TypeError('TelegramPultStateStore.write: cards не по контракту.');
    let entries = Object.entries(clean);
    if (entries.length > PULT_STATE_MAX_CARDS) {
      entries = entries
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, PULT_STATE_MAX_CARDS);
    }
    const persisted = { version: 1, cards: Object.fromEntries(entries) };
    return this._queued(async () => {
      await atomicWriteTelegramJson(this.file, persisted);
      return { cards: structuredClone(persisted.cards) };
    });
  }
}

export default TelegramPultStateStore;
