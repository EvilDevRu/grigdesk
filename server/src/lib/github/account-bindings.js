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

import { assertAccountRef } from '../inbox/identity.js';

const MAX_BINDINGS_BYTES = 1024 * 1024;
const REPOSITORY_ID_RE = /^[1-9]\d{0,39}$/;
const DOCUMENT_KEYS = ['schemaVersion', 'channel', 'selectedAccountRef', 'updatedAtMs', 'bindings'];
const BINDING_KEYS = ['accountRef', 'providerIdentity', 'createdAtMs'];

export class GitHubStoreError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GitHubStoreError';
    this.code = code;
  }
}

function fail(code, message, cause = null) {
  throw new GitHubStoreError(code, message, cause);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactObject(value, keys, where) {
  if (!isPlainObject(value)) fail('github_store_invalid', `${where}: ожидался объект.`);
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (own.length !== expected.length || own.some((key, index) => key !== expected[index])) {
    fail('github_store_invalid', `${where}: схема полей не совпадает с версией 1.`);
  }
}

function safeTimestamp(value, where) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('github_store_invalid', `${where}: ожидались положительные Unix milliseconds.`);
  }
  return value;
}

/** Numeric provider id в канонической строковой форме, без aliases вроде 01. */
export function normalizeGitHubRepositoryId(value, where = 'repositoryId') {
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
export function githubRepositoryIdentity(repositoryId) {
  return Object.freeze([1, 'github.com', 'repository', normalizeGitHubRepositoryId(repositoryId)]);
}

/** Принимает только exact tuple; owner/name и числовой id тут не являются identity. */
export function normalizeGitHubRepositoryIdentity(value, where = 'providerIdentity') {
  if (!Array.isArray(value) || value.length !== 4
      || value[0] !== 1 || value[1] !== 'github.com' || value[2] !== 'repository'
      || typeof value[3] !== 'string') {
    fail('github_identity_invalid', `${where}: ожидался exact GitHub repository identity tuple версии 1.`);
  }
  return githubRepositoryIdentity(value[3]);
}

export function repositoryIdFromIdentity(identity) {
  return normalizeGitHubRepositoryIdentity(identity)[3];
}

function sameInfo(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

/**
 * Один fd-snapshot обычного файла. O_NOFOLLOW и повторная inode/path проверка
 * не дают прочитать подменённый symlink или склеить две версии файла.
 */
export async function readStableFileNoFollow(file, {
  missing = null,
  maxBytes = MAX_BINDINGS_BYTES,
  privateFile = false,
} = {}) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (err) {
    if (err?.code === 'ENOENT') return missing;
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

export async function readJsonNoFollow(file, opts = {}) {
  const missing = Object.hasOwn(opts, 'missing') ? opts.missing : null;
  const snapshot = await readStableFileNoFollow(file, { ...opts, missing });
  if (snapshot === missing) return snapshot;
  try {
    return { data: JSON.parse(snapshot.bytes.toString('utf8')), info: snapshot.info };
  } catch (err) {
    fail('github_store_invalid', 'GitHub JSON store имеет неверный формат.', err);
  }
}

async function assertRegularTarget(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      fail('github_store_unsafe', 'GitHub store нельзя заменить: target не является обычным файлом.');
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    if (err instanceof GitHubStoreError) throw err;
    fail('github_store_unsafe', 'GitHub store нельзя проверить перед записью.', err);
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

/** Unique temp + fsync + atomic rename. Все приватные JSON stores пишутся 0600. */
export async function atomicWriteJson(file, value, { mode = 0o600 } = {}) {
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

export async function unlinkRegularFile(file) {
  let info;
  try {
    info = await lstat(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
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

function validateDocument(raw) {
  exactObject(raw, DOCUMENT_KEYS, 'GitHub account bindings');
  if (raw.schemaVersion !== 1 || raw.channel !== 'github' || !Array.isArray(raw.bindings)) {
    fail('github_store_invalid', 'GitHub account bindings имеет неверную схему версии 1.');
  }
  safeTimestamp(raw.updatedAtMs, 'updatedAtMs');

  const identities = new Set();
  const accounts = new Set();
  const bindings = raw.bindings.map((binding, index) => {
    exactObject(binding, BINDING_KEYS, `bindings[${index}]`);
    let accountRef;
    try { accountRef = assertAccountRef(binding.accountRef); } catch (err) {
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
  let selectedAccountRef = null;
  if (raw.selectedAccountRef !== null) {
    try { selectedAccountRef = assertAccountRef(raw.selectedAccountRef); } catch (err) {
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
    updatedAtMs: raw.updatedAtMs,
    bindings,
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

export class GitHubAccountBindings {
  constructor({ file, randomBytes = cryptoRandomBytes, now = Date.now }) {
    if (typeof file !== 'string' || !file) throw new TypeError('GitHubAccountBindings: file обязателен.');
    this.file = file;
    this.randomBytes = randomBytes;
    this.now = now;
    this.queue = Promise.resolve();
  }

  _enqueue(fn) {
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

  async lookup(identity) {
    const key = JSON.stringify(normalizeGitHubRepositoryIdentity(identity));
    const document = await this._read();
    const binding = document.bindings.find((entry) => JSON.stringify(entry.providerIdentity) === key);
    return binding ? clone(binding) : null;
  }

  async byAccountRef(accountRef) {
    let owner;
    try { owner = assertAccountRef(accountRef); } catch (err) {
      fail('github_identity_invalid', 'accountRef имеет неверный формат.', err);
    }
    const document = await this._read();
    const binding = document.bindings.find((entry) => entry.accountRef === owner);
    return binding ? clone(binding) : null;
  }

  /** Последний выбранный verified account сохраняется и после очистки credentials. */
  async selected() {
    const document = await this._read();
    if (document.selectedAccountRef === null) return null;
    const binding = document.bindings.find((entry) => entry.accountRef === document.selectedAccountRef);
    // validateDocument уже доказал ссылочную целостность.
    return clone(binding);
  }

  async select(accountRef) {
    let owner;
    try { owner = assertAccountRef(accountRef); } catch (err) {
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
  async clearSelection() {
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

  async resolveOrCreate(identity, { select = true } = {}) {
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
      let accountRef = null;
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
