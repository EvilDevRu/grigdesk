// Per-account Telegram stores. Provider ids/display metadata never участвуют в
// filesystem path: единственный segment — проверенный случайный accountRef.
import path from 'node:path';

import { InboxRefCodec, assertAccountRef } from '../inbox/identity.ts';
import { InboxStateStore } from '../inbox/stateStore.ts';
import * as defaultBotApi from './api.ts';
import {
  TelegramAccountBindingsError,
  atomicWriteTelegramJson,
  normalizeTelegramBotId,
  readTelegramJsonNoFollow,
} from './accountBindings.ts';
import { telegramActivationCodec, telegramActivationMarker } from './activation.ts';
import { TelegramArchiveStore } from './archiveStore.ts';
import { TelegramRulesStore } from './rulesStore.ts';

type Payload = Record<string, unknown>;

// Presentation-safe снимок бота: токена здесь нет и быть не может, наружу уходят
// только имя, права чтения и выбор служебного чата с пультом.
export interface TelegramBotView {
  botId: number;
  username: string;
  canReadAllGroupMessages: boolean | null;
  connectedAtMs: number | null;
  serviceChatId: number | null;
  pultChatId: number | null;
  pultUserId: number | null;
  pultConfirmedAtMs: number | null;
}

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
  code: string;

  constructor(code: string, message: string, cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TelegramAccountContextError';
    this.code = code;
  }
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (code: string, message: string, cause?: unknown) => never = (
  code,
  message,
  cause = null,
) => {
  throw new TelegramAccountContextError(code, message, cause);
};

function isPlainObject(value: unknown): value is Payload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value: unknown, keys: string[], where: string, optional: string[] = []): void {
  if (!isPlainObject(value)) fail('telegram_bot_settings_invalid', `${where}: ожидался объект.`);

  const allowed = new Set([...keys, ...optional]);
  const actual = Object.keys(value);
  if (keys.some((key) => !Object.hasOwn(value, key))
      || actual.some((key) => !allowed.has(key))) {
    fail('telegram_bot_settings_invalid', `${where}: поля не совпадают со schema v1.`);
  }
}

function boundedString(value: unknown, where: string, maxBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail('telegram_bot_settings_invalid', `${where}: строка имеет неверный размер.`);
  }

  return value;
}

function nullableBoolean(value: unknown, where: string): boolean | null {
  if (value !== null && typeof value !== 'boolean') {
    fail('telegram_bot_settings_invalid', `${where}: ожидался boolean|null.`);
  }

  return value as boolean | null;
}

function serviceChat(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    fail('telegram_bot_settings_invalid', 'serviceChatId должен быть positive safe integer|null.');
  }

  return value as number;
}

function connectedAt(value: unknown, where = 'connectedAtMs'): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    fail('telegram_bot_settings_invalid', `${where} должен быть positive Unix milliseconds|null.`);
  }

  return value as number;
}

function pultId(value: unknown, where: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    fail('telegram_bot_settings_invalid', `${where} должен быть positive safe integer|null.`);
  }

  return value as number;
}

/** Пульт: либо пары нет, либо она согласована; подтверждение без чата невозможно. */
function pultFields(raw: Payload) {
  const pultChatId = pultId(raw.pultChatId ?? null, 'pultChatId');
  const pultUserId = pultId(raw.pultUserId ?? null, 'pultUserId');
  const pultConfirmedAtMs = connectedAt(raw.pultConfirmedAtMs ?? null, 'pultConfirmedAtMs');
  if ((pultChatId === null) !== (pultUserId === null)
      || (pultConfirmedAtMs !== null && pultChatId === null)) {
    fail('telegram_bot_settings_invalid', 'Поля пульта несогласованны.');
  }
  return { pultChatId, pultUserId, pultConfirmedAtMs };
}

const emptySettings = (botId: string, serviceChatId: number | null = null): TelegramBotView => ({
  botId: Number(botId),
  username: '',
  canReadAllGroupMessages: null,
  connectedAtMs: null,
  serviceChatId,
  pultChatId: null,
  pultUserId: null,
  pultConfirmedAtMs: null,
});

function normalizeSettings(source: unknown, owner: { accountRef: string; botId: string }) {
  exact(source, SETTINGS_KEYS, 'Telegram bot-settings', PULT_KEYS);

  const raw = source as Payload;
  let storedBotId: string;

  try { storedBotId = normalizeTelegramBotId(raw.botId, 'bot-settings.botId'); } catch (err) {
    fail('telegram_bot_settings_invalid', 'bot-settings.botId невалиден.', err);
  }
  if (raw.version !== 1 || raw.accountRef !== owner.accountRef || storedBotId !== owner.botId
      || !Number.isSafeInteger(raw.updatedAtMs) || Number(raw.updatedAtMs) <= 0) {
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
    updatedAtMs: raw.updatedAtMs as number,
  };
}

function botInput(source: unknown) {
  exact(source, BOT_INPUT_KEYS, 'Telegram setBot input');

  const raw = source as Payload;

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
  file: string;

  accountRef: string;

  botId: string;

  now: () => number;

  queue: Promise<unknown>;

  constructor({ file, accountRef, botId, now = Date.now }: {
    file?: unknown;
    accountRef?: unknown;
    botId?: unknown;
    now?: () => number;
  } = {}) {
    if (typeof file !== 'string' || !file || typeof now !== 'function') {
      throw new TypeError('TelegramBotSettingsStore требует file и now().');
    }
    this.file = file;
    this.accountRef = assertAccountRef(accountRef);
    this.botId = normalizeTelegramBotId(botId);
    this.now = now;
    this.queue = Promise.resolve();
  }

  _queued<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation, operation);

    this.queue = result.catch(() => {});

    return result;
  }

  _empty() {
    return { view: emptySettings(this.botId), updatedAtMs: null };
  }

  async _read() {
    let raw: unknown;

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

  async setBot(bot: unknown) {
    return this._queued(async () => {
      const current = await this._read();
      return this._writeInsideQueue({
        ...current.view,
        ...botInput(bot),
      });
    });
  }

  async setServiceChatId(serviceChatId: unknown) {
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
  async setPult({ chatId = null, userId = null, confirmedAtMs = null }: {
    chatId?: number | null;
    userId?: number | null;
    confirmedAtMs?: number | null;
  } = {}) {
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

  async _writeInsideQueue(view: TelegramBotView): Promise<TelegramBotView> {
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
      ...pultFields(view as unknown as Payload),
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

function pollState(raw: unknown): { offset: number; updatedAtMs: number } {
  if (!isPlainObject(raw)) {
    fail('telegram_poll_state_invalid', 'Telegram poll state не является объектом.');
  }

  const keys = Object.keys(raw).sort().join('\0');
  const current = [...POLL_STATE_KEYS].sort().join('\0');
  if (keys !== current) {
    fail('telegram_poll_state_invalid', 'Telegram poll state поля не совпадают со schema v1.');
  }
  if (raw.version !== 1) fail('telegram_poll_state_invalid', 'Telegram poll state version неизвестна.');
  const { offset, updatedAtMs } = raw;

  if (!Number.isSafeInteger(offset) || Number(offset) < 0
      || !Number.isSafeInteger(updatedAtMs) || Number(updatedAtMs) <= 0) {
    fail('telegram_poll_state_invalid', 'Telegram poll state содержит неверный offset/timestamp.');
  }

  return { offset: offset as number, updatedAtMs: updatedAtMs as number };
}

/** Строгий state.json account-aware poller-а; flat state никогда не читается. */
export class TelegramPollStateStore {
  file: string;

  queue: Promise<unknown>;

  constructor({ file }: { file?: unknown } = {}) {
    if (typeof file !== 'string' || !file) {
      throw new TypeError('TelegramPollStateStore: file обязателен.');
    }
    this.file = file;
    this.queue = Promise.resolve();
  }

  _queued<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation, operation);

    this.queue = result.catch(() => {});

    return result;
  }

  async read() {
    let raw: unknown;

    try { raw = await readTelegramJsonNoFollow(this.file); } catch (err) {
      fail('telegram_poll_state_invalid', 'Telegram poll state нельзя прочитать.', err);
    }

    return raw === null ? null : pollState(raw);
  }

  async write({ offset, updatedAtMs }: { offset?: number; updatedAtMs?: number } = {}) {
    const clean = pollState({ version: 1, offset, updatedAtMs });
    return this._queued(async () => {
      await atomicWriteTelegramJson(this.file, { version: 1, ...clean });
      return { ...clean };
    });
  }
}

function credentialsSnapshot(
  value: unknown,
  botId: string,
  accountRef: string,
): { botId: string; token: string } | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    fail('telegram_account_context_invalid', 'credentialLease должен быть объектом.');
  }

  const keys = Object.keys(value).sort();
  if (keys.length !== 3
      || keys[0] !== 'accountRef' || keys[1] !== 'botId' || keys[2] !== 'token') {
    fail('telegram_account_context_invalid', 'credentialLease имеет неверные поля.');
  }
  let credentialAccountRef: string;

  try {
    credentialAccountRef = assertAccountRef(value.accountRef, 'credentialLease.accountRef');
  } catch (err) {
    fail('telegram_account_context_invalid', 'credentialLease.accountRef невалиден.', err);
  }

  let credentialBotId: string;

  try { credentialBotId = normalizeTelegramBotId(value.botId, 'credentialLease.botId'); } catch (err) {
    fail('telegram_account_context_invalid', 'credentialLease.botId невалиден.', err);
  }
  const token = typeof value.token === 'string' ? value.token.trim() : '';
  const tokenBotId = token.split(':', 1)[0];
  if (!token || token.length > 16 * 1024 || /[\0\r\n\s]/u.test(token)
      || credentialAccountRef !== accountRef
      || credentialBotId !== botId || tokenBotId !== botId) {
    fail('telegram_account_context_invalid', 'Credential snapshot не совпадает с verified account/bot identity.');
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
}: {
  dir?: unknown;
  now?: () => number;
  log?: Console;
  botApi?: typeof defaultBotApi;
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
  const root = path.resolve(dir as string);
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
  }: {
    accountRef?: unknown;
    botId?: unknown;
    credentialLease?: unknown;
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
      rules: new TelegramRulesStore({
        dir: accountDir,
        accountRef: trustedAccountRef,
        botId: trustedBotId,
        log,
        strictRead: true,
      }),
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
      credentials: credentialsSnapshot(credentialLease, trustedBotId, trustedAccountRef),
      botApi: api,
      async createActivationMarker({ nowMs, occurredAt = null }: {
        nowMs?: number;
        occurredAt?: number | null;
      } = {}) {
        const afterSeq = await archive.head();
        return telegramActivationMarker({ afterSeq, occurredAt, nowMs });
      },
    };
  };
}

export default createTelegramAccountContextFactory;
