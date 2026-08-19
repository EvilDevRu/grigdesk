// Per-account Telegram stores. Provider ids/display metadata never участвуют в
// filesystem path: единственный segment — проверенный случайный accountRef.
import path from 'node:path';

import { InboxRefCodec, assertAccountRef } from '../inbox/identity.js';
import { InboxStateStore } from '../inbox/state-store.js';
import * as defaultBotApi from './api.js';
import {
  TelegramAccountBindingsError,
  atomicWriteTelegramJson,
  normalizeTelegramBotId,
  readTelegramJsonNoFollow,
} from './account-bindings.js';
import { telegramActivationCodec, telegramActivationMarker } from './activation.js';
import { TelegramArchiveStore } from './archive-store.js';
import { TelegramRulesStore } from './rules-store.js';

const SETTINGS_KEYS = [
  'version', 'accountRef', 'botId', 'username', 'canReadAllGroupMessages',
  'connectedAtMs', 'serviceChatId', 'updatedAtMs',
];
// Поля телеграм-пульта — НЕОБЯЗАТЕЛЬНАЯ часть той же schema v1: файлы, записанные
// до пульта, обязаны читаться как «не настроено», а не падать owner-mismatch-ом.
// Запись всегда кладёт полный набор.
const PULT_KEYS = ['pultChatId', 'pultUserId', 'pultConfirmedAtMs'];
const BOT_INPUT_KEYS = ['username', 'canReadAllGroupMessages', 'connectedAtMs'];
const POLL_STATE_KEYS = ['version', 'offset', 'updatedAtMs'];

export class TelegramAccountContextError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TelegramAccountContextError';
    this.code = code;
  }
}

const fail = (code, message, cause = null) => {
  throw new TelegramAccountContextError(code, message, cause);
};

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value, keys, where, optional = []) {
  if (!isPlainObject(value)) fail('telegram_bot_settings_invalid', `${where}: ожидался объект.`);
  const allowed = new Set([...keys, ...optional]);
  const actual = Object.keys(value);
  if (keys.some((key) => !Object.hasOwn(value, key))
      || actual.some((key) => !allowed.has(key))) {
    fail('telegram_bot_settings_invalid', `${where}: поля не совпадают со schema v1.`);
  }
}

function boundedString(value, where, maxBytes) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail('telegram_bot_settings_invalid', `${where}: строка имеет неверный размер.`);
  }
  return value;
}

function nullableBoolean(value, where) {
  if (value !== null && typeof value !== 'boolean') {
    fail('telegram_bot_settings_invalid', `${where}: ожидался boolean|null.`);
  }
  return value;
}

function serviceChat(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('telegram_bot_settings_invalid', 'serviceChatId должен быть positive safe integer|null.');
  }
  return value;
}

function connectedAt(value, where = 'connectedAtMs') {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('telegram_bot_settings_invalid', `${where} должен быть positive Unix milliseconds|null.`);
  }
  return value;
}

function pultId(value, where) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('telegram_bot_settings_invalid', `${where} должен быть positive safe integer|null.`);
  }
  return value;
}

/** Пульт: либо пары нет, либо она согласована; подтверждение без чата невозможно. */
function pultFields(raw) {
  const pultChatId = pultId(raw.pultChatId ?? null, 'pultChatId');
  const pultUserId = pultId(raw.pultUserId ?? null, 'pultUserId');
  const pultConfirmedAtMs = connectedAt(raw.pultConfirmedAtMs ?? null, 'pultConfirmedAtMs');
  if ((pultChatId === null) !== (pultUserId === null)
      || (pultConfirmedAtMs !== null && pultChatId === null)) {
    fail('telegram_bot_settings_invalid', 'Поля пульта несогласованны.');
  }
  return { pultChatId, pultUserId, pultConfirmedAtMs };
}

const emptySettings = (botId, serviceChatId = null) => ({
  botId: Number(botId),
  username: '',
  canReadAllGroupMessages: null,
  connectedAtMs: null,
  serviceChatId,
  pultChatId: null,
  pultUserId: null,
  pultConfirmedAtMs: null,
});

function normalizeSettings(raw, owner) {
  exact(raw, SETTINGS_KEYS, 'Telegram bot-settings', PULT_KEYS);
  let storedBotId;
  try { storedBotId = normalizeTelegramBotId(raw.botId, 'bot-settings.botId'); } catch (err) {
    fail('telegram_bot_settings_invalid', 'bot-settings.botId невалиден.', err);
  }
  if (raw.version !== 1 || raw.accountRef !== owner.accountRef || storedBotId !== owner.botId
      || !Number.isSafeInteger(raw.updatedAtMs) || raw.updatedAtMs <= 0) {
    fail('telegram_bot_settings_owner_mismatch', 'Telegram bot-settings owner/schema не совпадает.');
  }
  return {
    view: {
      botId: Number(storedBotId),
      username: boundedString(raw.username, 'bot-settings.username', 256),
      canReadAllGroupMessages: nullableBoolean(
        raw.canReadAllGroupMessages,
        'bot-settings.canReadAllGroupMessages',
      ),
      connectedAtMs: connectedAt(raw.connectedAtMs),
      serviceChatId: serviceChat(raw.serviceChatId),
      ...pultFields(raw),
    },
    updatedAtMs: raw.updatedAtMs,
  };
}

function botInput(raw) {
  exact(raw, BOT_INPUT_KEYS, 'Telegram setBot input');
  return {
    username: boundedString(raw.username, 'setBot.username', 256),
    canReadAllGroupMessages: nullableBoolean(
      raw.canReadAllGroupMessages,
      'setBot.canReadAllGroupMessages',
    ),
    connectedAtMs: connectedAt(raw.connectedAtMs),
  };
}

/** Native service-chat + presentation-safe bot metadata, без token. */
export class TelegramBotSettingsStore {
  constructor({ file, accountRef, botId, now = Date.now } = {}) {
    if (typeof file !== 'string' || !file || typeof now !== 'function') {
      throw new TypeError('TelegramBotSettingsStore требует file и now().');
    }
    this.file = file;
    this.accountRef = assertAccountRef(accountRef);
    this.botId = normalizeTelegramBotId(botId);
    this.now = now;
    this.queue = Promise.resolve();
  }

  _queued(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  _empty() {
    return { view: emptySettings(this.botId), updatedAtMs: null };
  }

  async _read() {
    let raw;
    try { raw = await readTelegramJsonNoFollow(this.file); } catch (err) {
      if (err instanceof TelegramAccountBindingsError) {
        fail('telegram_bot_settings_invalid', 'Telegram bot-settings нельзя прочитать.', err);
      }
      throw err;
    }
    return raw === null
      ? this._empty()
      : normalizeSettings(raw, { accountRef: this.accountRef, botId: this.botId });
  }

  async read() { return structuredClone((await this._read()).view); }

  async setBot(bot) {
    return this._queued(async () => {
      const current = await this._read();
      return this._writeInsideQueue({
        ...current.view,
        ...botInput(bot),
      });
    });
  }

  async setServiceChatId(serviceChatId) {
    return this._queued(async () => {
      const current = await this._read();
      return this._writeInsideQueue({
        ...current.view,
        serviceChatId: serviceChat(serviceChatId),
      });
    });
  }

  /**
   * Владелец пульта. Disable передаёт прежние chatId/userId с confirmedAtMs=null:
   * выбор чата остаётся в namespace бота, а право управлять гаснет.
   */
  async setPult({ chatId = null, userId = null, confirmedAtMs = null } = {}) {
    return this._queued(async () => {
      const current = await this._read();
      return this._writeInsideQueue({
        ...current.view,
        pultChatId: chatId,
        pultUserId: userId,
        pultConfirmedAtMs: confirmedAtMs,
      });
    });
  }

  async _writeInsideQueue(view) {
    const updatedAtMs = this.now();
    if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs <= 0) {
      fail('telegram_bot_settings_invalid', 'Telegram bot-settings получил неверный timestamp.');
    }
    const persisted = {
      version: 1,
      accountRef: this.accountRef,
      botId: Number(this.botId),
      username: boundedString(view.username, 'bot-settings.username', 256),
      canReadAllGroupMessages: nullableBoolean(
        view.canReadAllGroupMessages,
        'bot-settings.canReadAllGroupMessages',
      ),
      connectedAtMs: connectedAt(view.connectedAtMs),
      serviceChatId: serviceChat(view.serviceChatId),
      ...pultFields(view),
      updatedAtMs,
    };
    const next = normalizeSettings(
      persisted,
      { accountRef: this.accountRef, botId: this.botId },
    );
    await atomicWriteTelegramJson(this.file, persisted);
    return structuredClone(next.view);
  }
}

function pollState(raw) {
  if (!isPlainObject(raw)) fail('telegram_poll_state_invalid', 'Telegram poll state не является объектом.');
  const keys = Object.keys(raw).sort().join('\0');
  const current = [...POLL_STATE_KEYS].sort().join('\0');
  if (keys !== current) {
    fail('telegram_poll_state_invalid', 'Telegram poll state поля не совпадают со schema v1.');
  }
  if (raw.version !== 1) fail('telegram_poll_state_invalid', 'Telegram poll state version неизвестна.');
  const { offset, updatedAtMs } = raw;
  if (!Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(updatedAtMs) || updatedAtMs <= 0) {
    fail('telegram_poll_state_invalid', 'Telegram poll state содержит неверный offset/timestamp.');
  }
  return { offset, updatedAtMs };
}

/** Строгий state.json account-aware poller-а; flat state никогда не читается. */
export class TelegramPollStateStore {
  constructor({ file } = {}) {
    if (typeof file !== 'string' || !file) {
      throw new TypeError('TelegramPollStateStore: file обязателен.');
    }
    this.file = file;
    this.queue = Promise.resolve();
  }

  _queued(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async read() {
    let raw;
    try { raw = await readTelegramJsonNoFollow(this.file); } catch (err) {
      fail('telegram_poll_state_invalid', 'Telegram poll state нельзя прочитать.', err);
    }
    return raw === null ? null : pollState(raw);
  }

  async write({ offset, updatedAtMs } = {}) {
    const clean = pollState({ version: 1, offset, updatedAtMs });
    return this._queued(async () => {
      await atomicWriteTelegramJson(this.file, { version: 1, ...clean });
      return { ...clean };
    });
  }
}

function credentialsSnapshot(value, botId) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) fail('telegram_account_context_invalid', 'credentialLease должен быть объектом.');
  let credentialBotId;
  try { credentialBotId = normalizeTelegramBotId(value.botId, 'credentialLease.botId'); } catch (err) {
    fail('telegram_account_context_invalid', 'credentialLease.botId невалиден.', err);
  }
  const token = typeof value.token === 'string' ? value.token.trim() : '';
  const tokenBotId = token.split(':', 1)[0];
  if (!token || token.length > 16 * 1024 || /[\0\r\n\s]/u.test(token)
      || credentialBotId !== botId || tokenBotId !== botId) {
    fail('telegram_account_context_invalid', 'Credential snapshot не совпадает с verified bot identity.');
  }
  return Object.freeze({ botId, token });
}

/**
 * accountContextFor({accountRef,botId,credentialLease}) собирает stores одного
 * owner. credentialLease — immutable snapshot текущей generation, а не creds.read().
 */
export function createTelegramAccountContextFactory({
  dir,
  now = Date.now,
  log = console,
  botApi = defaultBotApi,
} = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new TypeError('Telegram account context: dir должен быть абсолютным trusted path.');
  }
  if (typeof now !== 'function'
      || typeof botApi?.getFile !== 'function'
      || typeof botApi?.downloadFile !== 'function'
      || typeof botApi?.callBotApi !== 'function') {
    throw new TypeError('Telegram account context: now/botApi имеют неверный контракт.');
  }
  const root = path.resolve(dir);
  const api = Object.freeze({
    getFile: botApi.getFile.bind(botApi),
    downloadFile: botApi.downloadFile.bind(botApi),
    // Универсальный transport остаётся внутри account lease: наружу token не
    // выходит, а channel adapter может безопасно отправить post-commit ответ.
    callBotApi: botApi.callBotApi.bind(botApi),
  });

  return async function accountContextFor({
    accountRef,
    botId,
    credentialLease = null,
  } = {}) {
    const trustedAccountRef = assertAccountRef(accountRef);
    const trustedBotId = normalizeTelegramBotId(botId);
    const accountDir = path.join(root, 'accounts', trustedAccountRef);
    const paths = Object.freeze({
      accountDir,
      stateFile: path.join(accountDir, 'state.json'),
      archiveDir: path.join(accountDir, 'archive'),
      rulesFile: path.join(accountDir, 'rules.json'),
      botSettingsFile: path.join(accountDir, 'bot-settings.json'),
      inboxStateFile: path.join(accountDir, 'inbox-state.json'),
    });
    const refCodec = new InboxRefCodec({ channel: 'telegram', accountRef: trustedAccountRef });
    const archive = new TelegramArchiveStore({ dir: accountDir, log, inboxSequence: true });

    return {
      botId: trustedBotId,
      paths,
      archive,
      rules: new TelegramRulesStore({ dir: accountDir, log, strictRead: true }),
      botSettings: new TelegramBotSettingsStore({
        file: paths.botSettingsFile,
        accountRef: trustedAccountRef,
        botId: trustedBotId,
        now,
      }),
      pollState: new TelegramPollStateStore({ file: paths.stateFile }),
      inboxState: new InboxStateStore({
        file: paths.inboxStateFile,
        channel: 'telegram',
        accountRef: trustedAccountRef,
        refCodec,
        activationCodec: telegramActivationCodec,
      }),
      credentials: credentialsSnapshot(credentialLease, trustedBotId),
      botApi: api,
      async createActivationMarker({ nowMs, occurredAt = null } = {}) {
        const afterSeq = await archive.head();
        return telegramActivationMarker({ afterSeq, occurredAt, nowMs });
      },
    };
  };
}

export default createTelegramAccountContextFactory;
