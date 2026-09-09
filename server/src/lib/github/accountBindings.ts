// Durable binding проверенного GitHub repository к случайному accountRef Cockpit.
//
// Provider identity здесь намеренно не строка owner/name: репозиторий можно
// переименовать или перенести. Единственный owner namespace — exact tuple с
// неизменяемым numeric repository.id, полученным из проверенного webhook/API.
import { randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat, mkdir, open, rename, unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { assertAccountRef } from '../inbox/identity.ts';
import type { Stats } from 'node:fs';

const MAX_BINDINGS_BYTES = 1024 * 1024;
const REPOSITORY_ID_RE = /^[1-9]\d{0,39}$/;
const DOCUMENT_KEYS = ['schemaVersion', 'channel', 'selectedAccountRef', 'updatedAtMs', 'bindings'];
const BINDING_KEYS = ['accountRef', 'providerIdentity', 'createdAtMs'];

export class GitHubStoreError extends Error {
  code: string;

  constructor(code: string, message: string, cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GitHubStoreError';
    this.code = code;
  }
}

// Неизменяемая identity репозитория: версия схемы, хост, вид объекта и numeric id.
// Имя владельца и название сюда не входят намеренно — их можно поменять.
export type GitHubRepositoryIdentity = readonly [1, 'github.com', 'repository', string];

export interface GitHubBinding {
  accountRef: string;
  providerIdentity: readonly (string | number)[];
  createdAtMs: number;
}

export interface GitHubBindingsDocument {
  schemaVersion: 1;
  channel: 'github';
  selectedAccountRef: string | null;
  updatedAtMs: number | null;
  bindings: GitHubBinding[];
}

export interface FileSnapshot {
  bytes: Buffer;
  info: Stats;
}

export interface JsonSnapshot {
  data: unknown;
  info: Stats;
}

export interface ReadFileOptions {
  missing?: unknown;
  maxBytes?: number;
  privateFile?: boolean;
}

export interface GitHubAccountBindingsOptions {
  file: string;
  randomBytes?: (size: number) => Uint8Array;
  now?: () => number;
}

type Payload = Record<string, unknown>;

function fail(code: string, message: string, cause: unknown = null): never {
  throw new GitHubStoreError(code, message, cause);
}

// Ошибка файловой системы своего типа не обещает, а решение принимается по коду:
// отсутствие файла — обычное состояние, всё остальное здесь фатально.
function failureCode(error: unknown): string {
  const code = error !== null && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;

  return typeof code === 'string' ? code : '';
}

function isPlainObject(value: unknown): value is Payload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactObject(value: unknown, keys: string[], where: string): void {
  if (!isPlainObject(value)) fail('github_store_invalid', `${where}: ожидался объект.`);
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (own.length !== expected.length || own.some((key, index) => key !== expected[index])) {
    fail('github_store_invalid', `${where}: схема полей не совпадает с версией 1.`);
  }
}

function safeTimestamp(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail('github_store_invalid', `${where}: ожидались положительные Unix milliseconds.`);
  }

  return value;
}

/** Numeric provider id в канонической строковой форме, без aliases вроде 01. */
export function normalizeGitHubRepositoryId(value: unknown, where = 'repositoryId'): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail('github_identity_invalid', `${where}: ожидался положительный safe integer или его строка.`);
    }
    return String(value);
  }
  if (typeof value !== 'string' || !REPOSITORY_ID_RE.test(value)) {
    fail('github_identity_invalid', `${where}: ожидалась каноническая положительная decimal-строка.`);
  }
  return value;
}

/** Immutable provider identity одного GitHub repository. */
export function githubRepositoryIdentity(repositoryId: unknown): GitHubRepositoryIdentity {
  return Object.freeze([
    1,
    'github.com',
    'repository',
    normalizeGitHubRepositoryId(repositoryId),
  ] as const);
}

/** Принимает только exact tuple; owner/name и числовой id тут не являются identity. */
export function normalizeGitHubRepositoryIdentity(
  value: unknown,
  where = 'providerIdentity',
): GitHubRepositoryIdentity {
  if (!Array.isArray(value) || value.length !== 4
      || value[0] !== 1 || value[1] !== 'github.com' || value[2] !== 'repository'
      || typeof value[3] !== 'string') {
    fail('github_identity_invalid', `${where}: ожидался exact GitHub repository identity tuple версии 1.`);
  }
  return githubRepositoryIdentity(value[3]);
}

export function repositoryIdFromIdentity(identity: unknown): string {
  return normalizeGitHubRepositoryIdentity(identity)[3];
}

function sameInfo(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

/**
 * Один fd-snapshot обычного файла. O_NOFOLLOW и повторная inode/path проверка
 * не дают прочитать подменённый symlink или склеить две версии файла.
 */
export async function readStableFileNoFollow(file: string, {
  missing = null,
  maxBytes = MAX_BINDINGS_BYTES,
  privateFile = false,
}: ReadFileOptions = {}): Promise<FileSnapshot | unknown> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (err) {
    if (failureCode(err) === 'ENOENT') return missing;
    fail('github_store_unsafe', 'GitHub store нельзя безопасно открыть.', err);
  }

  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) {
      fail('github_store_unsafe', 'GitHub store не является допустимым обычным файлом.');
    }
    if (privateFile && (before.mode & 0o077) !== 0) {
      fail('github_store_permissions', 'Файл GitHub credentials должен иметь права 0600.');
    }
    const bytes = await handle.readFile();
    const [after, atPath] = await Promise.all([handle.stat(), lstat(file)]);
    if (!after.isFile() || atPath.isSymbolicLink() || !atPath.isFile()
        || !sameInfo(before, after) || !sameInfo(after, atPath)
        || bytes.length !== after.size) {
      fail('github_store_changed', 'GitHub store изменился во время чтения.');
    }
    return { bytes, info: after };
  } catch (err) {
    if (err instanceof GitHubStoreError) throw err;
    fail('github_store_unsafe', 'GitHub store нельзя безопасно прочитать.', err);
  } finally {
    await handle?.close();
  }
}

export async function readJsonNoFollow(
  file: string,
  opts: ReadFileOptions = {},
): Promise<JsonSnapshot | null> {
  const missing = Object.hasOwn(opts, 'missing') ? opts.missing : null;
  const snapshot = await readStableFileNoFollow(file, { ...opts, missing });
  if (snapshot === missing) return snapshot as null;
  const file_ = snapshot as FileSnapshot;
  try {
    return { data: JSON.parse(file_.bytes.toString('utf8')) as unknown, info: file_.info };
  } catch (err) {
    fail('github_store_invalid', 'GitHub JSON store имеет неверный формат.', err);
  }
}

async function assertRegularTarget(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      fail('github_store_unsafe', 'GitHub store нельзя заменить: target не является обычным файлом.');
    }
  } catch (err) {
    if (failureCode(err) === 'ENOENT') return;
    if (err instanceof GitHubStoreError) throw err;
    fail('github_store_unsafe', 'GitHub store нельзя проверить перед записью.', err);
  }
}

async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, constants.O_RDONLY
      | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

/** Unique temp + fsync + atomic rename. Все приватные JSON stores пишутся 0600. */
export async function atomicWriteJson(
  file: string,
  value: unknown,
  { mode = 0o600 }: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const parent = await lstat(dir);
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    fail('github_store_unsafe', 'Каталог GitHub store не является обычным каталогом.');
  }
  await assertRegularTarget(file);

  const body = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      mode,
    );
    await handle.writeFile(body, 'utf8');
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = null;

    // Target мог появиться между первой проверкой и rename. Symlink не читаем и
    // не используем как источник истины даже несмотря на то, что rename заменил бы его сам.
    await assertRegularTarget(file);
    await rename(temporary, file);
    await syncDirectory(dir);
  } catch (err) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (err instanceof GitHubStoreError) throw err;
    fail('github_store_write_failed', 'GitHub store не удалось записать атомарно.', err);
  }
}

export async function unlinkRegularFile(file: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(file);
  } catch (err) {
    if (failureCode(err) === 'ENOENT') return false;
    fail('github_store_unsafe', 'GitHub store нельзя проверить перед удалением.', err);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    fail('github_store_unsafe', 'GitHub store нельзя удалить: target не является обычным файлом.');
  }
  try {
    await unlink(file);
    await syncDirectory(path.dirname(file));
    return true;
  } catch (err) {
    fail('github_store_write_failed', 'GitHub store не удалось удалить.', err);
  }
}

function validateDocument(raw: unknown): GitHubBindingsDocument {
  exactObject(raw, DOCUMENT_KEYS, 'GitHub account bindings');
  const source = raw as Payload;
  if (source.schemaVersion !== 1 || source.channel !== 'github' || !Array.isArray(source.bindings)) {
    fail('github_store_invalid', 'GitHub account bindings имеет неверную схему версии 1.');
  }
  const updatedAtMs = safeTimestamp(source.updatedAtMs, 'updatedAtMs');

  const identities = new Set<string>();
  const accounts = new Set<string>();
  const bindings = (source.bindings as Payload[]).map((binding, index): GitHubBinding => {
    exactObject(binding, BINDING_KEYS, `bindings[${index}]`);
    let accountRef: string;
    try { accountRef = assertAccountRef(binding.accountRef) as string; } catch (err) {
      fail('github_store_invalid', `bindings[${index}].accountRef имеет неверный формат.`, err);
    }
    const providerIdentity = normalizeGitHubRepositoryIdentity(
      binding.providerIdentity,
      `bindings[${index}].providerIdentity`,
    );
    const identityKey = JSON.stringify(providerIdentity);
    if (identities.has(identityKey) || accounts.has(accountRef)) {
      fail('github_binding_conflict', 'GitHub account bindings содержит конфликт identity/accountRef.');
    }
    identities.add(identityKey);
    accounts.add(accountRef);
    return {
      accountRef,
      providerIdentity: [...providerIdentity],
      createdAtMs: safeTimestamp(binding.createdAtMs, `bindings[${index}].createdAtMs`),
    };
  });
  let selectedAccountRef: string | null = null;
  if (source.selectedAccountRef !== null) {
    try { selectedAccountRef = assertAccountRef(source.selectedAccountRef) as string; } catch (err) {
      fail('github_store_invalid', 'selectedAccountRef имеет неверный формат.', err);
    }
    if (!accounts.has(selectedAccountRef)) {
      fail('github_binding_conflict', 'selectedAccountRef не ссылается на известный binding.');
    }
  }
  return {
    schemaVersion: 1,
    channel: 'github',
    selectedAccountRef,
    updatedAtMs,
    bindings,
  };
}

const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;

export class GitHubAccountBindings {
  file: string;

  randomBytes: (size: number) => Uint8Array;

  now: () => number;

  queue: Promise<unknown>;

  constructor({
    file,
    randomBytes = cryptoRandomBytes,
    now = Date.now,
  }: GitHubAccountBindingsOptions) {
    if (typeof file !== 'string' || !file) throw new TypeError('GitHubAccountBindings: file обязателен.');
    this.file = file;
    this.randomBytes = randomBytes;
    this.now = now;
    this.queue = Promise.resolve();
  }

  _enqueue<Result>(fn: () => Promise<Result>): Promise<Result> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  async _read() {
    const snapshot = await readJsonNoFollow(this.file, { missing: null, maxBytes: MAX_BINDINGS_BYTES });
    if (!snapshot) {
      return {
        schemaVersion: 1,
        channel: 'github',
        selectedAccountRef: null,
        updatedAtMs: null,
        bindings: [],
      };
    }
    return validateDocument(snapshot.data);
  }

  async read() {
    return clone(await this._read());
  }

  async lookup(identity: unknown): Promise<GitHubBinding | null> {
    const key = JSON.stringify(normalizeGitHubRepositoryIdentity(identity));
    const document = await this._read();
    const binding = document.bindings.find((entry) => JSON.stringify(entry.providerIdentity) === key);
    return binding ? clone(binding) : null;
  }

  async byAccountRef(accountRef: unknown): Promise<GitHubBinding | null> {
    let owner: string;
    try { owner = assertAccountRef(accountRef) as string; } catch (err) {
      fail('github_identity_invalid', 'accountRef имеет неверный формат.', err);
    }
    const document = await this._read();
    const binding = document.bindings.find((entry) => entry.accountRef === owner);
    return binding ? clone(binding) : null;
  }

  /** Последний выбранный verified account сохраняется и после очистки credentials. */
  async selected(): Promise<GitHubBinding | null> {
    const document = await this._read();
    if (document.selectedAccountRef === null) return null;
    const binding = document.bindings
      .find((entry) => entry.accountRef === document.selectedAccountRef);
    // validateDocument уже доказал ссылочную целостность.
    return binding ? clone(binding) : null;
  }

  async select(accountRef: unknown): Promise<GitHubBinding> {
    let owner: string;
    try { owner = assertAccountRef(accountRef) as string; } catch (err) {
      fail('github_identity_invalid', 'accountRef имеет неверный формат.', err);
    }
    return this._enqueue(async () => {
      const document = await this._read();
      const binding = document.bindings.find((entry) => entry.accountRef === owner);
      if (!binding) fail('github_binding_missing', 'Нельзя выбрать неизвестный GitHub accountRef.');
      if (document.selectedAccountRef !== owner) {
        const nowMs = this.now();
        safeTimestamp(nowMs, 'nowMs');
        await atomicWriteJson(this.file, validateDocument({
          ...document,
          selectedAccountRef: owner,
          updatedAtMs: nowMs,
        }));
      }
      return clone(binding);
    });
  }

  /** Не использовать при обычном disconnect: он обязан сохранить offline owner. */
  async clearSelection(): Promise<boolean> {
    return this._enqueue(async () => {
      const document = await this._read();
      if (document.selectedAccountRef === null) return false;
      const nowMs = this.now();
      safeTimestamp(nowMs, 'nowMs');
      await atomicWriteJson(this.file, validateDocument({
        ...document,
        selectedAccountRef: null,
        updatedAtMs: nowMs,
      }));
      return true;
    });
  }

  async resolveOrCreate(
    identity: unknown,
    { select = true }: { select?: boolean } = {},
  ): Promise<{ created: boolean; selected: boolean; binding: GitHubBinding }> {
    const providerIdentity = [...normalizeGitHubRepositoryIdentity(identity)];
    const key = JSON.stringify(providerIdentity);
    return this._enqueue(async () => {
      const document = await this._read();
      const known = document.bindings.find((entry) => JSON.stringify(entry.providerIdentity) === key);
      if (known) {
        if (select && document.selectedAccountRef !== known.accountRef) {
          const nowMs = this.now();
          safeTimestamp(nowMs, 'nowMs');
          await atomicWriteJson(this.file, validateDocument({
            ...document,
            selectedAccountRef: known.accountRef,
            updatedAtMs: nowMs,
          }));
        }
        return { created: false, selected: select, binding: clone(known) };
      }

      const occupied = new Set(document.bindings.map((entry) => entry.accountRef));
      let accountRef: string | null = null;
      for (let attempt = 0; attempt < 16 && !accountRef; attempt += 1) {
        const bytes = this.randomBytes(24);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16) {
          fail('github_random_failed', 'Генератор accountRef вернул недостаточно случайных байтов.');
        }
        const candidate = `acc_${Buffer.from(bytes).toString('base64url')}`;
        try { assertAccountRef(candidate); } catch (err) {
          fail('github_random_failed', 'Сгенерированный accountRef не прошёл проверку.', err);
        }
        if (!occupied.has(candidate)) accountRef = candidate;
      }
      if (!accountRef) fail('github_binding_conflict', 'Не удалось получить уникальный GitHub accountRef.');

      const nowMs = this.now();
      safeTimestamp(nowMs, 'nowMs');
      const binding = { accountRef, providerIdentity, createdAtMs: nowMs };
      const next = validateDocument({
        schemaVersion: 1,
        channel: 'github',
        selectedAccountRef: select ? accountRef : document.selectedAccountRef,
        updatedAtMs: nowMs,
        bindings: [...document.bindings, binding],
      });
      await atomicWriteJson(this.file, next);
      return { created: true, selected: select, binding: clone(binding) };
    });
  }
}
