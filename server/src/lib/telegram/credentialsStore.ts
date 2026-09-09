// Credential активной account-aware Telegram connection.
// Token жёстко связан с проверенными botId и server-generated accountRef.
// Service chat и display metadata живут внутри account namespace.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat, mkdir, open, rename, unlink,
} from 'node:fs/promises';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';

import { assertAccountRef } from '../inbox/identity.ts';
import { isBotTokenShape, maskToken } from './token.ts';
import { normalizeTelegramBotId } from './accountBindings.ts';

type Payload = Record<string, unknown>;

// Учётные данные активного подключения. Токен связан с проверенными botId и
// server-generated accountRef: подменить одно, оставив другое, нельзя.
export interface TelegramCredentials {
  schemaVersion: 1;
  channel: string;
  accountRef: string;
  botId: string;
  token: string;
  connectedAtMs: number;
  updatedAtMs: number;
}

const errorCode = (err: unknown) => (err as { code?: unknown } | null)?.code;

const MAX_BYTES = 64 * 1024;
const KEYS = [
  'schemaVersion', 'channel', 'accountRef', 'botId', 'token', 'connectedAtMs', 'updatedAtMs',
];
const INPUT_KEYS = KEYS.filter((key) => !['schemaVersion', 'channel', 'updatedAtMs'].includes(key));

export class TelegramCredentialsError extends Error {
  code: string;

  statusCode: number;

  constructor(code: string, message: string, cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TelegramCredentialsError';
    this.code = code;
    this.statusCode = 500;
  }
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (code: string, message: string, cause?: unknown) => never = (
  code,
  message,
  cause = null,
) => {
  throw new TelegramCredentialsError(code, message, cause);
};

function isPlainObject(value: unknown): value is Payload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value: unknown, keys: string[], where: string): void {
  if (!isPlainObject(value)) fail('telegram_credentials_invalid', `${where}: ожидался объект.`);

  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('telegram_credentials_invalid', `${where}: поля не совпадают со schema v1.`);
  }
}

function timestamp(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    fail('telegram_credentials_invalid', `${where}: ожидались положительные Unix milliseconds.`);
  }

  return value as number;
}

function tokenOf(value: unknown, botId: string): string {
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

function normalize(source: unknown, { stored = false, nowMs = null }: {
  stored?: boolean;
  nowMs?: number | null;
} = {}): TelegramCredentials {
  exact(source, stored ? KEYS : INPUT_KEYS, 'Telegram credentials');

  const value = source as Payload;

  if (stored && (value.schemaVersion !== 1 || value.channel !== 'telegram')) {
    fail('telegram_credentials_invalid', 'Telegram credentials поддерживает только schema v1.');
  }

  let accountRef: string;

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

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function readStable(file: string): Promise<Buffer | null> {
  let handle: FileHandle | null | undefined;

  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
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

    return fail(
      'telegram_credentials_unsafe',
      'Telegram credentials нельзя безопасно прочитать.',
      error,
    );
  } finally {
    await handle?.close();
  }
}

async function readDocument(file: string): Promise<TelegramCredentials | null> {
  const bytes = await readStable(file);

  if (bytes === null) return null;

  let parsed: unknown;

  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (error) {
    fail('telegram_credentials_invalid', 'Telegram credentials не является корректным JSON.', error);
  }
  return normalize(parsed, { stored: true });
}

async function regularTarget(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      fail('telegram_credentials_unsafe', 'Telegram credentials target не является обычным файлом.');
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    if (error instanceof TelegramCredentialsError) throw error;
    fail('telegram_credentials_unsafe', 'Telegram credentials target нельзя проверить.', error);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | null | undefined;

  try {
    handle = await open(directory, constants.O_RDONLY
      | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(file: string, value: TelegramCredentials): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    fail('telegram_credentials_unsafe', 'Каталог Telegram credentials небезопасен.');
  }
  await regularTarget(file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | null | undefined;

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

const clone = <Value>(value: Value): Value => structuredClone(value);

export class TelegramCredentialsStore {
  file: string;

  now: () => number;

  queue: Promise<unknown>;

  constructor({ file, now = Date.now }: { file?: unknown; now?: () => number } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) {
      throw new TypeError('TelegramCredentialsStore: file должен быть абсолютным trusted path.');
    }
    if (typeof now !== 'function') throw new TypeError('TelegramCredentialsStore: now должен быть функцией.');
    this.file = file;
    this.now = now;
    this.queue = Promise.resolve();
  }

  _queued<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation, operation);

    this.queue = result.catch(() => {});

    return result;
  }

  async read(): Promise<TelegramCredentials | null> {
    const value = await readDocument(this.file);
    return value ? clone(value) : null;
  }

  async write(value: unknown): Promise<TelegramCredentials> {
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
        if (errorCode(error) === 'ENOENT') return false;

        return fail(
          'telegram_credentials_write_failed',
          'Telegram credentials не удалось удалить.',
          error,
        );
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
