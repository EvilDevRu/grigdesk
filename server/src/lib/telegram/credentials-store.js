// Credential активной account-aware Telegram connection.
// Token жёстко связан с проверенными botId и server-generated accountRef.
// Service chat и display metadata живут внутри account namespace.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat, mkdir, open, rename, unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { assertAccountRef } from '../inbox/identity.js';
import { isBotTokenShape, maskToken } from './token.js';
import { normalizeTelegramBotId } from './account-bindings.js';

const MAX_BYTES = 64 * 1024;
const KEYS = [
  'schemaVersion', 'channel', 'accountRef', 'botId', 'token', 'connectedAtMs', 'updatedAtMs',
];
const INPUT_KEYS = KEYS.filter((key) => !['schemaVersion', 'channel', 'updatedAtMs'].includes(key));

export class TelegramCredentialsError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TelegramCredentialsError';
    this.code = code;
    this.statusCode = 500;
  }
}

const fail = (code, message, cause = null) => {
  throw new TelegramCredentialsError(code, message, cause);
};

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value, keys, where) {
  if (!isPlainObject(value)) fail('telegram_credentials_invalid', `${where}: ожидался объект.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('telegram_credentials_invalid', `${where}: поля не совпадают со schema v1.`);
  }
}

function timestamp(value, where) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('telegram_credentials_invalid', `${where}: ожидались положительные Unix milliseconds.`);
  }
  return value;
}

function tokenOf(value, botId) {
  if (typeof value !== 'string' || !isBotTokenShape(value)
      || value.length > 16 * 1024 || /[\0\r\n\s]/u.test(value)) {
    fail('telegram_credentials_invalid', 'Telegram token имеет неверный формат.');
  }
  const prefix = value.slice(0, value.indexOf(':'));
  if (normalizeTelegramBotId(prefix, 'token bot id') !== botId) {
    fail('telegram_credentials_owner_mismatch', 'Telegram token принадлежит другому botId.');
  }
  return value;
}

function normalize(value, { stored = false, nowMs = null } = {}) {
  exact(value, stored ? KEYS : INPUT_KEYS, 'Telegram credentials');
  if (stored && (value.schemaVersion !== 1 || value.channel !== 'telegram')) {
    fail('telegram_credentials_invalid', 'Telegram credentials поддерживает только schema v1.');
  }
  let accountRef;
  try { accountRef = assertAccountRef(value.accountRef); } catch (error) {
    fail('telegram_credentials_invalid', 'Telegram credentials содержит неверный accountRef.', error);
  }
  const botId = normalizeTelegramBotId(value.botId);
  const connectedAtMs = timestamp(value.connectedAtMs, 'connectedAtMs');
  const updatedAtMs = stored ? timestamp(value.updatedAtMs, 'updatedAtMs') : timestamp(nowMs, 'updatedAtMs');
  return {
    schemaVersion: 1,
    channel: 'telegram',
    accountRef,
    botId,
    token: tokenOf(value.token, botId),
    connectedAtMs,
    updatedAtMs,
  };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function readStable(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('telegram_credentials_unsafe', 'Telegram credentials нельзя безопасно открыть.', error);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_BYTES || (before.mode & 0o077) !== 0) {
      fail('telegram_credentials_unsafe', 'Telegram credentials должен быть небольшим owner-only файлом.');
    }
    const bytes = await handle.readFile();
    const [after, atPath] = await Promise.all([handle.stat(), lstat(file)]);
    if (!after.isFile() || atPath.isSymbolicLink() || !atPath.isFile()
        || !sameFile(before, after) || !sameFile(after, atPath) || bytes.length !== after.size) {
      fail('telegram_credentials_changed', 'Telegram credentials изменился во время чтения.');
    }
    return bytes;
  } catch (error) {
    if (error instanceof TelegramCredentialsError) throw error;
    fail('telegram_credentials_unsafe', 'Telegram credentials нельзя безопасно прочитать.', error);
  } finally {
    await handle?.close();
  }
}

async function readDocument(file) {
  const bytes = await readStable(file);
  if (bytes === null) return null;
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (error) {
    fail('telegram_credentials_invalid', 'Telegram credentials не является корректным JSON.', error);
  }
  return normalize(parsed, { stored: true });
}

async function regularTarget(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      fail('telegram_credentials_unsafe', 'Telegram credentials target не является обычным файлом.');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error instanceof TelegramCredentialsError) throw error;
    fail('telegram_credentials_unsafe', 'Telegram credentials target нельзя проверить.', error);
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY
      | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    fail('telegram_credentials_unsafe', 'Каталог Telegram credentials небезопасен.');
  }
  await regularTarget(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
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
    await regularTarget(file);
    await rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (error instanceof TelegramCredentialsError) throw error;
    fail('telegram_credentials_write_failed', 'Telegram credentials не удалось записать.', error);
  }
}

const clone = (value) => structuredClone(value);

export class TelegramCredentialsStore {
  constructor({ file, now = Date.now } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) {
      throw new TypeError('TelegramCredentialsStore: file должен быть абсолютным trusted path.');
    }
    if (typeof now !== 'function') throw new TypeError('TelegramCredentialsStore: now должен быть функцией.');
    this.file = file;
    this.now = now;
    this.queue = Promise.resolve();
  }

  _queued(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async read() {
    const value = await readDocument(this.file);
    return value ? clone(value) : null;
  }

  async write(value) {
    return this._queued(async () => {
      const document = normalize(value, { nowMs: this.now() });
      await atomicWrite(this.file, document);
      return clone(document);
    });
  }

  async clear() {
    return this._queued(async () => {
      await regularTarget(this.file);
      try {
        await unlink(this.file);
        await syncDirectory(path.dirname(this.file));
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        fail('telegram_credentials_write_failed', 'Telegram credentials не удалось удалить.', error);
      }
    });
  }

  async publicView() {
    const value = await readDocument(this.file);
    if (!value) {
      return {
        configured: false,
        botId: null,
        tokenHint: '',
        connectedAtMs: null,
      };
    }
    return {
      configured: true,
      botId: value.botId,
      tokenHint: maskToken(value.token),
      connectedAtMs: value.connectedAtMs,
    };
  }
}
