// Durable mapping проверенного Telegram bot к случайному accountRef Cockpit.
//
// Username и token меняются, поэтому owner identity строится только из bot.id,
// подтверждённого getMe. Registry никогда не выходит в HTTP API.
import { randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat, mkdir, open, rename, unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { assertAccountRef } from '../inbox/identity.js';

const MAX_BINDINGS_BYTES = 1024 * 1024;
const BOT_ID_RE = /^[1-9]\d{0,15}$/u;
const DOCUMENT_KEYS = ['schemaVersion', 'channel', 'selectedAccountRef', 'updatedAtMs', 'bindings'];
const BINDING_KEYS = ['accountRef', 'providerIdentity', 'createdAtMs'];

export class TelegramAccountBindingsError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TelegramAccountBindingsError';
    this.code = code;
  }
}

const fail = (code, message, cause = null) => {
  throw new TelegramAccountBindingsError(code, message, cause);
};

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactObject(value, keys, where) {
  if (!isPlainObject(value)) fail('telegram_bindings_invalid', `${where}: ожидался объект.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('telegram_bindings_invalid', `${where}: поля не совпадают со schema v1.`);
  }
}

function timestamp(value, where) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('telegram_bindings_invalid', `${where}: ожидались положительные Unix milliseconds.`);
  }
  return value;
}

/** Canonical decimal bot.id. Числовой Bot API transport обязан оставаться safe. */
export function normalizeTelegramBotId(value, where = 'botId') {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail('telegram_identity_invalid', `${where}: ожидался положительный safe integer.`);
    }
    return String(value);
  }
  if (typeof value !== 'string' || !BOT_ID_RE.test(value)) {
    fail('telegram_identity_invalid', `${where}: ожидалась canonical positive decimal-строка.`);
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || String(numeric) !== value) {
    fail('telegram_identity_invalid', `${where}: id выходит за safe integer Bot API v1.`);
  }
  return value;
}

/** Immutable provider identity одного Telegram bot. */
export function telegramBotIdentity(botId) {
  return Object.freeze([1, 'api.telegram.org', 'bot', normalizeTelegramBotId(botId)]);
}

/** Принимает только exact tuple: token/username/display name не являются identity. */
export function normalizeTelegramBotIdentity(value, where = 'providerIdentity') {
  if (!Array.isArray(value) || value.length !== 4
      || value[0] !== 1 || value[1] !== 'api.telegram.org' || value[2] !== 'bot'
      || typeof value[3] !== 'string') {
    fail('telegram_identity_invalid', `${where}: ожидался exact Telegram bot identity tuple v1.`);
  }
  return telegramBotIdentity(value[3]);
}

export function botIdFromIdentity(identity) {
  return normalizeTelegramBotIdentity(identity)[3];
}

function sameInfo(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

async function readStableFile(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    fail('telegram_bindings_unsafe', 'Telegram account bindings нельзя безопасно открыть.', err);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_BINDINGS_BYTES) {
      fail('telegram_bindings_unsafe', 'Telegram account bindings имеет недопустимый тип или размер.');
    }
    const bytes = await handle.readFile();
    const [after, atPath] = await Promise.all([handle.stat(), lstat(file)]);
    if (!after.isFile() || atPath.isSymbolicLink() || !atPath.isFile()
        || !sameInfo(before, after) || !sameInfo(after, atPath)
        || bytes.length !== after.size) {
      fail('telegram_bindings_changed', 'Telegram account bindings изменился во время чтения.');
    }
    return bytes;
  } catch (err) {
    if (err instanceof TelegramAccountBindingsError) throw err;
    fail('telegram_bindings_unsafe', 'Telegram account bindings нельзя безопасно прочитать.', err);
  } finally {
    await handle?.close();
  }
}

export async function readTelegramJsonNoFollow(file) {
  const bytes = await readStableFile(file);
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    fail('telegram_bindings_invalid', 'Telegram account bindings не является корректным JSON.', err);
  }
}

async function assertRegularTarget(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      fail('telegram_bindings_unsafe', 'Telegram account bindings target не является обычным файлом.');
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    if (err instanceof TelegramAccountBindingsError) throw err;
    fail('telegram_bindings_unsafe', 'Telegram account bindings target нельзя проверить.', err);
  }
}

async function syncDirectory(dir) {
  let handle;
  try {
    handle = await open(dir, constants.O_RDONLY
      | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

export async function atomicWriteTelegramJson(file, value) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const parent = await lstat(dir);
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    fail('telegram_bindings_unsafe', 'Каталог Telegram account bindings небезопасен.');
  }
  await assertRegularTarget(file);
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    await assertRegularTarget(file);
    await rename(temporary, file);
    await syncDirectory(dir);
  } catch (err) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (err instanceof TelegramAccountBindingsError) throw err;
    fail('telegram_bindings_write_failed', 'Telegram account bindings не удалось записать.', err);
  }
}

function validateDocument(raw) {
  exactObject(raw, DOCUMENT_KEYS, 'Telegram account bindings');
  if (raw.schemaVersion !== 1 || raw.channel !== 'telegram' || !Array.isArray(raw.bindings)) {
    fail('telegram_bindings_invalid', 'Telegram account bindings имеет неверную schema v1.');
  }
  timestamp(raw.updatedAtMs, 'updatedAtMs');

  const identities = new Set();
  const accounts = new Set();
  const bindings = raw.bindings.map((entry, index) => {
    exactObject(entry, BINDING_KEYS, `bindings[${index}]`);
    let accountRef;
    try { accountRef = assertAccountRef(entry.accountRef); } catch (err) {
      fail('telegram_bindings_invalid', `bindings[${index}].accountRef невалиден.`, err);
    }
    const providerIdentity = normalizeTelegramBotIdentity(
      entry.providerIdentity,
      `bindings[${index}].providerIdentity`,
    );
    const identityKey = JSON.stringify(providerIdentity);
    if (identities.has(identityKey) || accounts.has(accountRef)) {
      fail('telegram_binding_conflict', 'Telegram account bindings содержит duplicate owner.');
    }
    identities.add(identityKey);
    accounts.add(accountRef);
    return {
      accountRef,
      providerIdentity: [...providerIdentity],
      createdAtMs: timestamp(entry.createdAtMs, `bindings[${index}].createdAtMs`),
    };
  });

  let selectedAccountRef = null;
  if (raw.selectedAccountRef !== null) {
    try { selectedAccountRef = assertAccountRef(raw.selectedAccountRef); } catch (err) {
      fail('telegram_bindings_invalid', 'selectedAccountRef невалиден.', err);
    }
    if (!accounts.has(selectedAccountRef)) {
      fail('telegram_binding_conflict', 'selectedAccountRef не ссылается на binding.');
    }
  }
  return {
    schemaVersion: 1,
    channel: 'telegram',
    selectedAccountRef,
    updatedAtMs: raw.updatedAtMs,
    bindings,
  };
}

const clone = (value) => structuredClone(value);

/**
 * Генерирует opaque accountRef без чтения/изменения registry.
 * Отдельная чистая функция оставляет генерацию проверяемой до durable registry commit.
 */
export function generateTelegramAccountRef(randomBytes = cryptoRandomBytes) {
  if (typeof randomBytes !== 'function') {
    fail('telegram_random_failed', 'Генератор accountRef должен быть функцией.');
  }
  const bytes = randomBytes(24);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16) {
    fail('telegram_random_failed', 'Генератор accountRef вернул мало случайных байтов.');
  }
  const accountRef = `acc_${Buffer.from(bytes).toString('base64url')}`;
  try { assertAccountRef(accountRef); } catch (err) {
    fail('telegram_random_failed', 'Сгенерированный accountRef невалиден.', err);
  }
  return accountRef;
}

export class TelegramAccountBindings {
  constructor({ file, randomBytes = cryptoRandomBytes, now = Date.now } = {}) {
    if (typeof file !== 'string' || !file) {
      throw new TypeError('TelegramAccountBindings: file обязателен.');
    }
    if (typeof randomBytes !== 'function' || typeof now !== 'function') {
      throw new TypeError('TelegramAccountBindings: randomBytes/now должны быть функциями.');
    }
    this.file = file;
    this.randomBytes = randomBytes;
    this.now = now;
    this.queue = Promise.resolve();
  }

  _queued(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async _read() {
    const raw = await readTelegramJsonNoFollow(this.file);
    if (raw === null) {
      return {
        schemaVersion: 1,
        channel: 'telegram',
        selectedAccountRef: null,
        updatedAtMs: null,
        bindings: [],
      };
    }
    return validateDocument(raw);
  }

  async read() { return clone(await this._read()); }

  async lookup(identity) {
    const key = JSON.stringify(normalizeTelegramBotIdentity(identity));
    const document = await this._read();
    const found = document.bindings.find((entry) => JSON.stringify(entry.providerIdentity) === key);
    return found ? clone(found) : null;
  }

  async byAccountRef(accountRef) {
    let owner;
    try { owner = assertAccountRef(accountRef); } catch (err) {
      fail('telegram_identity_invalid', 'accountRef имеет неверный формат.', err);
    }
    const document = await this._read();
    const found = document.bindings.find((entry) => entry.accountRef === owner);
    return found ? clone(found) : null;
  }

  /** Disconnect сохраняет выбранный offline owner и не вызывает этот метод. */
  async selected() {
    const document = await this._read();
    if (document.selectedAccountRef === null) return null;
    return clone(document.bindings.find((entry) => entry.accountRef === document.selectedAccountRef));
  }

  async select(accountRef) {
    let owner;
    try { owner = assertAccountRef(accountRef); } catch (err) {
      fail('telegram_identity_invalid', 'accountRef имеет неверный формат.', err);
    }
    return this._queued(async () => {
      const document = await this._read();
      const binding = document.bindings.find((entry) => entry.accountRef === owner);
      if (!binding) fail('telegram_binding_missing', 'Нельзя выбрать неизвестный Telegram accountRef.');
      if (document.selectedAccountRef !== owner) {
        const nowMs = timestamp(this.now(), 'nowMs');
        await atomicWriteTelegramJson(this.file, validateDocument({
          ...document,
          selectedAccountRef: owner,
          updatedAtMs: nowMs,
        }));
      }
      return clone(binding);
    });
  }

  /** Только operator recovery: обычный disconnect обязан оставить offline owner. */
  async clearSelection() {
    return this._queued(async () => {
      const document = await this._read();
      if (document.selectedAccountRef === null) return false;
      await atomicWriteTelegramJson(this.file, validateDocument({
        ...document,
        selectedAccountRef: null,
        updatedAtMs: timestamp(this.now(), 'nowMs'),
      }));
      return true;
    });
  }

  async resolveOrCreate(identity, { select = true } = {}) {
    const providerIdentity = [...normalizeTelegramBotIdentity(identity)];
    const key = JSON.stringify(providerIdentity);
    return this._queued(async () => {
      const document = await this._read();
      const known = document.bindings.find((entry) => JSON.stringify(entry.providerIdentity) === key);
      if (known) {
        if (select && document.selectedAccountRef !== known.accountRef) {
          await atomicWriteTelegramJson(this.file, validateDocument({
            ...document,
            selectedAccountRef: known.accountRef,
            updatedAtMs: timestamp(this.now(), 'nowMs'),
          }));
        }
        return { created: false, selected: select, binding: clone(known) };
      }

      const occupied = new Set(document.bindings.map((entry) => entry.accountRef));
      let accountRef = null;
      for (let attempt = 0; attempt < 16 && accountRef === null; attempt += 1) {
        const candidate = generateTelegramAccountRef(this.randomBytes);
        if (!occupied.has(candidate)) accountRef = candidate;
      }
      if (accountRef === null) {
        fail('telegram_binding_conflict', 'Не удалось получить уникальный Telegram accountRef.');
      }

      const nowMs = timestamp(this.now(), 'nowMs');
      const binding = { accountRef, providerIdentity, createdAtMs: nowMs };
      const next = validateDocument({
        schemaVersion: 1,
        channel: 'telegram',
        selectedAccountRef: select ? accountRef : document.selectedAccountRef,
        updatedAtMs: nowMs,
        bindings: [...document.bindings, binding],
      });
      await atomicWriteTelegramJson(this.file, next);
      return { created: true, selected: select, binding: clone(binding) };
    });
  }

}
