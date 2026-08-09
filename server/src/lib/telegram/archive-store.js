// Архив входящих: append-only NDJSON, файл на чат и месяц.
//
//   telegram/accounts/<accountRef>/archive/<chatId>/YYYY-MM.ndjson
//   telegram/accounts/<accountRef>/archive/chats.json — снимок карты чатов
//
// Главное правило (грабли «фризы при наборе в чате»): горячая операция не имеет
// права дорожать от размера архива. Поэтому:
//  • приём сообщения — это `appendFile` одной строки, файл месяца не переписывается;
//  • достать сообщение — чтение по (смещение, длина) из индекса, а не разбор месяца;
//  • правка не ищет старую строку, а дописывает новую версию — при чтении
//    побеждает последняя.
// Единственный полный проход по файлам месяца — построение индекса при первом
// обращении к чату после старта; дальше он живёт в памяти.
//
// SQLite сознательно не берём: архив должен читаться глазами и `grep`-ом,
// переживать копирование каталога и не тянуть за собой нативный модуль.
import {
  appendFile, lstat, mkdir, open, readFile, readdir, rename, stat, writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const NL = 0x0a;
const POSITION_KEYS = [
  'schemaVersion', 'seq', 'firstSeq', 'occurredAt', 'chatId', 'chatUsername',
  'threadId', 'messageId', 'file', 'offset', 'length',
];

export class TelegramArchiveSequenceError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TelegramArchiveSequenceError';
    this.code = code;
  }
}

const sequenceFail = (code, message, cause = null) => {
  throw new TelegramArchiveSequenceError(code, message, cause);
};

const semanticKey = (chatId, messageId) => JSON.stringify([chatId, messageId]);

function positiveSafe(value, where) {
  if (!Number.isSafeInteger(value) || value < 1) {
    sequenceFail('telegram_archive_position_invalid', `${where}: ожидалось положительное целое.`);
  }
  return value;
}

function integerId(value, where, { positive = false, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || (positive ? value < 1 : value === 0)) {
    sequenceFail('telegram_archive_position_invalid', `${where}: неверный Telegram id.`);
  }
  return value;
}

function nonNegativeSafe(value, where) {
  if (!Number.isSafeInteger(value) || value < 0) {
    sequenceFail('telegram_archive_position_invalid', `${where}: ожидалось неотрицательное целое.`);
  }
  return value;
}

function exactPosition(raw, line) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    sequenceFail('telegram_archive_position_invalid', `Telegram position line ${line}: ожидался объект.`);
  }
  const actual = Object.keys(raw).sort();
  const expected = [...POSITION_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    sequenceFail(
      'telegram_archive_position_invalid',
      `Telegram position line ${line}: поля не совпадают со schema v1.`,
    );
  }
  if (raw.schemaVersion !== 1) {
    sequenceFail('telegram_archive_position_invalid', `Telegram position line ${line}: неизвестная schema.`);
  }
  const seq = positiveSafe(raw.seq, `position[${line}].seq`);
  const firstSeq = raw.firstSeq === null
    ? null
    : positiveSafe(raw.firstSeq, `position[${line}].firstSeq`);
  if (firstSeq !== null && firstSeq > seq) {
    sequenceFail('telegram_archive_position_invalid', `position[${line}].firstSeq позже seq.`);
  }
  const chatId = integerId(raw.chatId, `position[${line}].chatId`);
  const messageId = integerId(raw.messageId, `position[${line}].messageId`, { positive: true });
  const threadId = integerId(raw.threadId, `position[${line}].threadId`, {
    positive: true,
    nullable: true,
  });
  if (typeof raw.chatUsername !== 'string' || Buffer.byteLength(raw.chatUsername, 'utf8') > 256) {
    sequenceFail('telegram_archive_position_invalid', `position[${line}].chatUsername невалиден.`);
  }
  const file = `${chatId}/${archiveMonth(raw.occurredAt)}.ndjson`;
  if (raw.file !== file) {
    sequenceFail('telegram_archive_position_invalid', `position[${line}].file неканоничен.`);
  }
  return {
    schemaVersion: 1,
    seq,
    firstSeq,
    occurredAt: nonNegativeSafe(raw.occurredAt, `position[${line}].occurredAt`),
    chatId,
    chatUsername: raw.chatUsername,
    threadId,
    messageId,
    file,
    offset: nonNegativeSafe(raw.offset, `position[${line}].offset`),
    length: positiveSafe(raw.length, `position[${line}].length`),
  };
}

/** Месяц архива по дате сообщения (секунды Bot API), всегда UTC. */
export function archiveMonth(dateSec) {
  const d = new Date(Number(dateSec || 0) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export class TelegramArchiveStore {
  /**
   * @param {{dir: string, log?: object, inboxSequence?: boolean}} opts
   * `dir` — корень account namespace. `inboxSequence` включает отдельный
   * metadata-only ingestion journal для общего Inbox.
   */
  constructor({ dir, log = console, inboxSequence = false }) {
    this.root = path.join(dir, 'archive');
    this.chatsFile = path.join(this.root, 'chats.json');
    this.positionsFile = path.join(this.root, '.inbox-sequence.ndjson');
    this.log = log;
    this.inboxSequence = inboxSequence === true;
    /** чат → Map(messageId → {file, offset, length, date, service, thread, threadTitle, threadTitleSource, reply}) */
    this.index = new Map();
    /** чат → обещание построения индекса (чтобы не сканировать вдвоём) */
    this.indexing = new Map();
    /** чат → {id, title, username, type, isForum, lastAt} */
    this.meta = new Map();
    /** путь файла → его размер в байтах (чтобы не звать stat на каждую строку) */
    this.sizes = new Map();
    /** чат → очередь записи: два одновременных append дали бы одинаковый offset */
    this.queues = new Map();
    this.snapshot = null; // прочитанный chats.json
    this.sequenceQueue = Promise.resolve();
    this.positionIndex = null;
    this.positionLoading = null;
    this.positionHead = 0;
  }

  chatDir(chatId) { return path.join(this.root, String(chatId)); }

  fileFor(chatId, dateSec) {
    return path.join(this.chatDir(chatId), `${archiveMonth(dateSec)}.ndjson`);
  }

  /** Дописывает сообщение. Возвращает, куда именно легла строка. */
  async append(msg) {
    if (this.inboxSequence) {
      return this._sequenceQueued(() => this._appendSequenced(msg));
    }
    return this._appendNative(msg);
  }

  async _appendNative(msg) {
    const chatId = msg.chatId;
    return this._queued(chatId, async () => {
      await this._ensureIndex(chatId);
      const file = this.fileFor(chatId, msg.date);
      const line = `${JSON.stringify(msg)}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      const offset = this.sizes.get(file) ?? 0;

      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, line, 'utf8');
      this.sizes.set(file, offset + bytes);

      const at = {
        file, offset, length: bytes - 1, date: msg.date, service: msg.service || null,
        thread: msg.threadId ?? null,
        threadTitle: msg.threadTitle || '',
        threadTitleSource: msg.threadTitleSource || '',
        reply: msg.replyToMessageId ?? null,
      };
      this.index.get(chatId).set(msg.messageId, at);
      this._touchMeta(msg);
      return { file, offset, length: at.length };
    });
  }

  /**
   * Cursor/meta boundary общего Inbox. Метод никогда не открывает native rows с text.
   */
  async head() {
    this._requireInboxSequence();
    return this._sequenceQueued(async () => {
      await this._ensurePositionIndex();
      return this.positionHead;
    });
  }

  /**
   * Строго возрастающие semantic first-ingress positions без текста сообщений.
   * Исторические rows без position journal здесь не появляются.
   */
  async listInboxPositions({ afterSeq = 0, throughSeq = null, limit = 1000 } = {}) {
    this._requireInboxSequence();
    nonNegativeSafe(afterSeq, 'afterSeq');
    if (throughSeq !== null) nonNegativeSafe(throughSeq, 'throughSeq');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      sequenceFail('telegram_archive_position_request_invalid', 'limit должен быть 1..10000.');
    }
    await this._ensurePositionIndex();
    const upper = throughSeq ?? Number.MAX_SAFE_INTEGER;
    return [...this.positionIndex.values()]
      .filter((entry) => entry.firstSeq !== null
        && entry.firstSeq > afterSeq && entry.firstSeq <= upper)
      .sort((left, right) => left.firstSeq - right.firstSeq
        || left.chatId - right.chatId || left.messageId - right.messageId)
      .slice(0, limit)
      .map((entry) => ({
        seq: entry.firstSeq,
        occurredAt: entry.occurredAt,
        revisionSeq: entry.seq,
        chatId: entry.chatId,
        chatUsername: entry.chatUsername,
        threadId: entry.threadId,
        messageId: entry.messageId,
      }));
  }

  /** Native text читается только после того, как adapter проверил metadata allowlist. */
  async readInboxPosition(position) {
    this._requireInboxSequence();
    if (!position || typeof position !== 'object' || Array.isArray(position)) {
      sequenceFail('telegram_archive_position_request_invalid', 'Inbox position должна быть объектом.');
    }
    await this._ensurePositionIndex();
    const key = semanticKey(position.chatId, position.messageId);
    const entry = this.positionIndex.get(key);
    if (!entry || entry.firstSeq !== position.seq || entry.seq !== position.revisionSeq
        || entry.occurredAt !== position.occurredAt
        || entry.chatUsername !== position.chatUsername
        || entry.threadId !== position.threadId) {
      sequenceFail(
        'telegram_archive_position_changed',
        'Telegram Inbox position изменилась между metadata scan и чтением snapshot.',
      );
    }
    const snapshot = await this._readAtStrict({
      file: path.join(this.root, entry.file),
      offset: entry.offset,
      length: entry.length,
    });
    if (snapshot.chatId !== entry.chatId || snapshot.messageId !== entry.messageId
        || snapshot.date !== entry.occurredAt
        || (snapshot.chatUsername || '') !== entry.chatUsername
        || (snapshot.threadId ?? null) !== entry.threadId) {
      sequenceFail(
        'telegram_archive_position_mismatch',
        'Telegram native snapshot не совпадает со своим ingestion position.',
      );
    }
    return snapshot;
  }

  /** Где лежит последняя версия сообщения; `null`, если такого нет. */
  async locate(chatId, messageId) {
    await this._ensureIndex(chatId);
    const at = this.index.get(chatId).get(messageId);
    return at ? { file: at.file, offset: at.offset, length: at.length } : null;
  }

  /** Сообщение по (чат, id) — одно чтение по смещению. */
  async read(chatId, messageId) {
    const at = await this.locate(chatId, messageId);
    return at ? this._readAt(at) : null;
  }

  /**
   * Хвост обсуждения по возрастанию времени.
   * Служебные сообщения (вход бота, смена названия) в ленту не идут — они
   * хранятся, но читать их человеку незачем; `{ service: true }` их вернёт.
   */
  async tail(chatId, { limit = 50, service = false } = {}) {
    await this._ensureIndex(chatId);
    const rows = [...this.index.get(chatId).entries()]
      .filter(([, at]) => service || !at.service)
      .sort((a, b) => (a[1].date - b[1].date) || (a[0] - b[0]))
      .slice(-Math.max(0, limit));
    const out = [];
    for (const [, at] of rows) {
      const msg = await this._readAt(at);
      if (msg) out.push(msg);
    }
    return out;
  }

  /**
   * Ветка вокруг сообщения: окно соседей + родители по реплаю.
   *
   * Это ответ на «покажи обсуждение», а не «покажи сообщение»: цитируют обычно
   * вывод, а понять его можно только вместе с тем, из чего он вырос. Поэтому две
   * добавки к цитируемому сообщению, и обе обязательны:
   *  • окно соседей по времени — разговор вокруг;
   *  • цепочка родителей по реплаю — даже если окно до них не достаёт, иначе
   *    ответ повисает в воздухе.
   *
   * Тема форума — жёсткая граница: соседняя тема может принадлежать другому
   * проекту (правило доступа заводится на тему), и подмешивать её нельзя.
   *
   * @returns {Promise<{target: object, messages: object[], thread: number|null}|null>}
   *   `null`, если сообщения в архиве нет вовсе.
   */
  async branch(chatId, messageId, { before = 20, after = 20 } = {}) {
    await this._ensureIndex(chatId);
    const idx = this.index.get(chatId);
    const at = idx?.get(messageId);
    if (!at) return null;

    const thread = at.thread ?? null;
    const rows = [...idx.entries()]
      .filter(([id, e]) => id === messageId || (!e.service && (e.thread ?? null) === thread))
      .sort((a, b) => (a[1].date - b[1].date) || (a[0] - b[0]));

    const pos = rows.findIndex(([id]) => id === messageId);
    const picked = new Map(rows.slice(Math.max(0, pos - Math.max(0, before)), pos + Math.max(0, after) + 1));

    let cur = at;
    const seen = new Set([messageId]);
    while (cur?.reply != null && !seen.has(cur.reply)) {
      seen.add(cur.reply);
      const parent = idx.get(cur.reply);
      // Родителя из чужой темы не берём — граница доступа проходит по теме.
      if (!parent || (parent.thread ?? null) !== thread) break;
      picked.set(cur.reply, parent);
      cur = parent;
    }

    const order = [...picked.entries()].sort((a, b) => (a[1].date - b[1].date) || (a[0] - b[0]));
    const messages = [];
    let target = null;
    for (const [id, entry] of order) {
      const msg = await this._readAt(entry);
      if (!msg) continue;
      messages.push(msg);
      if (id === messageId) target = msg;
    }
    return target ? { target, messages, thread } : null;
  }

  /**
   * Числовой id чата по его публичному имени; `null`, если такого не слышали.
   * Нужен резолву ссылок вида `t.me/<имя>/<N>`: в архиве чат лежит под числовым
   * id, а ссылка называет имя.
   */
  async chatIdOf(username) {
    const want = String(username || '').replace(/^@/, '').trim().toLowerCase();
    if (!want) return null;
    const hit = (await this.chats()).find((c) => (c.username || '').toLowerCase() === want);
    return hit ? hit.id : null;
  }

  /** Карта чатов для привязки к проектам: заголовок, сколько сообщений, когда последнее. */
  async chats() {
    const snapshot = await this._snapshot();
    const ids = new Set([...this.meta.keys(), ...Object.keys(snapshot).map(Number)]);
    for (const id of await this._chatDirs()) ids.add(id);

    const out = [];
    for (const id of ids) {
      // Про чат, о котором мы ничего не помним и снимок молчит, спрашиваем диск.
      if (!this.meta.has(id) && !snapshot[id]) await this._ensureIndex(id);
      const meta = this.meta.get(id) || snapshot[id];
      if (!meta) continue;
      const messages = this.index.has(id) ? this.index.get(id).size : (meta.messages ?? 0);
      if (!messages) continue;
      out.push({
        id,
        title: meta.title || '',
        username: meta.username || '',
        type: meta.type || '',
        isForum: !!meta.isForum,
        messages,
        lastAt: meta.lastAt ?? null,
      });
    }
    return out.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  }

  /**
   * Темы форума, которые бот уже слышал в конкретном чате.
   *
   * HTTP Bot API не умеет перечислять все темы. Зато `message_thread_id`
   * приходит с каждым сообщением, поэтому индекс архива даёт полный список
   * реально увиденных тем без чтения тел сообщений. Название берётся из
   * служебного события создания/переименования, а корень темы служит запасным
   * источником для форумов, куда бота добавили позже.
   */
  async topics(chatId) {
    const id = Number(chatId);
    if (!Number.isSafeInteger(id) || id === 0) return [];
    await this._ensureIndex(id);

    const found = new Map();
    for (const at of this.index.get(id)?.values() || []) {
      const threadId = Number(at.thread);
      if (!Number.isSafeInteger(threadId) || threadId <= 0) continue;

      const prev = found.get(threadId) || {
        id: threadId,
        title: '',
        titleSource: '',
        titleAt: 0,
        messages: 0,
        lastAt: null,
      };
      const source = at.threadTitleSource || '';
      const title = String(at.threadTitle || '').trim();
      const authoritative = source === 'event';
      const previousAuthoritative = prev.titleSource === 'event';
      if (title && (
        (!previousAuthoritative && authoritative)
        || (previousAuthoritative === authoritative && Number(at.date || 0) >= prev.titleAt)
      )) {
        prev.title = title;
        prev.titleSource = source;
        prev.titleAt = Number(at.date || 0);
      }
      if (!at.service) prev.messages += 1;
      prev.lastAt = Math.max(prev.lastAt || 0, Number(at.date || 0)) || null;
      found.set(threadId, prev);
    }

    return [...found.values()]
      .sort((a, b) => ((b.lastAt || 0) - (a.lastAt || 0)) || (a.id - b.id))
      .map(({ titleSource, titleAt, ...topic }) => topic);
  }

  /** Кладёт карту чатов на диск: следующему запуску не придётся сканировать месяцы. */
  async flush() {
    if (!this.meta.size) return;
    const data = {};
    for (const [id, meta] of this.meta) {
      data[id] = { ...meta, messages: this.index.get(id)?.size ?? 0 };
    }
    await mkdir(this.root, { recursive: true });
    const tmp = `${this.chatsFile}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(tmp, this.chatsFile);
    this.snapshot = data;
  }

  // --- внутреннее ---

  _requireInboxSequence() {
    if (!this.inboxSequence) {
      sequenceFail(
        'telegram_archive_sequence_disabled',
        'Account-aware Inbox sequence не включена для этого Telegram archive.',
      );
    }
  }

  _sequenceQueued(operation) {
    const result = this.sequenceQueue.then(operation, operation);
    this.sequenceQueue = result.catch(() => {});
    return result;
  }

  async _appendSequenced(msg) {
    await this._ensurePositionIndex();
    const chatId = integerId(msg?.chatId, 'message.chatId');
    const messageId = integerId(msg?.messageId, 'message.messageId', { positive: true });
    const occurredAt = nonNegativeSafe(msg?.date, 'message.date');
    const threadId = integerId(msg?.threadId ?? null, 'message.threadId', {
      positive: true,
      nullable: true,
    });
    const chatUsername = msg?.chatUsername || '';
    if (typeof chatUsername !== 'string' || Buffer.byteLength(chatUsername, 'utf8') > 256) {
      sequenceFail('telegram_archive_position_invalid', 'message.chatUsername невалиден.');
    }

    const key = semanticKey(chatId, messageId);
    const previous = this.positionIndex.get(key) || null;
    if (previous && previous.occurredAt !== occurredAt) {
      sequenceFail(
        'telegram_archive_position_conflict',
        'Повтор Telegram message изменил immutable provider occurrence time.',
      );
    }

    // Если semantic message уже лежал в истории без journal, его новая
    // правка не имеет права превратить историю в post-activation intake.
    const historical = previous === null && await this.locate(chatId, messageId) !== null;
    const seq = this.positionHead + 1;
    const firstSeq = previous ? previous.firstSeq : (historical ? null : seq);
    const at = await this._appendNative(msg);
    const relativeFile = path.relative(this.root, at.file).split(path.sep).join('/');
    const entry = exactPosition({
      schemaVersion: 1,
      seq,
      firstSeq,
      occurredAt,
      chatId,
      chatUsername,
      threadId,
      messageId,
      file: relativeFile,
      offset: at.offset,
      length: at.length,
    }, seq);

    // Native row пишется первой. Если metadata commit сорвётся, poller не двинет
    // offset, а retry увидит уже существующую native row и fail-closed оставит её
    // history (firstSeq=null), вместо возможного admission через неверную границу.
    await this._appendPosition(entry);
    this.positionIndex.set(key, entry);
    this.positionHead = seq;
    return { ...at, seq, firstSeq };
  }

  async _appendPosition(entry) {
    await mkdir(this.root, { recursive: true });
    let handle;
    try {
      handle = await open(
        this.positionsFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0),
        0o600,
      );
      const info = await handle.stat();
      if (!info.isFile()) {
        sequenceFail('telegram_archive_position_unsafe', 'Telegram position journal не является файлом.');
      }
      await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
      await handle.sync();
    } catch (err) {
      if (err instanceof TelegramArchiveSequenceError) throw err;
      sequenceFail('telegram_archive_position_write_failed', 'Telegram position journal не записан.', err);
    } finally {
      await handle?.close();
    }
  }

  _ensurePositionIndex() {
    if (this.positionIndex !== null) return Promise.resolve();
    if (this.positionLoading) return this.positionLoading;
    this.positionLoading = this._loadPositionIndex().finally(() => {
      this.positionLoading = null;
    });
    return this.positionLoading;
  }

  async _loadPositionIndex() {
    let handle;
    let raw;
    try {
      handle = await open(this.positionsFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size > 256 * 1024 * 1024) {
        sequenceFail('telegram_archive_position_unsafe', 'Telegram position journal имеет неверный размер.');
      }
      raw = await handle.readFile();
      const atPath = await lstat(this.positionsFile);
      const after = await handle.stat();
      if (atPath.isSymbolicLink() || !atPath.isFile()
          || atPath.dev !== after.dev || atPath.ino !== after.ino
          || raw.length !== after.size) {
        sequenceFail('telegram_archive_position_changed', 'Telegram position journal изменился при чтении.');
      }
    } catch (err) {
      if (err?.code === 'ENOENT') {
        this.positionIndex = new Map();
        this.positionHead = 0;
        return;
      }
      if (err instanceof TelegramArchiveSequenceError) throw err;
      sequenceFail('telegram_archive_position_unsafe', 'Telegram position journal нельзя прочитать.', err);
    } finally {
      await handle?.close();
    }

    if (raw.length > 0 && raw[raw.length - 1] !== NL) {
      sequenceFail('telegram_archive_position_invalid', 'Telegram position journal содержит partial row.');
    }
    const index = new Map();
    let head = 0;
    const lines = raw.toString('utf8').split('\n');
    for (let line = 0; line < lines.length - 1; line += 1) {
      if (!lines[line]) {
        sequenceFail('telegram_archive_position_invalid', `Telegram position line ${line + 1} пуста.`);
      }
      let parsed;
      try { parsed = JSON.parse(lines[line]); } catch (err) {
        sequenceFail(
          'telegram_archive_position_invalid',
          `Telegram position line ${line + 1} не является JSON.`,
          err,
        );
      }
      const entry = exactPosition(parsed, line + 1);
      if (entry.seq !== head + 1) {
        sequenceFail(
          'telegram_archive_position_invalid',
          `Telegram position line ${line + 1} нарушает непрерывный seq.`,
        );
      }
      const key = semanticKey(entry.chatId, entry.messageId);
      const previous = index.get(key) || null;
      if (previous) {
        if (entry.firstSeq !== previous.firstSeq || entry.occurredAt !== previous.occurredAt) {
          sequenceFail(
            'telegram_archive_position_conflict',
            `Telegram position line ${line + 1} меняет semantic first occurrence.`,
          );
        }
      } else if (entry.firstSeq !== null && entry.firstSeq !== entry.seq) {
        sequenceFail(
          'telegram_archive_position_conflict',
          `Telegram position line ${line + 1} ссылается на неизвестный firstSeq.`,
        );
      }
      index.set(key, entry);
      head = entry.seq;
    }
    this.positionIndex = index;
    this.positionHead = head;
  }

  _queued(chatId, fn) {
    const prev = this.queues.get(chatId) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(chatId, next.then(() => {}, () => {}));
    return next;
  }

  _touchMeta(msg) {
    const at = msg.editedAt || msg.date;
    const prev = this.meta.get(msg.chatId)
      || { id: msg.chatId, title: '', username: '', type: '', isForum: false, lastAt: 0 };
    this.meta.set(msg.chatId, {
      id: msg.chatId,
      // Заголовок берём свежий: чаты переименовывают, и в списке должно быть
      // то же имя, что человек видит в Телеграме.
      title: msg.chatTitle || prev.title,
      // Публичное имя — вторая сторона адреса чата: правило доступа заводят и
      // именем, и числовым id, а ссылка приходит то одной формой, то другой.
      username: msg.chatUsername || prev.username || '',
      type: msg.chatType || prev.type,
      isForum: msg.isForum ?? prev.isForum,
      lastAt: Math.max(prev.lastAt || 0, at || 0),
    });
  }

  async _readAt(at) {
    let fh;
    try {
      fh = await open(at.file, 'r');
      const buf = Buffer.alloc(at.length);
      await fh.read(buf, 0, at.length, at.offset);
      return JSON.parse(buf.toString('utf8'));
    } catch (err) {
      this.log.warn?.({ err: err.message, file: at.file, offset: at.offset }, 'телеграм: строка архива не прочиталась');
      return null;
    } finally {
      await fh?.close();
    }
  }

  async _readAtStrict(at) {
    let handle;
    try {
      handle = await open(at.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const before = await handle.stat();
      if (!before.isFile() || at.offset + at.length > before.size) {
        sequenceFail('telegram_archive_position_mismatch', 'Telegram native row вышла за границу файла.');
      }
      const buffer = Buffer.alloc(at.length);
      const { bytesRead } = await handle.read(buffer, 0, at.length, at.offset);
      const [after, atPath] = await Promise.all([handle.stat(), lstat(at.file)]);
      if (bytesRead !== at.length || atPath.isSymbolicLink() || !atPath.isFile()
          || before.dev !== after.dev || before.ino !== after.ino
          || after.dev !== atPath.dev || after.ino !== atPath.ino) {
        sequenceFail('telegram_archive_position_changed', 'Telegram native row изменилась при чтении.');
      }
      return JSON.parse(buffer.toString('utf8'));
    } catch (err) {
      if (err instanceof TelegramArchiveSequenceError) throw err;
      sequenceFail('telegram_archive_position_mismatch', 'Telegram native row нельзя прочитать строго.', err);
    } finally {
      await handle?.close();
    }
  }

  async _chatDirs() {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); } catch { return []; }
    return entries.filter((e) => e.isDirectory() && /^-?\d+$/.test(e.name)).map((e) => Number(e.name));
  }

  async _snapshot() {
    if (this.snapshot) return this.snapshot;
    try {
      this.snapshot = JSON.parse(await readFile(this.chatsFile, 'utf8'));
    } catch {
      this.snapshot = {};
    }
    return this.snapshot;
  }

  /**
   * Разбирает месяцы чата один раз за жизнь процесса и строит индекс смещений.
   * Обещание кэшируется: второй вызов во время скана обязан ДОЖДАТЬСЯ первого,
   * иначе он увидит наполовину построенный индекс и решит, что сообщения нет.
   */
  _ensureIndex(chatId) {
    if (this.indexing.has(chatId)) return this.indexing.get(chatId);
    const idx = new Map();
    const job = (async () => {
      let files;
      try { files = await readdir(this.chatDir(chatId)); } catch { files = []; }
      for (const name of files.filter((n) => n.endsWith('.ndjson')).sort()) {
        await this._scanFile(chatId, path.join(this.chatDir(chatId), name), idx);
      }
      this.index.set(chatId, idx);
    })();
    this.indexing.set(chatId, job);
    return job;
  }

  async _scanFile(chatId, file, idx) {
    let raw;
    try { raw = await readFile(file); } catch { return; }
    this.sizes.set(file, raw.length);
    let from = 0;
    while (from < raw.length) {
      let end = raw.indexOf(NL, from);
      if (end === -1) end = raw.length;
      const length = end - from;
      if (length > 0) {
        try {
          const msg = JSON.parse(raw.subarray(from, end).toString('utf8'));
          // Позже записанная версия того же id побеждает — так работает правка.
          idx.set(msg.messageId, {
            file, offset: from, length, date: msg.date, service: msg.service || null,
            thread: msg.threadId ?? null,
            threadTitle: msg.threadTitle || '',
            threadTitleSource: msg.threadTitleSource || '',
            reply: msg.replyToMessageId ?? null,
          });
          this._touchMeta(msg);
        } catch {
          // Одна битая строка не имеет права унести с собой весь архив.
          this.log.warn?.({ file, offset: from }, 'телеграм: битая строка архива пропущена');
        }
      }
      from = end + 1;
    }
    // Размер мог быть посчитан по буферу — сверимся с диском, если файл дописали.
    try { this.sizes.set(file, (await stat(file)).size); } catch { /* уже записали длину буфера */ }
  }
}
