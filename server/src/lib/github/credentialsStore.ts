// Активный lifecycle GitHub connection. PAT и webhook secret никогда не лежат
// в prefs и никогда не входят в publicView(): prefs целиком доступны браузеру.
//
// `clear()` намеренно требует уже опубликованного cleanup_pending и явного
// подтверждения завершённой очистки. Так disconnect не может сначала стереть
// единственные данные, которыми ещё надо удалить/инвалидировать webhook.
import {
  GitHubStoreError,
  atomicWriteJson,
  normalizeGitHubRepositoryId,
  readJsonNoFollow,
  unlinkRegularFile,
} from './accountBindings.ts';
import { assertAccountRef } from '../inbox/identity.ts';

const MAX_CREDENTIALS_BYTES = 128 * 1024;
const STATES = new Set(['pending', 'connected', 'cleanup_pending']);
const STORED_KEYS = [
  'schemaVersion', 'state', 'token', 'secret', 'ingressRef', 'callbackUrl', 'hookId', 'generation',
  'accountRef', 'repositoryId', 'fullName', 'connectedAt', 'updatedAtMs',
];
const INPUT_KEYS = STORED_KEYS.filter((key) => !['schemaVersion', 'updatedAtMs'].includes(key));
const INGRESS_RE = /^[A-Za-z0-9_-]{16,160}$/;
const HOOK_ID_RE = /^[1-9]\d{0,39}$/;

// Durable lifecycle подключения. Токен и секрет webhook живут только здесь и
// наружу не отдаются: они нужны как способ найти и снять чужой hook после сбоя.
export interface GitHubCredentials {
  schemaVersion: 1;
  state: string;
  token: string;
  secret: string;
  ingressRef: string;
  callbackUrl: string;
  hookId: string | null;
  generation: number;
  accountRef: string | null;
  repositoryId: string | null;
  fullName: string | null;
  connectedAt: number | null;
  updatedAtMs: number | null;
}

// Проекция для браузера: ни токена, ни секрета, ни внутреннего accountRef.
export interface GitHubCredentialsView {
  configured: boolean;
  state: string | null;
  repositoryId: string | null;
  fullName: string | null;
  connectedAt: number | null;
  hasToken: boolean;
}

type Payload = Record<string, unknown>;

function fail(code: string, message: string, cause: unknown = null): never {
  throw new GitHubStoreError(code, message, cause);
}

function isPlainObject(value: unknown): value is Payload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactObject(value: unknown, keys: string[], where: string): void {
  if (!isPlainObject(value)) fail('github_credentials_invalid', `${where}: ожидался объект.`);
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (own.length !== expected.length || own.some((key, index) => key !== expected[index])) {
    fail('github_credentials_invalid', `${where}: схема полей не совпадает с версией 1.`);
  }
}

function boundedSecret(
  value: unknown,
  where: string,
  { nullable = false, maxBytes = 8192 }: { nullable?: boolean; maxBytes?: number } = {},
): string {
  if (nullable && value === null) return null as unknown as string;
  if (typeof value !== 'string') fail('github_credentials_invalid', `${where}: ожидалась строка.`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 1 || bytes > maxBytes || /[\0\r\n]/u.test(value)) {
    fail('github_credentials_invalid', `${where}: секрет имеет недопустимый формат или размер.`);
  }
  return value;
}

function nullableRepositoryId(value: unknown, where: string): string | null {
  if (value === null) return null;
  return normalizeGitHubRepositoryId(value, where);
}

function nullableAccountRef(value: unknown, where: string): string | null {
  if (value === null) return null;
  try { return assertAccountRef(value, where) as string; } catch (err) {
    fail('github_credentials_invalid', `${where}: неверный server accountRef.`, err);
  }
}

function nullableHookId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !HOOK_ID_RE.test(value)) {
    fail('github_credentials_invalid', 'hookId: ожидалась каноническая decimal-строка или null.');
  }
  return value;
}

function managedCallbackUrl(value: unknown, ingressRef: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096) {
    fail('github_credentials_invalid', 'callbackUrl: ожидался bounded HTTPS URL.');
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch (err) {
    fail('github_credentials_invalid', 'callbackUrl: ожидался корректный HTTPS URL.', err);
  }
  const suffix = `/${encodeURIComponent(ingressRef)}`;
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || parsed.search || parsed.hash || !parsed.pathname.endsWith(suffix)
      || parsed.toString() !== value) {
    fail(
      'github_credentials_invalid',
      'callbackUrl: URL должен быть canonical HTTPS без credentials/query/fragment и заканчиваться ingressRef.',
    );
  }
  return value;
}

function nullableTimestamp(value: unknown, where: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail('github_credentials_invalid', `${where}: ожидались положительные Unix milliseconds или null.`);
  }
  return value;
}

function fullName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 300
      || !/^[^/\s\x00-\x1f\x7f]+\/[^/\s\x00-\x1f\x7f]+$/u.test(value)) {
    fail('github_credentials_invalid', 'fullName: ожидалось безопасное owner/repository или null.');
  }
  return value;
}

function validateLifecycle(
  source: unknown,
  { stored = false, nowMs = null }: { stored?: boolean; nowMs?: number | null } = {},
): GitHubCredentials {
  exactObject(source, stored ? STORED_KEYS : INPUT_KEYS, 'GitHub credentials');
  const raw = source as Payload;
  if (stored && raw.schemaVersion !== 1) {
    fail('github_credentials_invalid', 'GitHub credentials: поддерживается только schemaVersion 1.');
  }
  if (!STATES.has(raw.state as string)) {
    fail('github_credentials_invalid', 'GitHub credentials.state неизвестен.');
  }
  if (typeof raw.generation !== 'number'
      || !Number.isSafeInteger(raw.generation) || raw.generation <= 0) {
    fail('github_credentials_invalid', 'GitHub credentials.generation должен быть положительным safe integer.');
  }
  if (typeof raw.ingressRef !== 'string' || !INGRESS_RE.test(raw.ingressRef)) {
    fail('github_credentials_invalid', 'GitHub credentials.ingressRef имеет неверный opaque формат.');
  }

  const document: GitHubCredentials = {
    schemaVersion: 1,
    state: raw.state as string,
    // Пока lifecycle существует, PAT нужен как recovery capability для exact
    // lookup/delete remote hook. Обнулять его до завершённого cleanup нельзя.
    token: boundedSecret(raw.token, 'token', { maxBytes: 16 * 1024 }),
    secret: boundedSecret(raw.secret, 'secret', { maxBytes: 1024 }),
    ingressRef: raw.ingressRef,
    // Exact callback — часть recovery WAL. Его нельзя пересобирать из новой
    // конфигурации после crash: иначе старый remote hook станет orphan.
    callbackUrl: managedCallbackUrl(raw.callbackUrl, raw.ingressRef),
    hookId: nullableHookId(raw.hookId),
    generation: raw.generation,
    accountRef: nullableAccountRef(raw.accountRef, 'accountRef'),
    repositoryId: nullableRepositoryId(raw.repositoryId, 'repositoryId'),
    fullName: fullName(raw.fullName),
    connectedAt: nullableTimestamp(raw.connectedAt, 'connectedAt'),
    updatedAtMs: stored ? nullableTimestamp(raw.updatedAtMs, 'updatedAtMs') : nowMs,
  };
  if (document.updatedAtMs === null) {
    fail('github_credentials_invalid', 'GitHub credentials.updatedAtMs обязателен.');
  }

  const repositoryIdentity = [
    document.accountRef,
    document.repositoryId,
    document.fullName,
  ];
  const identityNone = repositoryIdentity.every((value) => value === null);
  const identityComplete = repositoryIdentity.every((value) => value !== null);
  const draft = identityNone && document.hookId === null && document.connectedAt === null;
  // WAL-stage перед первым remote side effect. Если process погибнет во время
  // createHook, exact callback уже можно найти по durable fullName+ingressRef.
  const verifiedNoHook = identityComplete
    && document.hookId === null
    && document.connectedAt === null;
  const waitingPing = identityComplete
    && document.hookId !== null
    && document.connectedAt === null;
  const connected = identityComplete
    && document.hookId !== null
    && document.connectedAt !== null;
  if (document.state === 'pending') {
    if (!draft && !verifiedNoHook && !waitingPing) {
      fail(
        'github_credentials_invalid',
        'pending connection должна быть draft, verified_no_hook или ожидать signed ping.',
      );
    }
  } else if (document.state === 'connected') {
    if (!connected) {
      fail('github_credentials_invalid', 'connected: verified identity, hookId и connectedAt обязательны.');
    }
  } else if (!draft && !verifiedNoHook && !waitingPing && !connected) {
    // cleanup_pending разрешает очистку из любой durable WAL-stage.
    // Частичная verified identity всегда запрещена.
    fail(
      'github_credentials_invalid',
      'cleanup_pending: connection должна быть draft или иметь полную verified identity.',
    );
  }

  return document;
}

const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;

export class GitHubCredentialsStore {
  file: string;

  now: () => number;

  queue: Promise<unknown>;

  constructor({ file, now = Date.now }: { file?: string; now?: () => number }) {
    if (typeof file !== 'string' || !file) throw new TypeError('GitHubCredentialsStore: file обязателен.');
    this.file = file;
    this.now = now;
    this.queue = Promise.resolve();
  }

  _enqueue<Result>(fn: () => Promise<Result>): Promise<Result> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  async _read(): Promise<GitHubCredentials | null> {
    const snapshot = await readJsonNoFollow(this.file, {
      missing: null,
      maxBytes: MAX_CREDENTIALS_BYTES,
      privateFile: true,
    });
    return snapshot ? validateLifecycle(snapshot.data, { stored: true }) : null;
  }

  /** Trusted server view с token/secret. Наружу его передавать нельзя. */
  async read(): Promise<GitHubCredentials | null> {
    const value = await this._read();
    return value ? clone(value) : null;
  }

  async write(value: unknown): Promise<GitHubCredentials> {
    return this._enqueue(async () => {
      const nowMs = this.now();
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
        fail('github_credentials_invalid', 'nowMs должен быть положительным Unix milliseconds.');
      }
      const document = validateLifecycle(value, { nowMs });
      await atomicWriteJson(this.file, document, { mode: 0o600 });
      return clone(document);
    });
  }

  /** Exact patch существующего lifecycle; неизвестные поля отвергаются. */
  async update(patch: unknown): Promise<GitHubCredentials> {
    if (!isPlainObject(patch)) {
      fail('github_credentials_invalid', 'GitHub credentials patch должен быть объектом.');
    }
    const allowed = new Set(INPUT_KEYS);
    if (!Object.keys(patch).length || Object.keys(patch).some((key) => !allowed.has(key))) {
      fail('github_credentials_invalid', 'GitHub credentials patch пуст или содержит неизвестные поля.');
    }
    return this._enqueue(async () => {
      const current = await this._read();
      if (!current) fail('github_credentials_missing', 'GitHub connection ещё не настроен.');
      const known = current as unknown as Payload;
      const input = Object.fromEntries(INPUT_KEYS.map((key) => [
        key,
        Object.hasOwn(patch, key) ? patch[key] : known[key],
      ]));
      const nowMs = this.now();
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
        fail('github_credentials_invalid', 'nowMs должен быть положительным Unix milliseconds.');
      }
      const document = validateLifecycle(input, { nowMs });
      await atomicWriteJson(this.file, document, { mode: 0o600 });
      return clone(document);
    });
  }

  /** Полное удаление возможно только после завершённой внешней/local cleanup. */
  async clear({ cleanupComplete = false }: { cleanupComplete?: boolean } = {}): Promise<boolean> {
    return this._enqueue(async () => {
      const current = await this._read();
      if (!current) return false;
      if (current.state !== 'cleanup_pending' || cleanupComplete !== true) {
        fail(
          'github_cleanup_required',
          'GitHub credentials удаляются только из cleanup_pending после подтверждённой очистки.',
        );
      }
      return unlinkRegularFile(this.file);
    });
  }

  /** Безопасный DTO: PAT, secret и внутренний accountRef отсутствуют рекурсивно. */
  async publicView(): Promise<GitHubCredentialsView> {
    const value = await this._read();
    if (!value) {
      return {
        configured: false,
        state: null,
        repositoryId: null,
        fullName: null,
        connectedAt: null,
        hasToken: false,
      };
    }
    return {
      configured: true,
      state: value.state,
      repositoryId: value.repositoryId,
      fullName: value.fullName,
      connectedAt: value.connectedAt,
      hasToken: value.token !== null,
    };
  }
}
