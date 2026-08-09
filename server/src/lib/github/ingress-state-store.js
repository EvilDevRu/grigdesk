// Durable REST reconciliation cursor одного GitHub account namespace.
// Activation epochs живут отдельно в InboxStateStore; этот файл отвечает только
// за transport recovery и никогда не становится границей доступа Inbox.
import { assertAccountRef } from '../inbox/identity.js';
import {
  GitHubStoreError,
  atomicWriteJson,
  normalizeGitHubRepositoryId,
  readJsonNoFollow,
} from './account-bindings.js';

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

const fail = (code, message, cause = null) => {
  throw new GitHubStoreError(code, message, cause);
};

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function exact(value, keys, where) {
  if (!isPlainObject(value)) fail('github_ingress_state_invalid', `${where}: ожидался объект.`);
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (own.length !== expected.length || own.some((key, index) => key !== expected[index])) {
    fail('github_ingress_state_invalid', `${where}: поля не совпадают со schema v1.`);
  }
}

function timestamp(value, where, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('github_ingress_state_invalid', `${where}: ожидались положительные Unix milliseconds.`);
  }
  return value;
}

function boundary(value) {
  if (value === null) return null;
  exact(value, BOUNDARY_KEYS, 'boundary');
  if (typeof value.createdAt !== 'string' || !ISO_SECONDS_RE.test(value.createdAt)
      || new Date(value.createdAt).toISOString() !== value.createdAt.replace('Z', '.000Z')) {
    fail('github_ingress_state_invalid', 'boundary.createdAt должен быть точным UTC timestamp GitHub.');
  }
  if (typeof value.issueId !== 'string' || !/^[1-9]\d*$/u.test(value.issueId)) {
    fail('github_ingress_state_invalid', 'boundary.issueId должен быть canonical decimal string.');
  }
  return { createdAt: value.createdAt, issueId: value.issueId };
}

function counter(value, where) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('github_ingress_state_invalid', `${where}: ожидалось неотрицательное целое.`);
  }
  return value;
}

function diagnostics(value) {
  if (value === null) return null;
  exact(value, DIAGNOSTIC_KEYS, 'diagnostics');
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
  const normalized = { ...value };
  for (const key of numeric) normalized[key] = counter(value[key], `diagnostics.${key}`);
  return normalized;
}

function validate(raw, { accountRef, repositoryId }) {
  exact(raw, TOP_KEYS, 'GitHub ingress state');
  if (raw.schemaVersion !== 1 || raw.channel !== 'github'
      || raw.accountRef !== accountRef
      || normalizeGitHubRepositoryId(raw.repositoryId) !== repositoryId) {
    fail('github_ingress_state_owner_mismatch', 'GitHub ingress state принадлежит другому account owner.');
  }
  if (!DEGRADED.has(raw.degraded)) {
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
    degraded: raw.degraded,
    diagnostics: parsedDiagnostics,
  };
}

const clone = (value) => structuredClone(value);

export class GitHubIngressStateStore {
  constructor({ file, accountRef, repositoryId, now = Date.now } = {}) {
    if (typeof file !== 'string' || !file) throw new TypeError('GitHubIngressStateStore: file обязателен.');
    try { this.accountRef = assertAccountRef(accountRef); } catch (err) {
      fail('github_ingress_state_owner_mismatch', 'GitHubIngressStateStore получил неверный accountRef.', err);
    }
    this.repositoryId = normalizeGitHubRepositoryId(repositoryId);
    this.file = file;
    this.now = now;
    this.queue = Promise.resolve();
  }

  _enqueue(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  _empty() {
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

  async _read() {
    const snapshot = await readJsonNoFollow(this.file, { missing: null, maxBytes: MAX_BYTES });
    return snapshot ? validate(snapshot.data, {
      accountRef: this.accountRef,
      repositoryId: this.repositoryId,
    }) : this._empty();
  }

  async read() {
    return clone(await this._read());
  }

  async record(result) {
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
