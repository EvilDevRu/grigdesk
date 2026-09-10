// Durable REST reconciliation cursor одного GitHub account namespace.
// Activation epochs живут отдельно в InboxStateStore; этот файл отвечает только
// за transport recovery и никогда не становится границей доступа Inbox.
import { assertAccountRef } from '../inbox/identity.ts';
import {
  GitHubStoreError,
  atomicWriteJson,
  normalizeGitHubRepositoryId,
  readJsonNoFollow,
} from './accountBindings.ts';

const MAX_BYTES = 1024 * 1024;
const TOP_KEYS = [
  'schemaVersion', 'channel', 'accountRef', 'repositoryId', 'updatedAtMs',
  'boundary', 'lastRunAtMs', 'degraded', 'diagnostics',
];
const BOUNDARY_KEYS = ['createdAt', 'issueId'];
const DIAGNOSTIC_KEYS = [
  'initialBaseline', 'baselineTruncated', 'boundaryReached', 'exhausted',
  'limitReached', 'pages', 'rows', 'issues', 'pullRequests', 'appended',
  'duplicates', 'archiveHeadBefore', 'archiveHead',
];
const DEGRADED = new Set([null, 'reconcile_truncated', 'reconcile_boundary_missing']);
const ISO_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

// Точка, до которой сверка дошла: время создания issue и его id. Одного времени
// мало — несколько issues одной секунды иначе перепрыгивались бы через одну.
export interface ReconcileBoundary {
  createdAt: string;
  issueId: string;
}

export interface ReconcileDiagnostics {
  initialBaseline: boolean;
  baselineTruncated: boolean;
  boundaryReached: boolean | null;
  exhausted: boolean;
  limitReached: boolean;
  pages: number;
  rows: number;
  issues: number;
  pullRequests: number;
  appended: number;
  duplicates: number;
  archiveHeadBefore: number;
  archiveHead: number;
}

export type ReconcileDegraded = null | 'reconcile_truncated' | 'reconcile_boundary_missing';

export interface GitHubIngressState {
  schemaVersion: 1;
  channel: 'github';
  accountRef: string;
  repositoryId: string;
  updatedAtMs: number | null;
  boundary: ReconcileBoundary | null;
  lastRunAtMs: number | null;
  degraded: ReconcileDegraded;
  diagnostics: ReconcileDiagnostics | null;
}

export interface GitHubIngressStateOptions {
  file?: string;
  accountRef?: unknown;
  repositoryId?: unknown;
  now?: () => number;
}

type Payload = Record<string, unknown>;

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (code: string, message: string, cause?: unknown) => never = (
  code,
  message,
  cause = null,
) => {
  throw new GitHubStoreError(code, message, cause);
};

const isPlainObject = (value: unknown): value is Payload => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function exact(value: unknown, keys: string[], where: string): void {
  if (!isPlainObject(value)) fail('github_ingress_state_invalid', `${where}: ожидался объект.`);
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (own.length !== expected.length || own.some((key, index) => key !== expected[index])) {
    fail('github_ingress_state_invalid', `${where}: поля не совпадают со schema v1.`);
  }
}

function timestamp(
  value: unknown,
  where: string,
  { nullable = false }: { nullable?: boolean } = {},
): number {
  if (nullable && value === null) return null as unknown as number;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail('github_ingress_state_invalid', `${where}: ожидались положительные Unix milliseconds.`);
  }
  return value;
}

function boundary(raw: unknown): ReconcileBoundary | null {
  if (raw === null) return null;
  exact(raw, BOUNDARY_KEYS, 'boundary');
  const value = raw as Payload;
  if (typeof value.createdAt !== 'string' || !ISO_SECONDS_RE.test(value.createdAt)
      || new Date(value.createdAt).toISOString() !== value.createdAt.replace('Z', '.000Z')) {
    fail('github_ingress_state_invalid', 'boundary.createdAt должен быть точным UTC timestamp GitHub.');
  }
  if (typeof value.issueId !== 'string' || !/^[1-9]\d*$/u.test(value.issueId)) {
    fail('github_ingress_state_invalid', 'boundary.issueId должен быть canonical decimal string.');
  }

  return { createdAt: value.createdAt, issueId: value.issueId };
}

function counter(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('github_ingress_state_invalid', `${where}: ожидалось неотрицательное целое.`);
  }
  return value;
}

function diagnostics(raw: unknown): ReconcileDiagnostics | null {
  if (raw === null) return null;
  exact(raw, DIAGNOSTIC_KEYS, 'diagnostics');
  const value = raw as Payload;
  for (const key of ['initialBaseline', 'baselineTruncated', 'exhausted', 'limitReached']) {
    if (typeof value[key] !== 'boolean') {
      fail('github_ingress_state_invalid', `diagnostics.${key}: ожидался boolean.`);
    }
  }
  if (value.boundaryReached !== null && typeof value.boundaryReached !== 'boolean') {
    fail('github_ingress_state_invalid', 'diagnostics.boundaryReached: ожидался boolean|null.');
  }
  const numeric = [
    'pages', 'rows', 'issues', 'pullRequests', 'appended', 'duplicates',
    'archiveHeadBefore', 'archiveHead',
  ];
  const normalized: Payload = { ...value };
  for (const key of numeric) normalized[key] = counter(value[key], `diagnostics.${key}`);

  return normalized as unknown as ReconcileDiagnostics;
}

function validate(
  source: unknown,
  { accountRef, repositoryId }: { accountRef: string; repositoryId: string },
): GitHubIngressState {
  exact(source, TOP_KEYS, 'GitHub ingress state');
  const raw = source as Payload;
  if (raw.schemaVersion !== 1 || raw.channel !== 'github'
      || raw.accountRef !== accountRef
      || normalizeGitHubRepositoryId(raw.repositoryId) !== repositoryId) {
    fail('github_ingress_state_owner_mismatch', 'GitHub ingress state принадлежит другому account owner.');
  }
  if (!DEGRADED.has(raw.degraded as ReconcileDegraded)) {
    fail('github_ingress_state_invalid', 'GitHub ingress state содержит неизвестную degradation reason.');
  }
  const lastRunAtMs = timestamp(raw.lastRunAtMs, 'lastRunAtMs', { nullable: true });
  const parsedDiagnostics = diagnostics(raw.diagnostics);
  if ((lastRunAtMs === null) !== (parsedDiagnostics === null)) {
    fail('github_ingress_state_invalid', 'lastRunAtMs и diagnostics должны отсутствовать вместе.');
  }
  return {
    schemaVersion: 1,
    channel: 'github',
    accountRef,
    repositoryId,
    updatedAtMs: timestamp(raw.updatedAtMs, 'updatedAtMs'),
    boundary: boundary(raw.boundary),
    lastRunAtMs,
    degraded: raw.degraded as ReconcileDegraded,
    diagnostics: parsedDiagnostics,
  };
}

const clone = <Value>(value: Value): Value => structuredClone(value);

export class GitHubIngressStateStore {
  accountRef!: string;

  repositoryId: string;

  file: string;

  now: () => number;

  queue: Promise<unknown>;

  constructor({ file, accountRef, repositoryId, now = Date.now }: GitHubIngressStateOptions = {}) {
    if (typeof file !== 'string' || !file) throw new TypeError('GitHubIngressStateStore: file обязателен.');
    try { this.accountRef = assertAccountRef(accountRef) as string; } catch (err) {
      fail('github_ingress_state_owner_mismatch', 'GitHubIngressStateStore получил неверный accountRef.', err);
    }
    this.repositoryId = normalizeGitHubRepositoryId(repositoryId);
    this.file = file;
    this.now = now;
    this.queue = Promise.resolve();
  }

  _enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  _empty(): GitHubIngressState {
    return {
      schemaVersion: 1,
      channel: 'github',
      accountRef: this.accountRef,
      repositoryId: this.repositoryId,
      updatedAtMs: null,
      boundary: null,
      lastRunAtMs: null,
      degraded: null,
      diagnostics: null,
    };
  }

  async _read(): Promise<GitHubIngressState> {
    const snapshot = await readJsonNoFollow(this.file, { missing: null, maxBytes: MAX_BYTES });
    return snapshot ? validate(snapshot.data, {
      accountRef: this.accountRef,
      repositoryId: this.repositoryId,
    }) : this._empty();
  }

  async read(): Promise<GitHubIngressState> {
    return clone(await this._read());
  }

  async record(result: unknown): Promise<GitHubIngressState> {
    if (!isPlainObject(result)) {
      fail('github_ingress_state_invalid', 'Reconciliation result должен быть объектом.');
    }
    return this._enqueue(async () => {
      const current = await this._read();
      const nowMs = this.now();
      timestamp(nowMs, 'nowMs');
      const next = validate({
        schemaVersion: 1,
        channel: 'github',
        accountRef: this.accountRef,
        repositoryId: this.repositoryId,
        updatedAtMs: nowMs,
        boundary: result.boundary ?? null,
        lastRunAtMs: nowMs,
        degraded: result.degraded ?? null,
        diagnostics: result.diagnostics ?? null,
      }, { accountRef: this.accountRef, repositoryId: this.repositoryId });
      // A degraded/truncated pass is allowed to persist diagnostics, but the
      // reconciler contract must have retained the previous exact boundary.
      if (next.degraded !== null
          && JSON.stringify(next.boundary) !== JSON.stringify(current.boundary)) {
        fail('github_ingress_state_cursor_unsafe', 'Degraded reconciliation попыталась продвинуть boundary.');
      }
      await atomicWriteJson(this.file, next, { mode: 0o600 });
      return clone(next);
    });
  }
}
